import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { AuthService } from '../auth/auth.service';
import { PushNotificationService, PushMessage } from '../supabase/push-notification.service';
import { TelegramSignalService } from './telegram-signal.service';
import { StockityWebSocketClient } from '../schedule/websocket-client';
import { AISignalMonitorService } from './ai-signal-monitor.service';
import { v4 as uuidv4 } from 'uuid';
import {
  AISignalOrderStatus,
  TelegramSignal,
  AISignalOrder,
  AlwaysSignalLossState,
  MartingaleSequenceInfo,
  AISignalConfig,
  EXECUTION_CHECK_INTERVAL_MS,
  EXECUTION_ADVANCE_MS,
} from './types';

/** Jumlah max completed orders di pendingOrders sebelum cleanup */
const MAX_COMPLETED_ORDERS = 50;

/**
 * Grace period: order yang execution-time-nya sudah lewat lebih dari ini
 * dianggap basi (stale) dan di-skip otomatis.
 * Mencegah order 14:35:00 masih dieksekusi pada 14:35:30 karena WS down.
 */
const ORDER_EXECUTION_GRACE_MS = 15_000;

/**
 * Jika activeMartingaleOrders entry tidak di-update lebih dari ini,
 * artinya monitor timed-out tanpa mengirim hasil → orphan → hapus.
 * Mencegah bot freeze selamanya karena activeMartingaleOrders.size > 0.
 */
const MARTINGALE_TRACKING_TIMEOUT_MS = 3 * 60_000;

interface SessionStats {
  totalTrades: number;
  wins: number;
  losses: number;
  sessionPnL: number;
}

interface ActiveMode {
  isActive: boolean;
  wsClient: StockityWebSocketClient;
  pendingOrders: AISignalOrder[];
  executedOrdersMap: Map<string, AISignalOrder>;
  activeMartingaleOrders: Map<string, MartingaleSequenceInfo>;
  alwaysSignalLossTracking: AlwaysSignalLossState | null;
  executionInterval?: NodeJS.Timeout;
  processedOrderIds: Set<string>;
  /**
   * FIX race condition: guard re-entrant executeOrder.
   *
   * setInterval dengan async callback: interval baru bisa fire sebelum
   * tick sebelumnya selesai (placeTrade bisa menunggu 5s).
   * Tanpa guard ini, order yang sama bisa di-place 2× → double trade.
   *
   * Pola identik dengan schedule-executor.ts: executingOrderIds Set.
   */
  executingOrderIds: Set<string>;
  session: any;
  config: AISignalConfig;
  stats: SessionStats;
}

