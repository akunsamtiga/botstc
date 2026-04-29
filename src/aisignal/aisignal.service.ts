import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { FirebaseService } from '../firebase/firebase.service';
import { AuthService } from '../auth/auth.service';
import { FirebaseMessagingService } from '../firebase/firebase-messaging.service';
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

const BASE_URL = 'https://api.stockity.id';

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
    private readonly firebaseService: FirebaseService,
    private readonly authService: AuthService,
    private readonly firebaseMessaging: FirebaseMessagingService,
    private readonly aiSignalMonitor: AISignalMonitorService,
    private readonly telegramSignalService: TelegramSignalService,
  ) {}

  /**
   * Saat server startup: bersihkan semua stale botState='RUNNING' di Firestore.
   * State ini tertinggal jika server sebelumnya mati/restart tanpa sempat cleanup.
   * activeModes (in-memory) selalu kosong saat startup — jadi RUNNING di Firestore = stale.
   */
  async onModuleInit() {
    try {
      const staleDocs = await this.firebaseService.db
        .collection('aisignal_status')
        .where('botState', '==', 'RUNNING')
        .get();

      if (!staleDocs.empty) {
        this.logger.warn(
          `[Startup] Found ${staleDocs.size} stale RUNNING AI Signal status(es) — resetting to STOPPED`,
        );
        const batch = this.firebaseService.db.batch();
        for (const doc of staleDocs.docs) {
          batch.set(
            doc.ref,
            { botState: 'STOPPED', updatedAt: this.firebaseService.FieldValue.serverTimestamp() },
            { merge: true },
          );
        }
        await batch.commit();
        this.logger.log(`[Startup] Stale AI Signal statuses cleared`);
      }
    } catch (err: any) {
      this.logger.error(`[Startup] Failed to clear stale AI Signal statuses: ${err?.message}`);
    }
  }

  onModuleDestroy() {
    for (const [userId] of this.activeModes) {
      this.stopAISignalMode(userId);
    }
  }

  // ==================== CONFIG ====================

  async getConfig(userId: string): Promise<AISignalConfig> {
    if (this.configs.has(userId)) return this.configs.get(userId)!;

    const doc = await this.firebaseService.db.collection('aisignal_configs').doc(userId).get();
    if (doc.exists) {
      const d = doc.data() as any;
      const cfg: AISignalConfig = {
        asset: d.asset || null,
        baseAmount: d.baseAmount || 1400000,
        martingale: d.martingale || {
          isEnabled: true,
          maxSteps: 2,
          multiplierValue: 2.5,
          multiplierType: 'FIXED',
          isAlwaysSignal: false,
        },
        isDemoAccount: d.isDemoAccount ?? true,
        currency: d.currency || 'IDR',
      };
      this.configs.set(userId, cfg);
      return cfg;
    }

    const def: AISignalConfig = {
      asset: null,
      baseAmount: 1400000,
      martingale: {
        isEnabled: true,
        maxSteps: 2,
        multiplierValue: 2.5,
        multiplierType: 'FIXED',
        isAlwaysSignal: false,
      },
      isDemoAccount: true,
      currency: 'IDR',
    };
    this.configs.set(userId, def);
    return def;
  }

  async updateConfig(userId: string, dto: Partial<AISignalConfig>): Promise<AISignalConfig> {
    const current = await this.getConfig(userId);
    const updated = { ...current, ...dto };
    this.configs.set(userId, updated);

    const plainCfg = JSON.parse(JSON.stringify(updated));
    await this.firebaseService.db.collection('aisignal_configs').doc(userId).set(
      { ...plainCfg, updatedAt: this.firebaseService.FieldValue.serverTimestamp() },
      { merge: true },
    );

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
    if (!config.asset?.ric) {
      throw new Error('Asset belum dikonfigurasi');
    }

    const ws = new StockityWebSocketClient(
      userId,
      session.stockityToken,
      session.deviceId,
      session.deviceType || 'web',
      session.userAgent,
    );

    try {
      await ws.connect();
    } catch (err: any) {
      ws.disconnect();
      throw new Error(`Gagal koneksi WebSocket: ${err?.message || err}`);
    }

    const stats: SessionStats = {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      sessionPnL: 0,
    };

    this.activeModes.set(userId, {
      isActive: true,
      wsClient: ws,
      pendingOrders: [],
      executedOrdersMap: new Map(),
      activeMartingaleOrders: new Map(),
      alwaysSignalLossTracking: null,
      processedOrderIds: new Set(),
      session,
      config,
      stats,
    });

    this.telegramSignalService.setSignalCallback(userId, (uid, signal) => {
      this.handleIncomingSignal(uid, signal);
    });

    await this.telegramSignalService.startListening(userId);

    this.aiSignalMonitor.setUserSession(userId, session);

    ws.setOnStatusChange((connected, reason) => {
      this.logger.log(`[${userId}] WebSocket status: ${connected ? 'connected' : 'disconnected'} - ${reason || ''}`);
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
      this.logger.log(`[${userId}] AI Signal tidak aktif di memory — Firestore status di-reset ke STOPPED`);
      return { message: 'AI Signal mode tidak berjalan' };
    }

    mode.isActive = false;
    if (mode.executionInterval) {
      clearInterval(mode.executionInterval);
    }

    this.telegramSignalService.stopListening(userId);
    this.aiSignalMonitor.stopMonitoring(userId);
    mode.wsClient.disconnect();
    this.activeModes.delete(userId);

    await this.updateStatus(userId, 'STOPPED');
    this.logger.log(`[${userId}] AI Signal mode stopped`);

    return { message: 'AI Signal mode dihentikan' };
  }

  async getStatus(userId: string): Promise<object> {
    const mode = this.activeModes.get(userId);
    const config = await this.getConfig(userId);

    if (mode) {
      const pendingCount = mode.pendingOrders.filter((o) => !o.isExecuted).length;
      const executedCount = mode.pendingOrders.filter((o) => o.isExecuted).length;

      return {
        isActive: mode.isActive,
        botState: 'RUNNING',
        totalOrders: mode.pendingOrders.length,
        pendingOrders: pendingCount,
        executedOrders: executedCount,
        activeMartingaleSequences: mode.activeMartingaleOrders.size,
        wsConnected: mode.wsClient.isConnected(),
        alwaysSignalStatus: this.getAlwaysSignalStatus(mode, config),
        monitoringStatus: this.aiSignalMonitor.getMonitoringStatus(userId),
        telegramSignalStatus: this.telegramSignalService.getStatus(userId),
        stats: mode.stats,
        sessionPnL: mode.stats.sessionPnL,
        totalWins: mode.stats.wins,
        totalLosses: mode.stats.losses,
        totalTrades: mode.stats.totalTrades,
        config,
      };
    }

    const statusDoc = await this.firebaseService.db.collection('aisignal_status').doc(userId).get();
    if (statusDoc.exists && statusDoc.data()?.botState === 'RUNNING') {
      await this.updateStatus(userId, 'STOPPED');
      this.logger.warn(`[${userId}] Stale RUNNING status detected, auto-reset to STOPPED`);
    }
    return {
      isActive: false,
      botState: 'STOPPED',
      config,
    };
  }

  private getAlwaysSignalStatus(mode: ActiveMode, config: AISignalConfig): object {
    if (!config.martingale.isAlwaysSignal || !mode.alwaysSignalLossTracking) {
      return { isActive: false, status: 'No outstanding loss' };
    }

    const lossState = mode.alwaysSignalLossTracking;
    if (!lossState.hasOutstandingLoss) {
      return { isActive: false, status: 'No outstanding loss' };
    }

    return {
      isActive: true,
      currentStep: lossState.currentMartingaleStep,
      maxSteps: config.martingale.maxSteps,
      totalLoss: lossState.totalLoss,
      status: `Waiting for next signal (Step ${lossState.currentMartingaleStep}/${config.martingale.maxSteps})`,
    };
  }

  // ==================== SIGNAL HANDLING ====================

  private async handleIncomingSignal(userId: string, signal: TelegramSignal): Promise<void> {
    try {
      this.logger.log(
        `[${userId}] Incoming signal received: ${signal.trend} at ${new Date(signal.executionTime).toISOString()}`,
      );

      await this.receiveSignal(userId, {
        trend: signal.trend,
        executionTime: signal.executionTime,
        originalMessage: signal.originalMessage,
      });
    } catch (error) {
      this.logger.error(`[${userId}] Error handling incoming signal: ${(error as Error).message}`);
    }
  }

  async receiveSignal(
    userId: string,
    signalData: { trend: string; executionTime?: number; originalMessage?: string },
  ): Promise<{ message: string }> {
    const mode = this.activeModes.get(userId);
    if (!mode?.isActive) {
      throw new Error('AI Signal mode tidak aktif');
    }

    const config = await this.getConfig(userId);
    const session = await this.authService.getSession(userId);
    if (!session) throw new Error('Session tidak ditemukan');

    const signal: TelegramSignal = {
      trend:
        signalData.trend.toLowerCase() === 'buy' || signalData.trend.toLowerCase() === 'call'
          ? 'call'
          : 'put',
      executionTime: signalData.executionTime || Date.now() + 5000,
      receivedAt: Date.now(),
      originalMessage: signalData.originalMessage || `AI Signal: ${signalData.trend}`,
    };

    // ── FIX BUG 3: Block new signals while any order is executing or being monitored ──
    // Previously only checked activeMartingaleOrders.size > 0, which is only set AFTER
    // a loss result is received — leaving a gap where new signals could sneak in.
    if (!config.martingale.isAlwaysSignal) {
      const hasActiveOrder = mode.pendingOrders.some(
        (o) =>
          o.isExecuted &&
          (o.status === AISignalOrderStatus.EXECUTING ||
            o.status === AISignalOrderStatus.MONITORING),
      );
      if (hasActiveOrder || mode.activeMartingaleOrders.size > 0) {
        this.logger.log(`[${userId}] Signal skipped — order is executing/monitoring or martingale active`);
        return { message: 'Signal skipped - Order in progress' };
      }
    }

    // Handle Always Signal mode with outstanding loss
    if (config.martingale.isAlwaysSignal && mode.alwaysSignalLossTracking?.hasOutstandingLoss) {
      return this.handleAlwaysSignalMartingale(userId, config, session);
    }

    // Create normal order
    const order: AISignalOrder = {
      id: uuidv4(),
      assetRic: config.asset!.ric,
      assetName: config.asset!.name,
      trend: signal.trend,
      amount: config.baseAmount,
      executionTime: signal.executionTime,
      receivedAt: signal.receivedAt,
      originalMessage: signal.originalMessage,
      isExecuted: false,
      status: AISignalOrderStatus.PENDING,
      martingaleStep: 0,
      maxMartingaleSteps: config.martingale.maxSteps,
    };

    mode.pendingOrders.push(order);
    mode.pendingOrders.sort((a, b) => a.executionTime - b.executionTime);

    this.logger.log(
      `[${userId}] New AI Signal received: ${signal.trend} at ${new Date(signal.executionTime).toISOString()}`,
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
      const executionDate = new Date(signal.executionTime);
      const hour = executionDate.getHours();
      const minute = executionDate.getMinutes();
      const second = executionDate.getSeconds();

      const topic = `trading_signals_${userId}`;

      const message: admin.messaging.Message = {
        topic,
        data: {
          type: 'TRADING_SIGNAL',
          trend: signal.trend,
          has_time: 'true',
          hour: hour.toString(),
          minute: minute.toString(),
          second: second.toString(),
          original_message: signal.originalMessage,
          timestamp: signal.receivedAt.toString(),
          user_id: userId,
          order_id: order.id,
        },
        notification: {
          title: '🎯 New Trading Signal',
          body: `${signal.trend.toUpperCase()}: ${signal.originalMessage} (Execute at ${hour}:${minute}:${second})`,
        },
        android: {
          priority: 'high' as const,
          notification: {
            channelId: 'trading_signals',
            priority: 'high' as const,
            sound: 'default',
          },
        },
      };

      await this.firebaseMessaging.send(message);
      this.logger.log(`[${userId}] Signal sent to FCM topic '${topic}'`);
    } catch (err: any) {
      this.logger.debug(`[${userId}] FCM send skipped: ${err?.message || err}`);
    }
  }

  private async handleAlwaysSignalMartingale(
    userId: string,
    config: AISignalConfig,
    session: any,
  ): Promise<{ message: string }> {
    const mode = this.activeModes.get(userId);
    if (!mode) return { message: 'Mode not active' };

    const lossState = mode.alwaysSignalLossTracking!;
    const nextStep = lossState.currentMartingaleStep + 1;

    if (nextStep > config.martingale.maxSteps) {
      this.logger.log(`[${userId}] Always Signal: Max steps reached - RESET`);
      mode.alwaysSignalLossTracking = null;
      return { message: 'Max steps reached - Resetting' };
    }

    // ── FIX BUG 1 (also applies here): use calculateMartingaleAmount with correct formula ──
    const nextAmount = this.calculateMartingaleAmount(config, nextStep);

    const order: AISignalOrder = {
      id: uuidv4(),
      assetRic: config.asset!.ric,
      assetName: config.asset!.name,
      trend: lossState.currentTrend,
      amount: nextAmount,
      executionTime: Date.now() + 5000,
      receivedAt: Date.now(),
      originalMessage: `Martingale Step ${nextStep}`,
      isExecuted: false,
      // ── FIX BUG 5: Always-signal martingale orders must have martingaleStep = 0 so
      //    monitor treats them as "initial orders", not standard martingale.
      //    Standard martingale uses activeMartingaleOrders map (not set for always-signal).
      //    If martingaleStep > 0, monitor emits isMartingale=true and the result is silently
      //    ignored because activeMartingaleOrders has no entry for this order's UUID.
      status: AISignalOrderStatus.MARTINGALE_STEP,
      martingaleStep: 0,           // treat as initial order for monitor result routing
      maxMartingaleSteps: config.martingale.maxSteps,
    };

    mode.pendingOrders.push(order);
    mode.pendingOrders.sort((a, b) => a.executionTime - b.executionTime);

    mode.alwaysSignalLossTracking = {
      ...lossState,
      currentMartingaleStep: nextStep,
    };

    this.logger.log(`[${userId}] Always Signal Martingale Step ${nextStep}: ${nextAmount}`);

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
        this.logger.error(`[${userId}] Error in execution monitoring: ${err?.message || err}`);
      }
    }, EXECUTION_CHECK_INTERVAL_MS);

    this.logger.log(`[${userId}] Execution monitoring started (${EXECUTION_CHECK_INTERVAL_MS}ms interval)`);
  }

  private async checkAndExecutePendingOrders(userId: string) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    const currentTime = Date.now();
    const ordersToExecute = mode.pendingOrders.filter((order) => {
      return !order.isExecuted && currentTime >= order.executionTime - EXECUTION_ADVANCE_MS;
    });

    for (const order of ordersToExecute) {
      await this.executeOrder(userId, order);
    }
  }

  private async executeOrder(userId: string, order: AISignalOrder) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    if (order.isExecuted) return;

    const orderIndex = mode.pendingOrders.findIndex((o) => o.id === order.id);
    if (orderIndex !== -1) {
      mode.pendingOrders[orderIndex] = {
        ...order,
        isExecuted: true,
        status: AISignalOrderStatus.EXECUTING,
      };
      mode.executedOrdersMap.set(order.id, mode.pendingOrders[orderIndex]);
    }

    this.logger.log(`[${userId}] Executing AI Signal order: ${order.trend} - ${order.amount}`);

    try {
      const isScheduled = order.martingaleStep === 0;
      const result = await mode.wsClient.placeTrade(
        this.buildTradePayload(
          mode.session,
          mode.config,
          order.amount,
          order.trend,
          isScheduled,
          isScheduled ? order.executionTime : undefined,
        ),
      );

      if (result.dealId) {
        this.logger.log(`[${userId}] Trade placed successfully: ${result.dealId}`);
      } else {
        this.logger.error(`[${userId}] Trade failed: ${result.error}`);
        const idx = mode.pendingOrders.findIndex((o) => o.id === order.id);
        if (idx !== -1) {
          mode.pendingOrders[idx] = {
            ...mode.pendingOrders[idx],
            status: AISignalOrderStatus.WAITING,
            isExecuted: false,
          };
        }
        return;
      }
    } catch (error) {
      this.logger.error(`[${userId}] Error placing trade: ${(error as Error).message}`);
      const idx = mode.pendingOrders.findIndex((o) => o.id === order.id);
      if (idx !== -1) {
        mode.pendingOrders[idx] = {
          ...mode.pendingOrders[idx],
          status: AISignalOrderStatus.WAITING,
          isExecuted: false,
        };
      }
      return;
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
      const idx = mode.pendingOrders.findIndex((o) => o.id === order.id);
      if (idx !== -1 && mode.pendingOrders[idx].status === AISignalOrderStatus.EXECUTING) {
        mode.pendingOrders[idx] = {
          ...mode.pendingOrders[idx],
          status: AISignalOrderStatus.MONITORING,
        };
        mode.executedOrdersMap.set(order.id, mode.pendingOrders[idx]);
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
      mode.executedOrdersMap.get(result.monitoringOrderId) ||
      mode.executedOrdersMap.get(result.parentOrderId) ||
      mode.pendingOrders.find((o) => o.id === result.monitoringOrderId) ||
      mode.pendingOrders.find((o) => o.id === result.parentOrderId);

    if (order) {
      order.result = result.isWin ? 'WIN' : 'LOSE';
      order.status = result.isWin ? AISignalOrderStatus.WIN : AISignalOrderStatus.LOSE;
    }

    // ── Martingale-aware stats counter ────────────────────────────────────
    {
      const _m = mode.config.martingale;
      const _mEnabled = _m.isEnabled && _m.maxSteps > 0;
      const _isMidSeqLoss =
        !result.isWin &&
        ((!result.isMartingale && _mEnabled) ||
          (result.isMartingale && result.martingaleStep < _m.maxSteps));

      if (result.isWin) {
        const profit = Math.floor((order?.amount || mode.config.baseAmount) * 0.85);
        mode.stats.sessionPnL += profit;
      } else {
        mode.stats.sessionPnL -= order?.amount || mode.config.baseAmount;
      }

      if (!_isMidSeqLoss) {
        mode.stats.totalTrades++;
        if (result.isWin) {
          mode.stats.wins++;
        } else {
          mode.stats.losses++;
        }
      }
    }

    await this.saveAISignalLog(userId, result, order, mode);

    this.logger.log(
      `[${userId}] AI Signal result (from monitor): ${result.isWin ? 'WIN' : 'LOSE'} - Martingale: ${result.isMartingale}`,
    );

    if (result.isMartingale) {
      const martingaleInfo = mode.activeMartingaleOrders.get(result.parentOrderId);
      if (martingaleInfo) {
        // Standard martingale result
        await this.handleMartingaleResult(userId, result.parentOrderId, martingaleInfo, result.isWin);
      } else {
        // ── FIX BUG 5: isMartingale=true but no activeMartingaleOrders entry ──
        // This happens for always-signal martingale orders (martingaleStep was set > 0
        // in the old code, but now those orders have martingaleStep=0, so this branch
        // should only fire if there's a stale order from a previous code version).
        // Treat it as an initial trade result so the chain doesn't silently break.
        this.logger.warn(
          `[${userId}] isMartingale=true but no activeMartingaleOrders entry for ${result.parentOrderId} — routing to handleInitialTradeResult`,
        );
        await this.handleInitialTradeResult(userId, result.parentOrderId, result.isWin);
      }
    } else {
      await this.handleInitialTradeResult(userId, result.parentOrderId, result.isWin);
    }

    setTimeout(() => {
      const targetId = result.isMartingale ? result.monitoringOrderId : result.parentOrderId;
      const idx = mode.pendingOrders.findIndex((o) => o.id === targetId);
      if (idx !== -1) {
        mode.pendingOrders[idx] = {
          ...mode.pendingOrders[idx],
          status: result.isWin ? AISignalOrderStatus.WIN : AISignalOrderStatus.LOSE,
        };
      }
    }, 3000);
  }

  private async handleInitialTradeResult(userId: string, orderId: string, isWin: boolean) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    const order =
      mode.executedOrdersMap.get(orderId) || mode.pendingOrders.find((o) => o.id === orderId);

    if (isWin) {
      // ── FIX BUG 4 (partial): reset alwaysSignalLossTracking on WIN ──
      // Covers the case where an always-signal martingale order (now martingaleStep=0)
      // comes back WIN — the outstanding loss is cleared.
      mode.alwaysSignalLossTracking = null;
      this.logger.log(`[${userId}] Initial trade WIN`);
    } else {
      if (mode.config.martingale.isEnabled) {
        if (mode.config.martingale.isAlwaysSignal) {
          // Only set if not already tracking (avoid overwriting step progress)
          if (!mode.alwaysSignalLossTracking?.hasOutstandingLoss) {
            mode.alwaysSignalLossTracking = {
              hasOutstandingLoss: true,
              currentMartingaleStep: 0,
              originalOrderId: orderId,
              totalLoss: order?.amount || mode.config.baseAmount,
              currentTrend: order?.trend || 'call',
            };
          }
          this.logger.log(`[${userId}] Always Signal: Will continue on next signal`);
        } else {
          await this.startMartingale(userId, orderId, order?.trend || 'call');
        }
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
      // ── FIX BUG 4: reset alwaysSignalLossTracking on martingale WIN ──
      // Previously this was never cleared here, causing always-signal to keep
      // triggering martingale steps even after a win.
      mode.alwaysSignalLossTracking = null;
      this.logger.log(`[${userId}] Martingale WIN at step ${martingaleInfo.currentStep}`);
    } else {
      const nextStep = martingaleInfo.currentStep + 1;

      if (nextStep > mode.config.martingale.maxSteps) {
        mode.activeMartingaleOrders.delete(parentOrderId);
        // Max steps exhausted — also clear any stale alwaysSignal tracking
        mode.alwaysSignalLossTracking = null;
        this.logger.log(`[${userId}] Martingale failed - Max steps reached`);
      } else {
        const currentStepAmount = this.calculateMartingaleAmount(mode.config, martingaleInfo.currentStep);
        const newTotalLoss = martingaleInfo.totalLoss + currentStepAmount;

        mode.activeMartingaleOrders.set(parentOrderId, {
          ...martingaleInfo,
          currentStep: nextStep,
          totalLoss: newTotalLoss,
        });

        this.logger.log(`[${userId}] Martingale continuing to step ${nextStep}`);

        const nextAmount = this.calculateMartingaleAmount(mode.config, nextStep);
        setTimeout(() => {
          this.executeMartingaleTrade(userId, parentOrderId, martingaleInfo.originalTrend, nextAmount, nextStep);
        }, 300);
      }
    }
  }

  private async startMartingale(userId: string, parentOrderId: string, trend: string) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    const nextStep = 1;
    // ── FIX BUG 1: calculateMartingaleAmount now uses correct formula (step, not step-1) ──
    const nextAmount = this.calculateMartingaleAmount(mode.config, nextStep);

    mode.activeMartingaleOrders.set(parentOrderId, {
      orderId: parentOrderId,
      currentStep: nextStep,
      maxSteps: mode.config.martingale.maxSteps,
      totalLoss: mode.config.baseAmount,
      isActive: true,
      originalTrend: trend,
      lastExecutionTime: Date.now(),
    });

    await this.executeMartingaleTrade(userId, parentOrderId, trend, nextAmount, nextStep);
  }

  // ── FIX BUG 2: make async so we can await placeTrade and confirm placement ──
  // Previously this was a sync fire-and-forget (.then()), which meant monitoring
  // started even if placeTrade failed, breaking the martingale chain silently.
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
    const currentTime = Date.now();

    const martingaleOrder: AISignalOrder = {
      id: martingaleOrderId,
      assetRic: mode.config.asset!.ric,
      assetName: mode.config.asset!.name,
      trend,
      amount,
      executionTime: currentTime,
      receivedAt: currentTime,
      originalMessage: `Martingale Step ${step}`,
      isExecuted: true,
      status: AISignalOrderStatus.EXECUTING,
      martingaleStep: step,
      maxMartingaleSteps: mode.config.martingale.maxSteps,
    };

    mode.pendingOrders.push(martingaleOrder);
    mode.executedOrdersMap.set(martingaleOrderId, martingaleOrder);

    this.logger.log(`[${userId}] Executing martingale step ${step}: ${amount}`);

    // ── FIX BUG 2: await the trade result; only start monitoring on success ──
    let placedDealId: string | null = null;
    try {
      const result = await mode.wsClient.placeTrade(
        this.buildTradePayload(mode.session, mode.config, amount, trend),
      );

      if (result?.dealId) {
        placedDealId = result.dealId;
        this.logger.log(`[${userId}] Martingale trade placed: ${result.dealId}`);
      } else {
        this.logger.error(`[${userId}] Martingale trade failed: ${result?.error}`);

        // Mark order as failed so the UI reflects it
        const idx = mode.pendingOrders.findIndex((o) => o.id === martingaleOrderId);
        if (idx !== -1) {
          mode.pendingOrders[idx] = {
            ...mode.pendingOrders[idx],
            status: AISignalOrderStatus.WAITING,
            isExecuted: false,
          };
        }
        // Remove from activeMartingaleOrders so future signals aren't blocked forever
        mode.activeMartingaleOrders.delete(parentOrderId);
        return; // Don't start monitoring — no trade was placed
      }
    } catch (error: unknown) {
      this.logger.error(`[${userId}] Error placing martingale trade: ${(error as Error).message}`);

      const idx = mode.pendingOrders.findIndex((o) => o.id === martingaleOrderId);
      if (idx !== -1) {
        mode.pendingOrders[idx] = {
          ...mode.pendingOrders[idx],
          status: AISignalOrderStatus.WAITING,
          isExecuted: false,
        };
      }
      mode.activeMartingaleOrders.delete(parentOrderId);
      return;
    }

    // Trade confirmed — now start monitoring
    this.aiSignalMonitor.startMonitoringOrder(
      userId,
      parentOrderId,
      trend,
      amount,
      mode.config.asset!.ric,
      mode.config.isDemoAccount,
      true,  // isMartingale
      step,
    );

    // Update order status to MONITORING after 2s
    setTimeout(() => {
      const idx = mode.pendingOrders.findIndex((o) => o.id === martingaleOrderId);
      if (idx !== -1 && mode.pendingOrders[idx].status === AISignalOrderStatus.EXECUTING) {
        mode.pendingOrders[idx] = {
          ...mode.pendingOrders[idx],
          status: AISignalOrderStatus.MONITORING,
        };
        mode.executedOrdersMap.set(martingaleOrderId, mode.pendingOrders[idx]);
      }
    }, 2000);
  }

  /**
   * Calculate martingale amount for a given step.
   *
   * ── FIX BUG 1 ──
   * Old formula: baseAmount * Math.pow(multiplier, step - 1)
   *   → step=1: baseAmount * 1 = baseAmount  (no increase — WRONG)
   *   → step=2: baseAmount * multiplier
   *
   * Correct formula: baseAmount * Math.pow(multiplier, step)
   *   → step=1: baseAmount * multiplier      (first increase — CORRECT)
   *   → step=2: baseAmount * multiplier²
   *
   * The base order already uses baseAmount (step=0), so every martingale step
   * must multiply by at least one factor of multiplier.
   */
  private calculateMartingaleAmount(config: AISignalConfig, step: number): number {
    const multiplier =
      config.martingale.multiplierType === 'FIXED'
        ? config.martingale.multiplierValue
        : 1 + config.martingale.multiplierValue / 100;

    return Math.floor(config.baseAmount * Math.pow(multiplier, step)); // was: step - 1
  }

  /**
   * Build trade payload — identik dengan ScheduleExecutor.buildTradeOrder().
   */
  private buildTradePayload(
    session: any,
    config: AISignalConfig,
    amount: number,
    trend: string,
    isScheduled = true,
    executionTimeMs?: number,
  ): any {
    const baseMs = isScheduled && executionTimeMs ? executionTimeMs : Date.now();
    const createdAtSeconds = Math.floor(baseMs / 1000);
    const secondsInMinute = createdAtSeconds % 60;

    let finalExpireAt: number;

    if (isScheduled) {
      let expireAtSeconds: number;
      if (secondsInMinute <= 10) {
        expireAtSeconds = createdAtSeconds + (60 - secondsInMinute);
      } else {
        expireAtSeconds = createdAtSeconds + (120 - secondsInMinute);
      }
      const duration = expireAtSeconds - createdAtSeconds;
      finalExpireAt = duration < 55 || duration > 120 ? createdAtSeconds + 60 : expireAtSeconds;
    } else {
      const remainingInMinute = 60 - secondsInMinute;
      finalExpireAt =
        remainingInMinute >= 45
          ? createdAtSeconds + remainingInMinute
          : createdAtSeconds + remainingInMinute + 60;
    }

    const duration = finalExpireAt - createdAtSeconds;
    if (duration < 45 || duration > 125) {
      finalExpireAt = createdAtSeconds + 60;
    }

    return {
      amount,
      createdAt: createdAtSeconds * 1000,
      dealType: config.isDemoAccount ? 'demo' : 'real',
      expireAt: finalExpireAt,
      iso: session.currencyIso || config.currency || 'IDR',
      optionType: 'turbo',
      ric: config.asset!.ric,
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
      const tradeResult: 'WIN' | 'LOSE' | 'DRAW' = result.isWin ? 'WIN' : 'LOSE';
      const amount = order?.amount || mode.config.baseAmount;
      const profit = result.isWin ? Math.floor(amount * 0.85) : -amount;

      const logEntry = {
        id: result.monitoringOrderId,
        orderId: result.parentOrderId,
        trend: order?.trend || 'call',
        amount,
        martingaleStep: result.martingaleStep,
        dealId: result.details.get('trade_id') || undefined,
        result: tradeResult,
        profit,
        sessionPnL: mode.stats.sessionPnL,
        executedAt: this.firebaseService.Timestamp.fromMillis(Date.now()),
        isDemoAccount: mode.config.isDemoAccount,
        ric: order?.assetRic || mode.config.asset?.ric || 'unknown',
        assetRic: order?.assetRic || mode.config.asset?.ric || 'unknown',
        assetName: order?.assetName || mode.config.asset?.name || 'unknown',
        mode: 'aisignal',
      };

      await this.firebaseService.db
        .collection('aisignal_logs')
        .doc(userId)
        .collection('entries')
        .doc(logEntry.id)
        .set(logEntry);

      this.logger.log(
        `[${userId}] 📝 AI Signal log saved: ${tradeResult} ${amount} profit=${profit} step=${result.martingaleStep}`,
      );
    } catch (err: any) {
      this.logger.error(`[${userId}] Failed to save AI signal log: ${err?.message || err}`);
    }
  }

  private async updateStatus(userId: string, botState: string) {
    await this.firebaseService.db.collection('aisignal_status').doc(userId).set(
      { botState, updatedAt: this.firebaseService.FieldValue.serverTimestamp() },
      { merge: true },
    );
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

  async injectTestSignal(userId: string, trend: string, delayMs?: number): Promise<{ message: string }> {
    await this.telegramSignalService.injectTestSignal(userId, trend, delayMs);
    return { message: `Test signal injected: ${trend}` };
  }
}