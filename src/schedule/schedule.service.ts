import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';
import { AuthService } from '../auth/auth.service';
import { StockityWebSocketClient } from './websocket-client';
import { ScheduleExecutor, ExecutorCallbacks } from './schedule-executor';
import { UpdateScheduleConfigDto } from './dto/update-config.dto';
import { ScheduledOrder, ScheduleConfig, ExecutionLog, StockityAsset } from './types';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';

const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;
const BASE_URL = 'https://api.stockity.id';

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

  constructor(
    private readonly firebaseService: FirebaseService,
    private readonly authService: AuthService,
  ) {}

  async onModuleInit() {
    this.logger.log('ScheduleService init – restoring active sessions...');
    await this.restoreActiveSessions();
  }

  async onModuleDestroy() {
    for (const [, exec] of this.executors) exec.stop();
    for (const [, ws] of this.wsClients) ws.disconnect();
  }

  // ── Restore ──────────────────────────────────

  private async restoreActiveSessions() {
    try {
      const snap = await this.firebaseService.db
        .collection('schedule_status')
        .where('botState', 'in', ['RUNNING', 'PAUSED'])
        .get();
      for (const doc of snap.docs) {
        const userId = doc.id;
        const wasState = doc.data().botState;
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
      }
    } catch (err: any) {
      this.logger.error(`restoreActiveSessions error: ${err.message}`);
    }
  }

  // ── Asset Auto-fetch (sesuai Kotlin AssetManager) ─────────────────

  /**
   * Fetch daftar asset yang tersedia dari Stockity API menggunakan session user.
   * Identik dengan Kotlin AssetManager.fetchAssetsFromApi() + processAssets().
   *
   * Logika profit rate (sama persis dengan Kotlin):
   *  1. Cari di personal_user_payment_rates dengan trading_type === 'turbo'
   *  2. Fallback ke trading_tools_settings.ftt.user_statuses.vip.payment_rate_turbo
   *  3. Fallback ke trading_tools_settings.bo.payment_rate_turbo
   *  4. Fallback ke trading_tools_settings.payment_rate_turbo
   *  5. Jika semua null → aset tidak ditampilkan
   *
   * Result diurutkan descending berdasarkan profitRate.
   */
  async getAvailableAssets(userId: string): Promise<StockityAsset[]> {
    const session = await this.authService.getSession(userId);
    if (!session) throw new Error('Session tidak ditemukan');

    const headers = this.buildStockityHeaders(session);

    try {
      const resp = await axios.get(`${BASE_URL}/bo-assets/v6/assets?locale=id`, {
        headers,
        timeout: 15000,
      });

      const rawAssets: any[] = resp.data?.data?.assets || [];
      const processed: StockityAsset[] = [];

      for (const asset of rawAssets) {
        const ric: string = asset.ric;
        const name: string = asset.name;
        const assetType: number = asset.type;
        const typeName = TYPE_NAME_MAPPING[assetType] ?? `Type-${assetType}`;
        let iconUrl: string | null = asset.icon?.url ?? null;
        // Ensure icon URL is absolute
        if (iconUrl && !iconUrl.startsWith('http')) {
          iconUrl = `https://stockity.id${iconUrl.startsWith('/') ? '' : '/'}${iconUrl}`;
        }

        // Cari profit rate — identik dengan Kotlin processAssets()
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

        // Hanya tambahkan asset yang punya profit rate (sama dengan Kotlin)
        if (profitRate !== null) {
          processed.push({ ric, name, type: assetType, typeName, profitRate, iconUrl });
        }
      }

      // Urutkan descending berdasarkan profitRate (sama dengan Kotlin sortedByDescending)
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

    const doc = await this.firebaseService.db.collection('schedule_configs').doc(userId).get();
    if (doc.exists) {
      const d = doc.data() as any;
      const cfg: ScheduleConfig = {
        asset: d.asset || null,
        martingale: d.martingale || DEFAULT_CONFIG.martingale,
        isDemoAccount: d.isDemoAccount ?? true,
        currency: d.currency || 'IDR',
        currencyIso: d.currencyIso || 'IDR',
        stopLoss: d.stopLoss ?? 0,
        stopProfit: d.stopProfit ?? 0,
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

    // ✅ FIX: Strip class prototype (dari @Type() class-transformer) sebelum simpan ke Firestore.
    // Firestore menolak object dengan custom prototype (instance class seperti AssetConfigDto).
    const plainCfg = JSON.parse(JSON.stringify(cfg));

    await this.firebaseService.db.collection('schedule_configs').doc(userId).set(
      { ...plainCfg, updatedAt: this.firebaseService.FieldValue.serverTimestamp() },
      { merge: true },
    );
    this.executors.get(userId)?.updateConfig(cfg);
    return cfg;
  }

  // ── Orders ────────────────────────────────────

  async getOrders(userId: string): Promise<ScheduledOrder[]> {
    const exec = this.executors.get(userId);
    if (exec) return exec.getOrders();
    const doc = await this.firebaseService.db.collection('schedule_configs').doc(userId).get();
    if (doc.exists) return (doc.data() as any)?.orders || [];
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
      await this.saveOrders(userId, exec.getOrders());
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
      await this.saveOrders(userId, exec.getOrders());
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
    await this.firebaseService.db.collection('schedule_configs').doc(userId).set(
      { orders, updatedAt: this.firebaseService.FieldValue.serverTimestamp() },
      { merge: true },
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

    // Validasi: asset harus sudah dikonfigurasi
    if (!config.asset?.ric) {
      throw new Error(
        'Asset belum dikonfigurasi. ' +
        'Gunakan GET /schedule/assets untuk melihat daftar asset, ' +
        'lalu set melalui PUT /schedule/config.',
      );
    }

    const orders = await this.getOrders(userId);

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
      onOrdersUpdate: async (o) => { await this.saveOrders(userId, o).catch(() => {}); },
      onLog: async (log) => {
        const arr = this.logs.get(userId) || [];
        arr.push(log);
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
          // Update status to STOPPED first before cleanup
          await this.updateStatus(userId, 'STOPPED', sessionPnL);
          this.logger.log(`[${userId}] Status updated to STOPPED`);
          // Small delay to ensure Firestore propagation before cleanup
          await new Promise(r => setTimeout(r, 500));
        } catch (err: any) {
          this.logger.error(`[${userId}] Failed to update status: ${err.message}`);
        }
        // Cleanup after status update is confirmed
        this.cleanup(userId);
      },
      onStatusChange: (s) => this.logger.debug(`[${userId}] ${s}`),
    };

    const exec = new ScheduleExecutor(userId, ws, callbacks, orders, config);
    this.executors.set(userId, exec);
    exec.start();

    await this.updateStatus(userId, 'RUNNING');
    return { message: 'Schedule dimulai', status: exec.getStatus() };
  }

  async stopSchedule(userId: string) {
    const exec = this.executors.get(userId);
    if (!exec) return { message: 'Schedule tidak berjalan' };
    exec.stop();
    await this.saveOrders(userId, exec.getOrders());
    await this.updateStatus(userId, 'STOPPED');
    // Small delay to ensure Firestore propagation before cleanup
    await new Promise(r => setTimeout(r, 300));
    this.cleanup(userId);
    return { message: 'Schedule dihentikan' };
  }

  async pauseSchedule(userId: string) {
    const exec = this.executors.get(userId);
    if (!exec || exec.getBotState() !== 'RUNNING') return { message: 'Schedule tidak berjalan' };
    exec.pause();
    await this.updateStatus(userId, 'PAUSED');
    return { message: 'Schedule dijeda' };
  }

  async resumeSchedule(userId: string) {
    const exec = this.executors.get(userId);
    if (!exec || exec.getBotState() !== 'PAUSED') return { message: 'Schedule tidak dalam kondisi paused', status: {} };
    exec.resume();
    await this.updateStatus(userId, 'RUNNING');
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
    const statusDoc = await this.firebaseService.db.collection('schedule_status').doc(userId).get();
    const orders = await this.getOrders(userId);
    const statusData = statusDoc.exists ? statusDoc.data() : null;
    return {
      botState: statusData?.botState ?? 'STOPPED',
      totalOrders: orders.length,
      pendingOrders: orders.filter(o => !o.isExecuted && !o.isSkipped).length,
      executedOrders: orders.filter(o => o.isExecuted).length,
      skippedOrders: orders.filter(o => o.isSkipped).length,
      activeMartingaleOrderId: null,
      wsConnected: false,
      sessionPnL: statusData?.sessionPnL ?? 0,
      orders,
    };
  }

  async getLogs(userId: string, limit = 100): Promise<ExecutionLog[]> {
    const mem = this.logs.get(userId) || [];
    if (mem.length > 0) return mem.slice(-limit);
    const snap = await this.firebaseService.db
      .collection('schedule_logs').doc(userId)
      .collection('entries')
      .orderBy('executedAt', 'desc').limit(limit).get();
    // FIX: Firestore mengembalikan executedAt sebagai Timestamp object, bukan number.
    // Konversi ke millis agar frontend tidak menghasilkan "Invalid Date".
    return snap.docs.map(d => {
      const data = d.data() as any;
      return {
        ...data,
        executedAt: data.executedAt?.toMillis?.() ?? data.executedAt ?? 0,
      } as ExecutionLog;
    });
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
        martingaleState: { isActive: false, currentStep: 0, maxSteps: 10, isCompleted: false, totalLoss: 0, totalRecovered: 0 },
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
    if (botState === 'RUNNING') extra.startedAt = this.firebaseService.FieldValue.serverTimestamp();
    if (botState === 'STOPPED') {
      extra.stoppedAt = this.firebaseService.FieldValue.serverTimestamp();
      if (sessionPnL !== undefined) extra.sessionPnL = sessionPnL;
    }
    await this.firebaseService.db.collection('schedule_status').doc(userId).set(
      { botState, updatedAt: this.firebaseService.FieldValue.serverTimestamp(), ...extra },
      { merge: true },
    );
  }

  private async appendLog(userId: string, log: ExecutionLog) {
    await this.firebaseService.db
      .collection('schedule_logs').doc(userId)
      .collection('entries').doc(log.id)
      .set({ ...log, executedAt: this.firebaseService.Timestamp.fromMillis(log.executedAt) });
  }

  private cleanup(userId: string) {
    this.wsClients.get(userId)?.disconnect();
    this.wsClients.delete(userId);
    this.executors.delete(userId);
  }
}