@Injectable()
export class AISignalService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AISignalService.name);
  private configs = new Map<string, AISignalConfig>();
  private activeModes = new Map<string, ActiveMode>();

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly authService: AuthService,
    private readonly pushNotification: PushNotificationService,
    private readonly aiSignalMonitor: AISignalMonitorService,
    private readonly telegramSignalService: TelegramSignalService,
  ) {}

  async onModuleInit() {
    try {
      const { data: staleRows, error } = await this.supabaseService.client
        .from('aisignal_status')
        .select('user_id')
        .eq('bot_state', 'RUNNING');

      if (!error && staleRows?.length) {
        const userIds = (staleRows as any[]).map((r) => r.user_id);
        await this.supabaseService.client
          .from('aisignal_status')
          .update({ bot_state: 'STOPPED', updated_at: this.supabaseService.now() })
          .in('user_id', userIds);
        this.logger.warn(
          `[Startup] Reset ${userIds.length} stale RUNNING AI Signal status(es) → STOPPED`,
        );
      }
    } catch (err: any) {
      this.logger.error(`[Startup] Failed to clear stale statuses: ${err?.message}`);
    }
  }

  /**
   * FIX keandalan: async onModuleDestroy + Promise.allSettled.
   *
   * Sebelumnya: synchronous for-loop → stopAISignalMode (async) tidak di-await
   * → updateStatus('STOPPED') tidak pernah selesai saat process exit
   * → DB masih RUNNING → onModuleInit harus fix lagi di boot berikutnya.
   */
  async onModuleDestroy() {
    const stops = Array.from(this.activeModes.keys()).map((userId) =>
      this.stopAISignalMode(userId).catch((e) =>
        this.logger.error(`[onDestroy] Failed to stop ${userId}: ${e.message}`),
      ),
    );
    await Promise.allSettled(stops);
  }

  // ==================== CONFIG ====================

  async getConfig(userId: string): Promise<AISignalConfig> {
    if (this.configs.has(userId)) return this.configs.get(userId)!;

    const { data: doc, error } = await this.supabaseService.client
      .from('aisignal_configs')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (doc && !error) {
      const d = doc as any;
      const cfg: AISignalConfig = {
        asset:     d.asset ?? null,
        baseAmount: d.baseAmount ?? 1_400_000,
        martingale: d.martingale ?? {
          isEnabled:       true,
          maxSteps:        2,
          multiplierValue: 2.5,
          multiplierType:  'FIXED',
          isAlwaysSignal:  false,
        },
        isDemoAccount: d.isDemoAccount ?? true,
        currency:      d.currency ?? 'IDR',
      };
      this.configs.set(userId, cfg);
      return cfg;
    }

    const def: AISignalConfig = {
      asset:     null,
      baseAmount: 1_400_000,
      martingale: {
        isEnabled:       true,
        maxSteps:        2,
        multiplierValue: 2.5,
        multiplierType:  'FIXED',
        isAlwaysSignal:  false,
      },
      isDemoAccount: true,
      currency:      'IDR',
    };
    this.configs.set(userId, def);
    return def;
  }

  /**
   * FIX sesi 1: sync mode.config jika mode sedang aktif.
   * Sebelumnya: updateConfig hanya update this.configs, mode yang berjalan
   * tetap pakai snapshot config lama dari saat startAISignalMode().
   */
  async updateConfig(userId: string, dto: Partial<AISignalConfig>): Promise<AISignalConfig> {
    const current  = await this.getConfig(userId);
    const updated  = { ...current, ...dto };
    this.configs.set(userId, updated);

    const mode = this.activeModes.get(userId);
    if (mode?.isActive) {
      mode.config = updated;
      this.logger.log(`[${userId}] Live config synced to running mode`);
    }

    const plain = JSON.parse(JSON.stringify(updated));
    await this.supabaseService.client
      .from('aisignal_configs')
      .upsert({ user_id: userId, ...plain, updated_at: this.supabaseService.now() });

    return updated;
  }

  // ==================== AI SIGNAL MODE CONTROL ====================

  async startAISignalMode(userId: string): Promise<{ message: string; status: string }> {
    const existing = this.activeModes.get(userId);
    if (existing?.isActive) {
      return { message: 'AI Signal mode sudah berjalan', status: 'RUNNING' };
    }

    const session = await this.authService.getSession(userId);
    if (!session) throw new Error('Session tidak ditemukan');

    const config = await this.getConfig(userId);
    if (!config.asset?.ric) throw new Error('Asset belum dikonfigurasi');

    const ws = new StockityWebSocketClient(
      userId,
      session.stockity_token,
      session.device_id,
      session.device_type ?? 'web',
      session.user_agent,
    );

    try {
      await ws.connect();
    } catch (err: any) {
      ws.disconnect();
      throw new Error(`Gagal koneksi WebSocket: ${err?.message ?? err}`);
    }

    this.activeModes.set(userId, {
      isActive:                true,
      wsClient:                ws,
      pendingOrders:           [],
      executedOrdersMap:       new Map(),
      activeMartingaleOrders:  new Map(),
      alwaysSignalLossTracking: null,
      processedOrderIds:       new Set(),
      executingOrderIds:       new Set(),
      session,
      config,
      stats: { totalTrades: 0, wins: 0, losses: 0, sessionPnL: 0 },
    });

    this.telegramSignalService.setSignalCallback(userId, (uid, signal) => {
      this.handleIncomingSignal(uid, signal);
    });

    await this.telegramSignalService.startListening(userId);
    this.aiSignalMonitor.setUserSession(userId, session);

    /**
     * FIX keandalan: handle WS permanent death.
     *
     * Sebelumnya: onStatusChange hanya di-log.
     * Jika WS gagal reconnect 10×, bot tetap "RUNNING" di UI tapi tidak bisa
     * trade sama sekali. User tidak tahu sampai cek manual.
     *
     * Sekarang: handleWebSocketDead() otomatis stop mode + update DB.
     */
    ws.setOnStatusChange((connected, reason) => {
      this.logger.log(
        `[${userId}] WS: ${connected ? 'connected' : 'disconnected'} — ${reason ?? ''}`,
      );
      if (!connected && reason === 'Max reconnect attempts reached') {
        this.handleWebSocketDead(userId);
      }
    });

    this.aiSignalMonitor.startMonitoring(userId, ws, (result) => {
      this.handleMonitorTradeResult(userId, result);
    });

    this.startExecutionMonitoring(userId);
    await this.updateStatus(userId, 'RUNNING');
    this.logger.log(`[${userId}] AI Signal mode started`);

    return { message: 'AI Signal mode dimulai', status: 'RUNNING' };
  }

  async stopAISignalMode(userId: string): Promise<{ message: string }> {
    const mode = this.activeModes.get(userId);
    if (!mode?.isActive) {
      await this.updateStatus(userId, 'STOPPED');
      return { message: 'AI Signal mode tidak berjalan' };
    }

    mode.isActive = false;
    if (mode.executionInterval) clearInterval(mode.executionInterval);

    this.telegramSignalService.stopListening(userId);
    this.aiSignalMonitor.stopMonitoring(userId);
    mode.wsClient.disconnect();
    this.activeModes.delete(userId);

    await this.updateStatus(userId, 'STOPPED');
    this.logger.log(`[${userId}] AI Signal mode stopped`);

    return { message: 'AI Signal mode dihentikan' };
  }

  /**
   * FIX keandalan: handle WS yang tidak bisa reconnect lagi.
   *
   * Dipanggil oleh setOnStatusChange callback ketika reason =
   * "Max reconnect attempts reached". Otomatis stop mode dan update DB.
   */
  private handleWebSocketDead(userId: string): void {
    const mode = this.activeModes.get(userId);
    if (!mode?.isActive) return;

    this.logger.error(`[${userId}] ❌ WS permanently dead — stopping AI Signal mode`);

    mode.isActive = false;
    if (mode.executionInterval) clearInterval(mode.executionInterval);

    this.telegramSignalService.stopListening(userId);
    this.aiSignalMonitor.stopMonitoring(userId);
    this.activeModes.delete(userId);

    this.updateStatus(userId, 'STOPPED').catch((e) =>
      this.logger.error(`[${userId}] Failed to write STOPPED on WS death: ${e.message}`),
    );
  }

  async getStatus(userId: string): Promise<object> {
    const mode   = this.activeModes.get(userId);
    const config = await this.getConfig(userId);

    if (mode) {
      const pendingCount  = mode.pendingOrders.filter((o) => !o.isExecuted).length;
      const executedCount = mode.pendingOrders.filter((o) =>  o.isExecuted).length;
      return {
        isActive:                  mode.isActive,
        botState:                  'RUNNING',
        totalOrders:               mode.pendingOrders.length,
        pendingOrders:             pendingCount,
        executedOrders:            executedCount,
        activeMartingaleSequences: mode.activeMartingaleOrders.size,
        wsConnected:               mode.wsClient.isConnected(),
        alwaysSignalStatus:        this.getAlwaysSignalStatus(mode, config),
        monitoringStatus:          this.aiSignalMonitor.getMonitoringStatus(userId),
        telegramSignalStatus:      this.telegramSignalService.getStatus(userId),
        stats:                     mode.stats,
        sessionPnL:                mode.stats.sessionPnL,
        totalWins:                 mode.stats.wins,
        totalLosses:               mode.stats.losses,
        totalTrades:               mode.stats.totalTrades,
        config,
      };
    }

    const { data: statusDoc, error: statusError } = await this.supabaseService.client
      .from('aisignal_status').select('*').eq('user_id', userId).single();
    if (!statusError && statusDoc?.bot_state === 'RUNNING') {
      await this.updateStatus(userId, 'STOPPED');
      this.logger.warn(`[${userId}] Stale RUNNING status auto-reset to STOPPED`);
    }
    return { isActive: false, botState: 'STOPPED', config };
  }

  private getAlwaysSignalStatus(mode: ActiveMode, config: AISignalConfig): object {
    const lossState = mode.alwaysSignalLossTracking;
    if (!config.martingale.isAlwaysSignal || !lossState?.hasOutstandingLoss) {
      return { isActive: false, status: 'No outstanding loss' };
    }
    return {
      isActive:     true,
      currentStep:  lossState.currentMartingaleStep,
      maxSteps:     config.martingale.maxSteps,
      totalLoss:    lossState.totalLoss,
      status:       `Waiting next signal (Step ${lossState.currentMartingaleStep}/${config.martingale.maxSteps})`,
    };
  }

  // ==================== SIGNAL HANDLING ====================

  private async handleIncomingSignal(userId: string, signal: TelegramSignal): Promise<void> {
    try {
      this.logger.log(
        `[${userId}] Signal: ${signal.trend} at ${new Date(signal.executionTime).toISOString()}`,
      );
      await this.receiveSignal(userId, {
        trend:           signal.trend,
        executionTime:   signal.executionTime,
        originalMessage: signal.originalMessage,
      });
    } catch (error) {
      this.logger.error(`[${userId}] Error handling signal: ${(error as Error).message}`);
    }
  }

  /**
   * FIX sesi 1: gunakan mode.config dan mode.session langsung (in-memory),
   * bukan fetch ulang getConfig + authService.getSession setiap sinyal.
   */
  async receiveSignal(
    userId: string,
    signalData: { trend: string; executionTime?: number; originalMessage?: string },
  ): Promise<{ message: string }> {
    const mode = this.activeModes.get(userId);
    if (!mode?.isActive) throw new Error('AI Signal mode tidak aktif');

    const config  = mode.config;   // FIX: in-memory, tidak fetch ulang
    const session = mode.session;  // FIX: in-memory

    const signal: TelegramSignal = {
      trend:
        ['buy', 'call'].includes(signalData.trend.toLowerCase()) ? 'call' : 'put',
      executionTime:   signalData.executionTime ?? Date.now() + 5000,
      receivedAt:      Date.now(),
      originalMessage: signalData.originalMessage ?? `AI Signal: ${signalData.trend}`,
    };

    if (!config.martingale.isAlwaysSignal) {
      const hasActiveOrder = mode.pendingOrders.some(
        (o) =>
          o.isExecuted &&
          (o.status === AISignalOrderStatus.EXECUTING ||
           o.status === AISignalOrderStatus.MONITORING),
      );
      if (hasActiveOrder || mode.activeMartingaleOrders.size > 0) {
        this.logger.log(`[${userId}] Signal skipped — order in progress`);
        return { message: 'Signal skipped - Order in progress' };
      }
    }

    if (config.martingale.isAlwaysSignal && mode.alwaysSignalLossTracking?.hasOutstandingLoss) {
      return this.handleAlwaysSignalMartingale(userId, config);
    }

    const order: AISignalOrder = {
      id:                uuidv4(),
      assetRic:          config.asset!.ric,
      assetName:         config.asset!.name,
      trend:             signal.trend,
      amount:            config.baseAmount,
      executionTime:     signal.executionTime,
      receivedAt:        signal.receivedAt,
      originalMessage:   signal.originalMessage,
      isExecuted:        false,
      status:            AISignalOrderStatus.PENDING,
      martingaleStep:    0,
      maxMartingaleSteps: config.martingale.maxSteps,
    };

    mode.pendingOrders.push(order);
    mode.pendingOrders.sort((a, b) => a.executionTime - b.executionTime);

    this.logger.log(
      `[${userId}] New order queued: ${signal.trend} at ` +
      `${new Date(signal.executionTime).toISOString()}`,
    );

    await this.sendSignalToFCM(userId, signal, order);
    return { message: `Signal received: ${signal.trend.toUpperCase()}` };
  }

  private async sendSignalToFCM(
    userId: string,
    signal: TelegramSignal,
    order: AISignalOrder,
  ): Promise<void> {
    try {
      const d      = new Date(signal.executionTime);
      const hour   = d.getHours();
      const minute = d.getMinutes();
      const second = d.getSeconds();
      const topic  = `trading_signals_${userId}`;

      const message: PushMessage = {
        topic,
        data: {
          type: 'TRADING_SIGNAL',
          trend: signal.trend,
          has_time: 'true',
          hour: hour.toString(), minute: minute.toString(), second: second.toString(),
          original_message: signal.originalMessage,
          timestamp: signal.receivedAt.toString(),
          user_id:  userId,
          order_id: order.id,
        },
        notification: {
          title: '🎯 New Trading Signal',
          body:  `${signal.trend.toUpperCase()}: ${signal.originalMessage} (${hour}:${minute}:${second})`,
        },
        android: {
          priority: 'high' as const,
          notification: { channelId: 'trading_signals', priority: 'high' as const, sound: 'default' },
        },
      };

      await this.pushNotification.send(message);
      this.logger.log(`[${userId}] FCM sent to topic '${topic}'`);
    } catch (err: any) {
      this.logger.debug(`[${userId}] FCM send skipped: ${err?.message ?? err}`);
    }
  }

  /**
   * FIX sesi 1: parameter `session` dihapus karena tidak dipakai.
   * FIX sesi 1: martingaleStep = 0 agar monitor-routing benar.
   */
  private async handleAlwaysSignalMartingale(
    userId: string,
    config: AISignalConfig,
  ): Promise<{ message: string }> {
    const mode = this.activeModes.get(userId);
    if (!mode) return { message: 'Mode not active' };

    const lossState = mode.alwaysSignalLossTracking!;
    const nextStep  = lossState.currentMartingaleStep + 1;

    if (nextStep > config.martingale.maxSteps) {
      mode.alwaysSignalLossTracking = null;
      this.logger.log(`[${userId}] Always Signal: max steps reached — RESET`);
      return { message: 'Max steps reached - Resetting' };
    }

    const nextAmount = this.calculateMartingaleAmount(config, nextStep);

    const order: AISignalOrder = {
      id:                uuidv4(),
      assetRic:          config.asset!.ric,
      assetName:         config.asset!.name,
      trend:             lossState.currentTrend,
      amount:            nextAmount,
      executionTime:     Date.now() + 5000,
      receivedAt:        Date.now(),
      originalMessage:   `Martingale Step ${nextStep}`,
      isExecuted:        false,
      status:            AISignalOrderStatus.MARTINGALE_STEP,
      martingaleStep:    0,   // treat as initial order untuk monitor-result routing
      maxMartingaleSteps: config.martingale.maxSteps,
    };

    mode.pendingOrders.push(order);
    mode.pendingOrders.sort((a, b) => a.executionTime - b.executionTime);

    mode.alwaysSignalLossTracking = { ...lossState, currentMartingaleStep: nextStep };

    this.logger.log(`[${userId}] Always Signal step ${nextStep}: ${nextAmount}`);
    return { message: `Martingale Step ${nextStep}/${config.martingale.maxSteps}` };
  }

  // ==================== EXECUTION MONITORING ====================

  private startExecutionMonitoring(userId: string) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    mode.executionInterval = setInterval(async () => {
      if (!mode.isActive) {
        clearInterval(mode.executionInterval!);
        return;
      }
      try {
        await this.checkAndExecutePendingOrders(userId);
      } catch (err: any) {
        this.logger.error(`[${userId}] Execution error: ${err?.message ?? err}`);
      }
    }, EXECUTION_CHECK_INTERVAL_MS);

    this.logger.log(
      `[${userId}] Execution monitoring started (${EXECUTION_CHECK_INTERVAL_MS}ms)`,
    );
  }

  /**
   * FIX keandalan (stale orders): order yang execution-time-nya sudah lewat
   * lebih dari ORDER_EXECUTION_GRACE_MS di-skip otomatis.
   *
   * Sebelumnya: order terus di-retry setiap 100ms tanpa batas waktu.
   * Jika WS down 30 detik, sinyal 14:35:00 bisa ter-eksekusi jam 14:35:30.
   * Untuk time-sensitive signal itu sudah tidak valid.
   *
   * FIX keandalan (orphan martingale): periodic cleanup stale tracking entries.
   * Jika monitor timeout (90s) tanpa mengirim hasil, activeMartingaleOrders
   * tidak pernah di-clear → bot freeze (receiveSignal selalu "in progress").
   */
  private async checkAndExecutePendingOrders(userId: string) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    const now = Date.now();
    const ordersToExecute: AISignalOrder[] = [];

    for (const order of mode.pendingOrders) {
      if (order.isExecuted) continue;

      const isReady = now >= order.executionTime - EXECUTION_ADVANCE_MS;
      const isStale = now > order.executionTime + ORDER_EXECUTION_GRACE_MS;

      if (isReady && !isStale) {
        ordersToExecute.push(order);
      } else if (isStale) {
        // Auto-skip: execution window terlewat
        this.logger.warn(
          `[${userId}] Order ${order.id} SKIPPED — ` +
          `stale by ${now - order.executionTime}ms`,
        );
        order.isExecuted = true;
        order.status     = AISignalOrderStatus.COMPLETED;
        mode.executedOrdersMap.set(order.id, order);
        // Bersihkan martingale tracking jika ada
        mode.activeMartingaleOrders.delete(order.id);
      }
    }

    for (const order of ordersToExecute) {
      await this.executeOrder(userId, order);
    }

    // Periodic cleanup: hapus orphan martingale tracking
    this.cleanupStaleMartingaleTracking(userId);
  }

  /**
   * FIX keandalan: executingOrderIds guard mencegah double-execution.
   *
   * Masalah: setInterval dengan async callback tidak menunggu tick sebelumnya
   * selesai. placeTrade bisa menunggu 5 detik (timeout). Selama 5 detik itu,
   * 50 interval tick bisa fire dan semuanya menemukan order yang sama
   * (isExecuted=false) karena flagging belum selesai di tick pertama.
   *
   * Solusi: executingOrderIds Set sebagai mutex per order-id, identik dengan
   * pola di schedule-executor.ts (executingOrderIds). Cek dilakukan SEBELUM
   * await placeTrade, sehingga tick konkuren langsung return.
   *
   * FIX keandalan: mutate order object langsung (bukan spread baru) sehingga
   * semua referensi ke order di pendingOrders array langsung melihat
   * isExecuted=true tanpa menunggu findIndex.
   *
   * FIX performa: cek isConnected() sebelum mencoba placeTrade.
   * Jika WS sedang reconnect, langsung skip — jangan tunggu 5s timeout.
   */
  private async executeOrder(userId: string, order: AISignalOrder) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    // Guard re-entrant: blokir jika order yang sama sedang dalam proses
    if (mode.executingOrderIds.has(order.id)) {
      this.logger.warn(`[${userId}] ⚠️ executeOrder re-entry blocked: ${order.id}`);
      return;
    }

    // Baca state terkini dari array (bukan dari snapshot yang difilter sebelumnya)
    const currentOrder = mode.pendingOrders.find((o) => o.id === order.id);
    if (!currentOrder || currentOrder.isExecuted) return;

    // FIX performa: cek WS sebelum mencoba trade
    if (!mode.wsClient.isConnected()) {
      this.logger.warn(`[${userId}] WS not connected — skipping execution for ${order.id}`);
      return;
    }

    // Tandai sebagai executing SEBELUM await (mutate langsung, bukan spread)
    mode.executingOrderIds.add(order.id);
    currentOrder.isExecuted = true;
    currentOrder.status     = AISignalOrderStatus.EXECUTING;
    mode.executedOrdersMap.set(order.id, currentOrder);

    this.logger.log(`[${userId}] Executing: ${order.trend} — ${order.amount}`);

    try {
      const isScheduled = order.martingaleStep === 0;
      const result = await mode.wsClient.placeTrade(
        this.buildTradePayload(
          mode.session, mode.config, order.amount, order.trend,
          isScheduled, isScheduled ? order.executionTime : undefined,
        ),
      );

      if (!result.dealId) {
        this.logger.error(`[${userId}] Trade failed: ${result.error}`);
        currentOrder.isExecuted = false;
        currentOrder.status     = AISignalOrderStatus.WAITING;
        return;
      }

      this.logger.log(`[${userId}] ✅ Trade placed: ${result.dealId}`);

    } catch (error) {
      this.logger.error(`[${userId}] Place trade error: ${(error as Error).message}`);
      currentOrder.isExecuted = false;
      currentOrder.status     = AISignalOrderStatus.WAITING;
      return;
    } finally {
      mode.executingOrderIds.delete(order.id);
    }

    this.aiSignalMonitor.startMonitoringOrder(
      userId,
      order.id,
      order.trend,
      order.amount,
      order.assetRic,
      mode.config.isDemoAccount,
      order.martingaleStep > 0,
      order.martingaleStep,
    );

    setTimeout(() => {
      if (currentOrder.status === AISignalOrderStatus.EXECUTING) {
        currentOrder.status = AISignalOrderStatus.MONITORING;
        mode.executedOrdersMap.set(order.id, currentOrder);
      }
    }, 2000);
  }

  // ==================== TRADE RESULT HANDLING ====================

  private async handleMonitorTradeResult(
    userId: string,
    result: {
      parentOrderId: string;
      monitoringOrderId: string;
      isWin: boolean;
      isMartingale: boolean;
      martingaleStep: number;
      details: Map<string, any>;
    },
  ) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    if (mode.processedOrderIds.has(result.monitoringOrderId)) return;
    mode.processedOrderIds.add(result.monitoringOrderId);

    const order =
      mode.executedOrdersMap.get(result.monitoringOrderId) ??
      mode.executedOrdersMap.get(result.parentOrderId)     ??
      mode.pendingOrders.find((o) => o.id === result.monitoringOrderId) ??
      mode.pendingOrders.find((o) => o.id === result.parentOrderId);

    if (order) {
      order.result = result.isWin ? 'WIN' : 'LOSE';
      order.status = result.isWin ? AISignalOrderStatus.WIN : AISignalOrderStatus.LOSE;
    }

    /**
     * FIX keandalan: sessionPnL menggunakan win_amount aktual dari Stockity.
     *
     * Sebelumnya: hardcode Math.floor(amount * 0.85) — tidak akurat,
     * berbeda tergantung aset dan waktu trading.
     * Sekarang: pakai win_amount dari result.details (disuplai monitor),
     * fallback ke 0.85 hanya jika win_amount tidak tersedia.
     */
    {
      const amount    = order?.amount ?? mode.config.baseAmount;
      const winAmount = (result.details.get('win_amount') as number) ?? 0;
      if (result.isWin) {
        const profit = winAmount > 0 ? winAmount - amount : Math.floor(amount * 0.85);
        mode.stats.sessionPnL += profit;
      } else {
        mode.stats.sessionPnL -= amount;
      }

      const _m          = mode.config.martingale;
      const _midSeqLoss =
        !result.isWin &&
        ((!result.isMartingale && _m.isEnabled && _m.maxSteps > 0) ||
         ( result.isMartingale && result.martingaleStep < _m.maxSteps));

      if (!_midSeqLoss) {
        mode.stats.totalTrades++;
        if (result.isWin) mode.stats.wins++;
        else mode.stats.losses++;
      }
    }

    await this.saveAISignalLog(userId, result, order, mode);

    this.logger.log(
      `[${userId}] Result: ${result.isWin ? 'WIN' : 'LOSE'} ` +
      `(martingale: ${result.isMartingale}, step: ${result.martingaleStep})`,
    );

    if (result.isMartingale) {
      const martingaleInfo = mode.activeMartingaleOrders.get(result.parentOrderId);
      if (martingaleInfo) {
        await this.handleMartingaleResult(
          userId, result.parentOrderId, martingaleInfo, result.isWin,
        );
      } else {
        this.logger.warn(
          `[${userId}] isMartingale=true but no tracking for ${result.parentOrderId} ` +
          `— routing to handleInitialTradeResult`,
        );
        await this.handleInitialTradeResult(userId, result.parentOrderId, result.isWin);
      }
    } else {
      await this.handleInitialTradeResult(userId, result.parentOrderId, result.isWin);
    }

    setTimeout(() => {
      const targetId = result.isMartingale ? result.monitoringOrderId : result.parentOrderId;
      const o        = mode.pendingOrders.find((x) => x.id === targetId);
      if (o) {
        o.status = result.isWin ? AISignalOrderStatus.WIN : AISignalOrderStatus.LOSE;
      }
      // FIX sesi 1: bersihkan completed orders lama
      this.cleanupOldOrders(userId);
    }, 3000);
  }

  private async handleInitialTradeResult(userId: string, orderId: string, isWin: boolean) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    const order =
      mode.executedOrdersMap.get(orderId) ??
      mode.pendingOrders.find((o) => o.id === orderId);

    if (isWin) {
      mode.alwaysSignalLossTracking = null;
    } else if (mode.config.martingale.isEnabled) {
      if (mode.config.martingale.isAlwaysSignal) {
        if (!mode.alwaysSignalLossTracking?.hasOutstandingLoss) {
          mode.alwaysSignalLossTracking = {
            hasOutstandingLoss:     true,
            currentMartingaleStep:  0,
            originalOrderId:        orderId,
            totalLoss:              order?.amount ?? mode.config.baseAmount,
            currentTrend:           order?.trend  ?? 'call',
          };
        }
      } else {
        await this.startMartingale(userId, orderId, order?.trend ?? 'call');
      }
    }
  }

  private async handleMartingaleResult(
    userId: string,
    parentOrderId: string,
    martingaleInfo: MartingaleSequenceInfo,
    isWin: boolean,
  ) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    if (isWin) {
      mode.activeMartingaleOrders.delete(parentOrderId);
      mode.alwaysSignalLossTracking = null;
    } else {
      const nextStep = martingaleInfo.currentStep + 1;

      if (nextStep > mode.config.martingale.maxSteps) {
        mode.activeMartingaleOrders.delete(parentOrderId);
        mode.alwaysSignalLossTracking = null;
        this.logger.log(`[${userId}] Martingale max steps reached`);
      } else {
        const currentAmount = this.calculateMartingaleAmount(
          mode.config, martingaleInfo.currentStep,
        );
        mode.activeMartingaleOrders.set(parentOrderId, {
          ...martingaleInfo,
          currentStep:      nextStep,
          totalLoss:        martingaleInfo.totalLoss + currentAmount,
          lastExecutionTime: Date.now(),
        });

        const nextAmount = this.calculateMartingaleAmount(mode.config, nextStep);
        setTimeout(() => {
          this.executeMartingaleTrade(
            userId, parentOrderId, martingaleInfo.originalTrend, nextAmount, nextStep,
          );
        }, 300);
      }
    }
  }

  private async startMartingale(userId: string, parentOrderId: string, trend: string) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    const nextAmount = this.calculateMartingaleAmount(mode.config, 1);

    mode.activeMartingaleOrders.set(parentOrderId, {
      orderId:           parentOrderId,
      currentStep:       1,
      maxSteps:          mode.config.martingale.maxSteps,
      totalLoss:         mode.config.baseAmount,
      isActive:          true,
      originalTrend:     trend,
      lastExecutionTime: Date.now(),
    });

    await this.executeMartingaleTrade(userId, parentOrderId, trend, nextAmount, 1);
  }

  /**
   * FIX keandalan: async + guard — monitoring hanya dimulai jika trade berhasil.
   * Sebelumnya: fire-and-forget, monitor bisa start meski trade gagal.
   *
   * FIX keandalan: executingOrderIds guard juga berlaku di sini.
   */
  private async executeMartingaleTrade(
    userId: string,
    parentOrderId: string,
    trend: string,
    amount: number,
    step: number,
  ): Promise<void> {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    const martingaleOrderId = `${parentOrderId}_martingale_${step}`;

    // Guard re-entrant
    if (mode.executingOrderIds.has(martingaleOrderId)) {
      this.logger.warn(`[${userId}] Martingale re-entry blocked: ${martingaleOrderId}`);
      return;
    }

    if (!mode.wsClient.isConnected()) {
      this.logger.warn(`[${userId}] WS not connected — skipping martingale ${step}`);
      return;
    }

    const martingaleOrder: AISignalOrder = {
      id:                martingaleOrderId,
      assetRic:          mode.config.asset!.ric,
      assetName:         mode.config.asset!.name,
      trend,
      amount,
      executionTime:     Date.now(),
      receivedAt:        Date.now(),
      originalMessage:   `Martingale Step ${step}`,
      isExecuted:        true,
      status:            AISignalOrderStatus.EXECUTING,
      martingaleStep:    step,
      maxMartingaleSteps: mode.config.martingale.maxSteps,
    };

    mode.pendingOrders.push(martingaleOrder);
    mode.executedOrdersMap.set(martingaleOrderId, martingaleOrder);
    mode.executingOrderIds.add(martingaleOrderId);

    this.logger.log(`[${userId}] Executing martingale step ${step}: ${amount}`);

    try {
      const result = await mode.wsClient.placeTrade(
        this.buildTradePayload(mode.session, mode.config, amount, trend),
      );

      if (!result?.dealId) {
        this.logger.error(`[${userId}] Martingale trade failed: ${result?.error}`);
        martingaleOrder.isExecuted = false;
        martingaleOrder.status     = AISignalOrderStatus.WAITING;
        mode.activeMartingaleOrders.delete(parentOrderId);
        return;
      }

      this.logger.log(`[${userId}] ✅ Martingale trade placed: ${result.dealId}`);

    } catch (error: unknown) {
      this.logger.error(`[${userId}] Martingale error: ${(error as Error).message}`);
      martingaleOrder.isExecuted = false;
      martingaleOrder.status     = AISignalOrderStatus.WAITING;
      mode.activeMartingaleOrders.delete(parentOrderId);
      return;
    } finally {
      mode.executingOrderIds.delete(martingaleOrderId);
    }

    this.aiSignalMonitor.startMonitoringOrder(
      userId, parentOrderId, trend, amount,
      mode.config.asset!.ric, mode.config.isDemoAccount, true, step,
    );

    setTimeout(() => {
      if (martingaleOrder.status === AISignalOrderStatus.EXECUTING) {
        martingaleOrder.status = AISignalOrderStatus.MONITORING;
        mode.executedOrdersMap.set(martingaleOrderId, martingaleOrder);
      }
    }, 2000);
  }

  // ==================== CLEANUP ==========================================

  /**
   * FIX sesi 1: bersihkan completed orders lama dari pendingOrders.
   * Mencegah array tumbuh tak terbatas → filter() di hot path makin lambat.
   */
  private cleanupOldOrders(userId: string): void {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    const TERMINAL = new Set<AISignalOrderStatus>([
      AISignalOrderStatus.WIN,
      AISignalOrderStatus.LOSE,
      AISignalOrderStatus.COMPLETED,
    ]);

    const active    = mode.pendingOrders.filter((o) => !TERMINAL.has(o.status));
    const completed = mode.pendingOrders.filter((o) =>  TERMINAL.has(o.status));

    if (completed.length <= MAX_COMPLETED_ORDERS) return;

    const toKeep   = completed.slice(-MAX_COMPLETED_ORDERS);
    const toRemove = completed.slice(0, completed.length - MAX_COMPLETED_ORDERS);

    mode.pendingOrders = [...active, ...toKeep];
    for (const o of toRemove) {
      mode.executedOrdersMap.delete(o.id);
      mode.processedOrderIds.delete(o.id);
    }

    this.logger.debug(`[${userId}] Trimmed ${toRemove.length} old completed orders`);
  }

  /**
   * FIX keandalan: hapus orphan activeMartingaleOrders entries.
   *
   * Ketika monitor order timeout (90s tanpa hasil), handleMartingaleResult
   * tidak pernah dipanggil → entry di activeMartingaleOrders tidak di-hapus
   * → receiveSignal selalu "in progress" → bot freeze selamanya.
   *
   * Fix: hapus entry yang lastExecutionTime-nya sudah > MARTINGALE_TRACKING_TIMEOUT_MS.
   */
  private cleanupStaleMartingaleTracking(userId: string): void {
    const mode = this.activeModes.get(userId);
    if (!mode || mode.activeMartingaleOrders.size === 0) return;

    const now = Date.now();
    for (const [orderId, info] of mode.activeMartingaleOrders) {
      if (now - info.lastExecutionTime > MARTINGALE_TRACKING_TIMEOUT_MS) {
        mode.activeMartingaleOrders.delete(orderId);
        this.logger.warn(
          `[${userId}] Stale martingale tracking removed: ${orderId} ` +
          `(${Math.round((now - info.lastExecutionTime) / 1000)}s old)`,
        );
      }
    }
  }

  // ==================== HELPERS ==========================

  private calculateMartingaleAmount(config: AISignalConfig, step: number): number {
    const multiplier =
      config.martingale.multiplierType === 'FIXED'
        ? config.martingale.multiplierValue
        : 1 + config.martingale.multiplierValue / 100;
    return Math.floor(config.baseAmount * Math.pow(multiplier, step));
  }

  private buildTradePayload(
    session: any,
    config: AISignalConfig,
    amount: number,
    trend: string,
    isScheduled = true,
    executionTimeMs?: number,
  ): any {
    const baseMs            = isScheduled && executionTimeMs ? executionTimeMs : Date.now();
    const createdAtSeconds  = Math.floor(baseMs / 1000);
    const secondsInMinute   = createdAtSeconds % 60;

    let finalExpireAt: number;

    if (isScheduled) {
      const raw      = createdAtSeconds + (secondsInMinute <= 10 ? 60 - secondsInMinute : 120 - secondsInMinute);
      const duration = raw - createdAtSeconds;
      finalExpireAt  = duration < 55 || duration > 120 ? createdAtSeconds + 60 : raw;
    } else {
      const remaining = 60 - secondsInMinute;
      finalExpireAt   = remaining >= 45 ? createdAtSeconds + remaining : createdAtSeconds + remaining + 60;
    }

    const duration = finalExpireAt - createdAtSeconds;
    if (duration < 45 || duration > 125) finalExpireAt = createdAtSeconds + 60;

    return {
      amount,
      createdAt:  createdAtSeconds * 1000,
      dealType:   config.isDemoAccount ? 'demo' : 'real',
      expireAt:   finalExpireAt,
      iso:        session.currency_iso ?? config.currency ?? 'IDR',
      optionType: 'turbo',
      ric:        config.asset!.ric,
      trend,
    };
  }

  private async saveAISignalLog(
    userId: string,
    result: {
      parentOrderId: string;
      monitoringOrderId: string;
      isWin: boolean;
      isMartingale: boolean;
      martingaleStep: number;
      details: Map<string, any>;
    },
    order: any,
    mode: ActiveMode,
  ): Promise<void> {
    try {
      const detailStatus = (result.details.get('status') as string | undefined)?.toLowerCase();
      const isDraw       = detailStatus === 'equal';
      const tradeResult: 'WIN' | 'LOSE' | 'DRAW' =
        isDraw ? 'DRAW' : result.isWin ? 'WIN' : 'LOSE';

      const amount    = order?.amount ?? mode.config.baseAmount;
      const nowMs     = Date.now();
      const winAmount = (result.details.get('win_amount') as number) ?? 0;

      const profit =
        tradeResult === 'WIN'
          ? winAmount > 0 ? winAmount - amount : Math.floor(amount * 0.85)
          : tradeResult === 'DRAW' ? 0 : -amount;

      const logId =
        result.martingaleStep > 0
          ? `${result.parentOrderId}_s${result.martingaleStep}`
          : result.parentOrderId;

      await this.supabaseService.client.from('mode_logs').upsert({
        id:          logId,
        user_id:     userId,
        mode:        'aisignal',
        data: {
          id:            logId,
          orderId:       result.parentOrderId,
          trend:         order?.trend ?? 'call',
          amount,
          martingaleStep: result.martingaleStep,
          dealId:        result.details.get('trade_id') ?? undefined,
          result:        tradeResult,
          profit,
          sessionPnL:    mode.stats.sessionPnL,
          executedAt:    nowMs,
          isDemoAccount: mode.config.isDemoAccount,
          assetRic:      order?.assetRic  ?? mode.config.asset?.ric  ?? 'unknown',
          assetName:     order?.assetName ?? mode.config.asset?.name ?? 'unknown',
          mode:          'aisignal',
        },
        executed_at: this.supabaseService.timestampFromMillis(nowMs),
      });

      this.logger.log(
        `[${userId}] 📝 Log saved: ${tradeResult} ${amount} profit=${profit} step=${result.martingaleStep}`,
      );
    } catch (err: any) {
      this.logger.error(`[${userId}] Failed to save log: ${err?.message ?? err}`);
    }
  }

  async getLogs(userId: string, limit = 100): Promise<any[]> {
    const { data, error } = await this.supabaseService.client
      .from('mode_logs')
      .select('*')
      .eq('user_id', userId)
      .eq('mode', 'aisignal')
      .order('executed_at', { ascending: false })
      .limit(limit);

    if (error) {
      this.logger.warn(`[${userId}] Failed to fetch logs: ${error.message}`);
      return [];
    }
    return (data ?? []).map((d) => ({
      ...(d.data as any),
      executedAt: new Date(d.executed_at).getTime(),
    }));
  }

  private async updateStatus(userId: string, botState: string) {
    await this.supabaseService.client.from('aisignal_status').upsert({
      user_id:    userId,
      bot_state:  botState,
      updated_at: this.supabaseService.now(),
    });
  }

  // ==================== PUBLIC METHODS ====================

  getPendingOrders(userId: string): AISignalOrder[] {
    const mode = this.activeModes.get(userId);
    return mode ? mode.pendingOrders.filter((o) => !o.isExecuted) : [];
  }

  getExecutedOrders(userId: string): AISignalOrder[] {
    const mode = this.activeModes.get(userId);
    return mode ? mode.pendingOrders.filter((o) => o.isExecuted) : [];
  }

  async injectTestSignal(
    userId: string,
    trend: string,
    delayMs?: number,
  ): Promise<{ message: string }> {
    await this.telegramSignalService.injectTestSignal(userId, trend, delayMs);
    return { message: `Test signal injected: ${trend}` };
  }
}