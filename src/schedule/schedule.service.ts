import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { AuthService } from '../auth/auth.service';
import { OrderTrackingService } from './order-tracking.service';
import { StockityWebSocketClient } from './websocket-client';
import { ScheduleExecutor, ExecutorCallbacks } from './schedule-executor';
import { UpdateScheduleConfigDto } from './dto/update-config.dto';
import { ScheduledOrder, ScheduleConfig, ExecutionLog, StockityAsset } from './types';
import { v4 as uuidv4 } from 'uuid';
import { curlGet } from '../common/http-utils';

const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;
const BASE_URL = 'https://api.stockity.id';

/**
 * Debounce interval untuk saveOrders (onOrdersUpdate callback).
 *
 * onOrdersUpdate dipanggil dari tick() executor setiap kali ada perubahan order.
 * Tanpa debounce ini, Firestore akan di-write setiap kali order di-skip/execute
 * (bisa puluhan kali per detik saat banyak order). Dengan debounce 5s,
 * write hanya terjadi paling cepat sekali per 5 detik.
 *
 * Data yang "ketinggalan" tidak masalah karena:
 * - State aktual selalu ada di memory (executor)
 * - Firestore hanya untuk restore session saat crash/restart
 */
const SAVE_ORDERS_DEBOUNCE_MS = 5000;

// Type mapping sesuai Kotlin AssetManager
const TYPE_NAME_MAPPING: Record<number, string> = {
  1: 'Forex',
  2: 'Crypto',
  3: 'Saham',
  4: 'Komoditas',
  5: 'Indeks',
  6: 'ETF',
  7: 'OTC',
  8: 'Event',
  9: 'AI Index',
  10: 'Synthetic Index',
  11: 'Metal',
};

/**
 * Default config tanpa asset hardcoded.
 * Asset harus di-set user melalui updateConfig(), atau di-fetch via getAvailableAssets().
 */
const DEFAULT_CONFIG: Omit<ScheduleConfig, 'asset'> & { asset: null } = {
  asset: null,
  martingale: {
    isEnabled: true, maxSteps: 2,
    baseAmount: 1400000, multiplierValue: 2.5,
    multiplierType: 'FIXED', isAlwaysSignal: false,
  },
  isDemoAccount: true,
  currency: 'IDR', currencyIso: 'IDR',
};

@Injectable()
export class ScheduleService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScheduleService.name);
  private executors = new Map<string, ScheduleExecutor>();
  private wsClients = new Map<string, StockityWebSocketClient>();
  private logs = new Map<string, ExecutionLog[]>();
  private configs = new Map<string, ScheduleConfig>();

  /**
   * Debounce timer untuk saveOrders per userId.
   * Menyimpan latest orders + timer handle.
   */
  private pendingOrdersSave = new Map<string, {
    orders: ScheduledOrder[];
    timer: NodeJS.Timeout;
  }>();

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly authService: AuthService,
    private readonly trackingService: OrderTrackingService,
  ) {}

  async onModuleInit() {
    this.logger.log('ScheduleService init – restoring active sessions...');
    await this.restoreActiveSessions();
  }

  async onModuleDestroy() {
    // Flush semua pending saves sebelum shutdown
    for (const [userId, pending] of this.pendingOrdersSave) {
      clearTimeout(pending.timer);
      await this.saveOrders(userId, pending.orders).catch(() => {});
    }
    this.pendingOrdersSave.clear();

    for (const [, exec] of this.executors) exec.stop();
    for (const [, ws] of this.wsClients) ws.disconnect();
  }

  // ── Restore ──────────────────────────────────

  private async restoreActiveSessions() {
    try {
      const { data: statusData, error: statusError } = await this.supabaseService.withBackoff(async () =>
        this.supabaseService.client
          .from('schedule_status')
          .select('*')
          .in('bot_state', ['RUNNING', 'PAUSED']),
      );
      const docs = statusData || [];
      for (let i = 0; i < docs.length; i++) {
        const doc = docs[i];
        const userId = doc.user_id;
        const wasState = doc.bot_state;
        this.logger.log(`Restoring ${userId} (was ${wasState})`);
        try {
          await this.startSchedule(userId);
          if (wasState === 'PAUSED') {
            this.executors.get(userId)?.pause();
            await this.updateStatus(userId, 'PAUSED');
          }
        } catch (err: any) {
          this.logger.error(`Restore failed for ${userId}: ${err.message}`);
          await this.updateStatus(userId, 'STOPPED').catch(() => {});
        }
        // Stagger session restores to avoid Firestore quota burst
        if (i < docs.length - 1) {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    } catch (err: any) {
      this.logger.error(`restoreActiveSessions error: ${err.message}`);
    }
  }

  // ── Debounced Save Orders ─────────────────────

  /**
   * Debounced version dari saveOrders.
   * Hanya tulis ke Firestore setelah SAVE_ORDERS_DEBOUNCE_MS berlalu sejak
   * panggilan terakhir. Ini mencegah flood write saat banyak order berubah
   * secara bersamaan (e.g., banyak order expire/skip di awal sesi).
   */
  private scheduleSaveOrders(userId: string, orders: ScheduledOrder[]) {
    const existing = this.pendingOrdersSave.get(userId);
    if (existing) {
      clearTimeout(existing.timer);
    }
    const timer = setTimeout(async () => {
      this.pendingOrdersSave.delete(userId);
      await this.saveOrders(userId, orders).catch(() => {});
    }, SAVE_ORDERS_DEBOUNCE_MS);

    this.pendingOrdersSave.set(userId, { orders, timer });
  }

  /**
   * Flush pending save immediately (dipanggil saat bot stop/pause).
   */
  private async flushPendingOrdersSave(userId: string): Promise<void> {
    const pending = this.pendingOrdersSave.get(userId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingOrdersSave.delete(userId);
    await this.saveOrders(userId, pending.orders).catch(() => {});
  }

  // ── Asset Auto-fetch (sesuai Kotlin AssetManager) ─────────────────

  /**
   * Fetch daftar asset yang tersedia dari Stockity API menggunakan session user.
   * Identik dengan Kotlin AssetManager.fetchAssetsFromApi() + processAssets().
   */
  async getAvailableAssets(userId: string): Promise<StockityAsset[]> {
    const session = await this.authService.getSession(userId);
    if (!session) throw new Error('Session tidak ditemukan');

    const headers = this.buildStockityHeaders(session);

    try {
      const resp = await curlGet(
        `${BASE_URL}/bo-assets/v6/assets?locale=id`,
        headers,
        15,
      );

      const rawAssets: any[] = resp.data?.data?.assets || [];
      const processed: StockityAsset[] = [];

      for (const asset of rawAssets) {
        const ric: string = asset.ric;
        const name: string = asset.name;
        const assetType: number = asset.type;
        const typeName = TYPE_NAME_MAPPING[assetType] ?? `Type-${assetType}`;
        let iconUrl: string | null = asset.icon?.url ?? null;
        if (iconUrl && !iconUrl.startsWith('http')) {
          iconUrl = `https://stockity.id${iconUrl.startsWith('/') ? '' : '/'}${iconUrl}`;
        }

        let profitRate: number | null = null;

        const personalRates: any[] = asset.personal_user_payment_rates || [];
        for (const rateEntry of personalRates) {
          if (rateEntry.trading_type === 'turbo') {
            profitRate = rateEntry.payment_rate;
            break;
          }
        }

        if (profitRate === null) {
          const settings = asset.trading_tools_settings;
          profitRate =
            settings?.ftt?.user_statuses?.vip?.payment_rate_turbo ??
            settings?.bo?.payment_rate_turbo ??
            settings?.payment_rate_turbo ??
            null;
        }

        if (profitRate !== null) {
          processed.push({ ric, name, type: assetType, typeName, profitRate, iconUrl });
        }
      }

      processed.sort((a, b) => b.profitRate - a.profitRate);

      this.logger.log(`[${userId}] Fetched ${processed.length} assets from Stockity`);
      return processed;
    } catch (err: any) {
      this.logger.error(`[${userId}] Error fetching assets: ${err.message}`);
      throw new Error(`Gagal mengambil daftar asset dari Stockity: ${err.message}`);
    }
  }

  private buildStockityHeaders(session: any): Record<string, string> {
    return {
      'authorization-token': session.stockityToken,
      'device-id': session.deviceId,
      'device-type': session.deviceType || 'web',
      'user-timezone': session.userTimezone || 'Asia/Jakarta',
      'User-Agent': session.userAgent,
      'Accept': 'application/json, text/plain, */*',
      'Origin': 'https://stockity.id',
      'Referer': 'https://stockity.id/',
    };
  }

  // ── Config ────────────────────────────────────

  async getConfig(userId: string): Promise<ScheduleConfig> {
    if (this.configs.has(userId)) return this.configs.get(userId)!;

    const { data: cfgData, error: cfgError } = await this.supabaseService.client.from('schedule_configs').select('*').eq('user_id', userId).single();
    if (cfgData && !cfgError) {
      const d = cfgData as any;
      const cfg: ScheduleConfig = {
        asset: d.asset || null,
        martingale: d.martingale || DEFAULT_CONFIG.martingale,
        isDemoAccount: d.is_demo_account ?? true,
        currency: d.currency || 'IDR',
        currencyIso: d.currency_iso || 'IDR',
        stopLoss: d.stop_loss ?? 0,
        stopProfit: d.stop_profit ?? 0,
      };
      this.configs.set(userId, cfg);
      return cfg;
    }

    const def = { ...DEFAULT_CONFIG } as unknown as ScheduleConfig;
    this.configs.set(userId, def);
    return def;
  }

  async updateConfig(userId: string, dto: UpdateScheduleConfigDto): Promise<ScheduleConfig> {
    const cfg: ScheduleConfig = {
      asset: dto.asset,
      martingale: dto.martingale,
      isDemoAccount: dto.isDemoAccount,
      currency: dto.currency,
      currencyIso: dto.currencyIso,
      stopLoss: dto.stopLoss ?? 0,
      stopProfit: dto.stopProfit ?? 0,
    };
    this.configs.set(userId, cfg);

    const plainCfg = JSON.parse(JSON.stringify(cfg));
    await this.supabaseService.client.from('schedule_configs').upsert(
      { user_id: userId, ...plainCfg, updated_at: this.supabaseService.now() },
    );
    this.executors.get(userId)?.updateConfig(cfg);
    return cfg;
  }

  // ── Orders ────────────────────────────────────

  async getOrders(userId: string): Promise<ScheduledOrder[]> {
    const exec = this.executors.get(userId);
    if (exec) return exec.getOrders();
    const { data: cfgData, error: cfgError } = await this.supabaseService.client.from('schedule_configs').select('*').eq('user_id', userId).single();
    if (cfgData && !cfgError) return (cfgData as any)?.orders || [];
    return [];
  }

  async addOrders(userId: string, input: string) {
    const { orders, errors } = this.parseInput(input);
    if (orders.length === 0) {
      return { added: 0, errors, message: errors.join(', ') || 'Tidak ada jadwal valid' };
    }

    const exec = this.executors.get(userId);
    if (exec) {
      const added = exec.addOrders(orders);
      await this.saveOrders(userId, exec.getOrders()); // immediate save for manual add
      return { added: added.length, errors, message: `${added.length} jadwal ditambahkan` };
    }

    const existing = await this.getOrders(userId);
    const keys = new Set(existing.map(o => `${o.time}_${o.trend}`));
    const newOnes = orders.filter(o => !keys.has(`${o.time}_${o.trend}`));
    const all = [...existing, ...newOnes].sort((a, b) => a.timeInMillis - b.timeInMillis);
    await this.saveOrders(userId, all);
    return { added: newOnes.length, errors, message: `${newOnes.length} jadwal disimpan` };
  }

  async removeOrder(userId: string, orderId: string) {
    const exec = this.executors.get(userId);
    if (exec) {
      exec.removeOrder(orderId);
      await this.saveOrders(userId, exec.getOrders()); // immediate save for manual remove
    } else {
      const orders = (await this.getOrders(userId)).filter(o => o.id !== orderId);
      await this.saveOrders(userId, orders);
    }
    return { message: 'Order dihapus' };
  }

  async clearOrders(userId: string) {
    const exec = this.executors.get(userId);
    if (exec) exec.clearOrders();
    await this.saveOrders(userId, []);
    return { message: 'Semua order dihapus' };
  }

  private async saveOrders(userId: string, orders: ScheduledOrder[]) {
    await this.supabaseService.client.from('schedule_configs').upsert(
      { user_id: userId, orders, updated_at: this.supabaseService.now() },
    );
  }

  // ── Control ───────────────────────────────────

  async startSchedule(userId: string) {
    const existing = this.executors.get(userId);
    if (existing?.getBotState() === 'RUNNING') {
      return { message: 'Schedule sudah berjalan', status: existing.getStatus() };
    }

    const session = await this.authService.getSession(userId);
    if (!session) throw new Error('Session tidak ditemukan. Silakan login ulang.');
    if (!session.stockityToken) {
      throw new Error('Token Stockity tidak ditemukan di session. Silakan login ulang.');
    }

    const config = await this.getConfig(userId);
    if (!config.asset?.ric) {
      throw new Error(
        'Asset belum dikonfigurasi. ' +
        'Gunakan GET /schedule/assets untuk melihat daftar asset, ' +
        'lalu set melalui PUT /schedule/config.',
      );
    }

    const rawOrders = await this.getOrders(userId);

    // Buang orders yang sudah kadaluarsa lebih dari satu jam (tidak mungkin dieksekusi).
    // Ini mencegah tracking diisi dengan orders lama dari sesi sebelumnya yang akan
    // langsung di-skip executor, tapi kalau ada error tidak sempat di-update dari PENDING.
    const ONE_HOUR_MS = 3_600_000;
    const now = Date.now();
    const orders = rawOrders.filter(o => o.timeInMillis > now - ONE_HOUR_MS);

    if (rawOrders.length !== orders.length) {
      this.logger.warn(
        `[${userId}] Filtered ${rawOrders.length - orders.length} expired orders before start`,
      );
    }

    await this.trackingService.archiveTracking(userId).catch(() => {});
    await this.trackingService.initializeTracking(userId, orders);

    const ws = new StockityWebSocketClient(
      userId,
      session.stockityToken,
      session.deviceId,
      session.deviceType || 'web',
      session.userAgent,
    );

    ws.setOnStatusChange((connected, reason) => {
      this.logger.log(`[${userId}] WS: ${connected ? 'Connected' : 'Disconnected'} ${reason || ''}`);
    });

    try {
      await ws.connect();
    } catch (err: any) {
      this.logger.error(`[${userId}] WS gagal connect: ${err.message}`);
      ws.disconnect();
      throw new Error(`Gagal koneksi WebSocket: ${err.message}. Coba login ulang.`);
    }

    this.wsClients.set(userId, ws);
    if (!this.logs.has(userId)) this.logs.set(userId, []);

    const callbacks: ExecutorCallbacks = {
      /**
       * OPTIMASI: Gunakan debounced save daripada langsung write ke Firestore.
       * onOrdersUpdate bisa dipanggil berkali-kali per detik dari tick() executor.
       * Dengan debounce 5s, Firestore hanya di-write setelah 5s idle.
       */
      onOrdersUpdate: (o) => { this.scheduleSaveOrders(userId, o); },
      onLog: async (log) => {
        const arr = this.logs.get(userId) || [];
        const existingIdx = arr.findIndex(l => l.id === log.id);
        if (existingIdx !== -1) {
          arr[existingIdx] = log;
        } else {
          arr.push(log);
        }
        if (arr.length > 500) arr.splice(0, arr.length - 500);
        this.logs.set(userId, arr);
        await this.appendLog(userId, log).catch(() => {});
      },
      onAllCompleted: async () => {
        this.logger.log(`[${userId}] All completed`);
        const exec = this.executors.get(userId);
        const status = exec?.getStatus() as any;
        const sessionPnL = status?.sessionPnL ?? 0;
        try {
          // Flush pending saves dulu sebelum update status STOPPED
          await this.flushPendingOrdersSave(userId);
          // Cleanup non-terminal orders SEBELUM cache di-delete oleh updateBotState(STOPPED)
          await this.trackingService.cleanupPendingOrders(userId, 'Session selesai');
          await this.updateStatus(userId, 'STOPPED', sessionPnL);
          await this.trackingService.updateBotState(userId, 'STOPPED');
          this.logger.log(`[${userId}] Status updated to STOPPED`);
          await new Promise(r => setTimeout(r, 500));
        } catch (err: any) {
          this.logger.error(`[${userId}] Failed to update status: ${err.message}`);
        }
        this.cleanup(userId);
      },
      onStatusChange: (s) => this.logger.debug(`[${userId}] ${s}`),
      onOrderExecuted: async (orderId, dealId, amount, estimatedCompletionTime) => {
        await this.trackingService.markOrderAsExecuted(userId, orderId, dealId, amount, estimatedCompletionTime);
      },
      onMartingaleStep: async (orderId, step, amount, dealId) => {
        await this.trackingService.updateMartingaleStep(userId, orderId, step, amount, dealId);
      },
      onOrderCompleted: async (orderId, result, profit, sessionPnL) => {
        await this.trackingService.completeOrder(userId, orderId, result, profit, sessionPnL);
      },
      onOrderFailed: async (orderId, reason) => {
        await this.trackingService.markOrderAsFailed(userId, orderId, reason);
      },
      onOrderSkipped: async (orderId, reason) => {
        await this.trackingService.markOrderAsSkipped(userId, orderId, reason);
      },
      onActiveMartingaleChange: async (martingaleInfo) => {
        await this.trackingService.updateActiveMartingale(userId, martingaleInfo);
      },
    };

    const exec = new ScheduleExecutor(userId, ws, callbacks, orders, config);
    this.executors.set(userId, exec);
    exec.start();

    await this.updateStatus(userId, 'RUNNING');
    await this.trackingService.updateBotState(userId, 'RUNNING');

    return { message: 'Schedule dimulai', status: exec.getStatus() };
  }

  async stopSchedule(userId: string) {
    const exec = this.executors.get(userId);
    if (!exec) return { message: 'Schedule tidak berjalan' };
    exec.stop();
    // Flush pending saves sebelum save final
    await this.flushPendingOrdersSave(userId);
    await this.saveOrders(userId, exec.getOrders());
    // Cleanup non-terminal orders SEBELUM cache di-delete oleh updateBotState(STOPPED)
    await this.trackingService.cleanupPendingOrders(userId, 'Bot dihentikan manual');
    await this.updateStatus(userId, 'STOPPED');
    await this.trackingService.updateBotState(userId, 'STOPPED');
    await new Promise(r => setTimeout(r, 300));
    this.cleanup(userId);
    return { message: 'Schedule dihentikan' };
  }

  async pauseSchedule(userId: string) {
    const exec = this.executors.get(userId);
    if (!exec || exec.getBotState() !== 'RUNNING') return { message: 'Schedule tidak berjalan' };
    exec.pause();
    await this.updateStatus(userId, 'PAUSED');
    await this.trackingService.updateBotState(userId, 'PAUSED');
    return { message: 'Schedule dijeda' };
  }

  async resumeSchedule(userId: string) {
    const exec = this.executors.get(userId);
    if (!exec || exec.getBotState() !== 'PAUSED') return { message: 'Schedule tidak dalam kondisi paused', status: {} };
    exec.resume();
    await this.updateStatus(userId, 'RUNNING');
    await this.trackingService.updateBotState(userId, 'RUNNING');
    return { message: 'Schedule dilanjutkan', status: exec.getStatus() };
  }

  async getStatus(userId: string): Promise<object> {
    const exec = this.executors.get(userId);
    if (exec) {
      return {
        ...exec.getStatus(),
        orders: exec.getOrders(),
        alwaysSignalLossState: exec.getAlwaysSignalLossState(),
      };
    }
    const { data: statusDoc, error: statusDocError } = await this.supabaseService.client.from('schedule_status').select('*').eq('user_id', userId).single();
    const orders = await this.getOrders(userId);
    const statusData = statusDoc && !statusDocError ? statusDoc : null;
    return {
      botState: statusData?.bot_state ?? 'STOPPED',
      totalOrders: orders.length,
      pendingOrders: orders.filter(o => !o.isExecuted && !o.isSkipped).length,
      executedOrders: orders.filter(o => o.isExecuted).length,
      skippedOrders: orders.filter(o => o.isSkipped).length,
      activeMartingaleOrderId: null,
      wsConnected: false,
      sessionPnL: statusData?.session_pnl ?? 0,
      orders,
    };
  }

  async getLogs(userId: string, limit = 100): Promise<ExecutionLog[]> {
    const mem = this.logs.get(userId) || [];
    if (mem.length > 0) return mem.slice(-limit);
    const { data: logData, error: logError } = await this.supabaseService.client
      .from('mode_logs')
      .select('*')
      .eq('user_id', userId)
      .eq('mode', 'schedule')
      .order('executed_at', { ascending: false })
      .limit(limit);
    return (logData || []).map(d => ({
      ...(d.data as ExecutionLog),
      executedAt: new Date(d.executed_at).getTime(),
    }));
  }

  // ── Input Parser ──────────────────────────────

  parseInput(input: string): { orders: ScheduledOrder[]; errors: string[] } {
    const orders: ScheduledOrder[] = [];
    const errors: string[] = [];
    const lines = input.trim().split('\n').map(l => l.trim().replace(/\s+/g, ' ')).filter(Boolean);

    for (let i = 0; i < lines.length; i++) {
      const parts = lines[i].split(' ');
      if (parts.length !== 2) { errors.push(`Baris ${i + 1}: format salah '${lines[i]}'`); continue; }
      const [timeStr, trendRaw] = parts;
      const trendUp = trendRaw.toUpperCase();
      if (!/^\d{1,2}[:.]\d{2}$/.test(timeStr)) { errors.push(`Baris ${i + 1}: jam tidak valid '${timeStr}'`); continue; }
      if (!['B', 'S', 'BUY', 'SELL', 'CALL', 'PUT'].includes(trendUp)) { errors.push(`Baris ${i + 1}: arah tidak valid '${trendRaw}'`); continue; }
      const trend = ['B', 'BUY', 'CALL'].includes(trendUp) ? 'call' : 'put';
      const [h, m] = timeStr.split(/[:.]/).map(Number);
      if (h < 0 || h > 23 || m < 0 || m > 59) { errors.push(`Baris ${i + 1}: waktu di luar rentang`); continue; }
      const timeInMillis = this.toJakartaMs(h, m);
      orders.push({
        id: uuidv4(),
        time: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
        trend: trend as any,
        timeInMillis,
        isExecuted: false, isSkipped: false,
        martingaleState: {
          isActive: false, currentStep: 0, maxSteps: 10,
          isCompleted: false, totalLoss: 0, totalRecovered: 0,
        },
      });
    }
    orders.sort((a, b) => a.timeInMillis - b.timeInMillis);
    return { orders, errors };
  }

  private toJakartaMs(hour: number, minute: number): number {
    const jakartaNow = new Date(Date.now() + JAKARTA_OFFSET_MS);
    const target = new Date(jakartaNow);
    target.setHours(hour, minute, 0, 0);
    let utcMs = target.getTime() - JAKARTA_OFFSET_MS;
    if (utcMs <= Date.now()) utcMs += 86400000;
    return utcMs;
  }

  // ── Firebase helpers ──────────────────────────

  private async updateStatus(userId: string, botState: string, sessionPnL?: number) {
    const extra: any = {};
    if (botState === 'RUNNING') extra.started_at = this.supabaseService.now();
    if (botState === 'STOPPED') {
      extra.stopped_at = this.supabaseService.now();
      if (sessionPnL !== undefined) extra.session_pnl = sessionPnL;
    }
    await this.supabaseService.client.from('schedule_status').upsert(
      { user_id: userId, bot_state: botState, updated_at: this.supabaseService.now(), ...extra },
    );
  }

  private async appendLog(userId: string, log: ExecutionLog) {
    await this.supabaseService.client.from('mode_logs').upsert({
      id: log.id,
      user_id: userId,
      mode: 'schedule',
      data: log,
      executed_at: this.supabaseService.timestampFromMillis(log.executedAt),
    });
  }

  private cleanup(userId: string) {
    // Bersihkan pending saves timer
    const pending = this.pendingOrdersSave.get(userId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingOrdersSave.delete(userId);
    }
    this.wsClients.get(userId)?.disconnect();
    this.wsClients.delete(userId);
    this.executors.delete(userId);
  }
}