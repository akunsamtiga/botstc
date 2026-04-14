import { Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { StockityWebSocketClient, DealResultPayload } from './websocket-client';
import {
  ScheduledOrder, ScheduleConfig, BotState,
  AlwaysSignalLossState, TradeOrderData,
  ExecutionLog, TrendType,
} from './types';

const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;
const EXECUTION_ADVANCE_MS = 200;  // Start execution 200ms earlier to compensate network latency
const PRECISION_CHECK_MS = 50;     // Check every 50ms for more responsive detection
const EXECUTION_WINDOW_MS = 4900;
const MARTINGALE_MAX_DURATION_MS = 600000;
const STEP_STUCK_THRESHOLD_MS = 150000;
const MIN_PREP_TIME_MS = 5000;      // Reduced from 10s for faster martingale execution
const MAX_RESULT_WAIT_MS = 120_000; // Reduced from 180s for faster result timeout

/**
 * Window fallback matching: identik dengan Kotlin isWebSocketTradeMatch
 *   timeMatch = System.currentTimeMillis() - executionInfo.executionTime < 120000L
 * INCREASED to 120s to ensure trades that take 60-120s to close can still be matched
 */
const FALLBACK_MATCH_WINDOW_MS = 120_000;

/**
 * Status terminal dari Stockity WebSocket.
 * Kotlin: statusMatch = status in listOf("won", "lost")
 * Kita tambahkan "draw" variants untuk kelengkapan.
 */
const TERMINAL_STATUSES = new Set(['won', 'win', 'lost', 'lose', 'loss', 'stand', 'draw', 'tie']);

export interface ExecutorCallbacks {
  onOrdersUpdate: (orders: ScheduledOrder[]) => void;
  onLog: (log: ExecutionLog) => void;
  onAllCompleted: () => void;
  onStatusChange: (status: string) => void;
  // Tracking callbacks
  onOrderExecuted?: (orderId: string, dealId: string, amount: number, estimatedCompletionTime: number) => Promise<void>;
  onMartingaleStep?: (orderId: string, step: number, amount: number, dealId?: string) => Promise<void>;
  onOrderCompleted?: (orderId: string, result: 'WIN' | 'LOSE' | 'DRAW', profit: number, sessionPnL: number) => Promise<void>;
  onOrderFailed?: (orderId: string, reason: string) => Promise<void>;
  onOrderSkipped?: (orderId: string, reason: string) => Promise<void>;
  onActiveMartingaleChange?: (martingaleInfo: {
    orderId: string;
    step: number;
    maxSteps: number;
    trend: TrendType;
    amount: number;
    startedAt: number;
  } | null) => Promise<void>;
}

/**
 * Info eksekusi per orderId untuk fallback matching.
 *
 * Root cause: Stockity pakai dua sistem ID berbeda:
 *   bo:opened  → numeric id (4643345638)  → activeDealId
 *   bo:closed  → UUID string (019d4ba9-)  → tidak pernah == activeDealId
 *
 * Solusi: fallback by amount + trend + time window (120s),
 * identik dengan Kotlin isWebSocketTradeMatch().
 */
interface ExecutionInfo {
  orderId: string;
  amount: number;
  trend: TrendType;
  executedAt: number;
  estimatedCompletionTime: number;
}

export class ScheduleExecutor {
  private readonly logger = new Logger('ScheduleExecutor');
  private botState: BotState = 'STOPPED';
  private orders: ScheduledOrder[];
  private config: ScheduleConfig;
  private activeMartingaleOrderId?: string;
  private martingaleStartTime?: number;
  private alwaysSignalLossState?: AlwaysSignalLossState;
  private monitoringTimer?: NodeJS.Timeout;
  private completionTimer?: NodeJS.Timeout;
  private lastCompletionCheck = 0;

  /** Map orderId → ExecutionInfo untuk fallback matching */
  private executionInfoMap = new Map<string, ExecutionInfo>();

  /**
   * Guard flag untuk mencegah duplikasi onAllCompleted callback
   * - Set ke true saat onAllCompleted pertama kali dipanggil
   - Reset saat start() atau cleanup()
   */
  private hasCompleted = false;

  /**
   * Akumulasi P&L sesi ini (dalam satuan currency terkecil).
   * Reset saat bot di-start ulang.
   * WIN  → +profit (amount * profitRate)
   * LOSE → -amount
   * DRAW → 0
   */
  private sessionPnL = 0;

  constructor(
    private readonly userId: string,
    private readonly wsClient: StockityWebSocketClient,
    private readonly callbacks: ExecutorCallbacks,
    initialOrders: ScheduledOrder[],
    initialConfig: ScheduleConfig,
  ) {
    this.orders = [...initialOrders];
    this.config = { ...initialConfig };
    this.wsClient.setOnDealResult((p) => this.handleDealResult(p));
  }

  // ── Public Control ──────────────────────────

  start() {
    if (this.botState === 'RUNNING') return;
    this.botState = 'RUNNING';
    this.hasCompleted = false;  // Reset completion flag
    this.alwaysSignalLossState = undefined;
    this.sessionPnL = 0;
    this.logger.log(`[${this.userId}] 🚀 Executor started | orders: ${this.orders.filter(o => !o.isExecuted && !o.isSkipped).length}`);
    this.startMonitoringLoop();
    this.startCompletionCheck();
  }

  pause() {
    if (this.botState !== 'RUNNING') return;
    this.botState = 'PAUSED';
    this.stopMonitoringLoop();
    this.logger.log(`[${this.userId}] ⏸️ Paused`);
  }

  resume() {
    if (this.botState !== 'PAUSED') return;
    this.botState = 'RUNNING';
    this.startMonitoringLoop();
    this.logger.log(`[${this.userId}] ▶️ Resumed`);
  }

  stop() {
    this.botState = 'STOPPED';
    this.stopMonitoringLoop();
    this.stopCompletionCheck();
    // Hapus semua order yang sudah dieksekusi (menunggu hasil atau stuck martingale)
    // Firestore hanya menyimpan order yang benar-benar belum jalan
    this.orders = this.orders.filter(o => !o.isExecuted);
    this.activeMartingaleOrderId = undefined;
    this.martingaleStartTime = undefined;
    this.alwaysSignalLossState = undefined;
    this.executionInfoMap.clear();
    this.sessionPnL = 0;
    this.callbacks.onOrdersUpdate(this.orders);
    // Notify tracking service
    this.callbacks.onActiveMartingaleChange?.(null).catch(() => {});
    this.logger.log(`[${this.userId}] ⏹️ Stopped`);
  }

  getBotState(): BotState { return this.botState; }
  getOrders(): ScheduledOrder[] { return [...this.orders]; }
  getActiveMartingaleOrderId() { return this.activeMartingaleOrderId; }
  getAlwaysSignalLossState() { return this.alwaysSignalLossState; }
  updateConfig(config: ScheduleConfig) { this.config = { ...config }; }

  addOrders(newOrders: ScheduledOrder[]): ScheduledOrder[] {
    const now = Date.now();
    const keys = new Set(this.orders.map(o => `${o.time}_${o.trend}`));
    const valid = newOrders.filter(o => {
      const t = o.timeInMillis - EXECUTION_ADVANCE_MS - now;
      return t >= MIN_PREP_TIME_MS && !keys.has(`${o.time}_${o.trend}`);
    });
    this.orders.push(...valid);
    this.orders.sort((a, b) => a.timeInMillis - b.timeInMillis);
    this.callbacks.onOrdersUpdate(this.orders);
    return valid;
  }

  removeOrder(orderId: string) {
    const before = this.orders.length;
    this.orders = this.orders.filter(o => o.id !== orderId);
    this.executionInfoMap.delete(orderId);
    if (this.activeMartingaleOrderId === orderId) {
      this.activeMartingaleOrderId = undefined;
      this.callbacks.onActiveMartingaleChange?.(null).catch(() => {});
    }
    if (this.orders.length !== before) this.callbacks.onOrdersUpdate(this.orders);
    if (this.orders.length === 0 && this.botState === 'RUNNING') {
      this.stop();
      this.callbacks.onAllCompleted();
    }
  }

  clearOrders() {
    this.orders = [];
    this.activeMartingaleOrderId = undefined;
    this.alwaysSignalLossState = undefined;
    this.executionInfoMap.clear();
    if (this.botState === 'RUNNING') this.stop();
    this.callbacks.onOrdersUpdate([]);
    this.callbacks.onActiveMartingaleChange?.(null).catch(() => {});
    this.callbacks.onAllCompleted();
  }

  // ── Monitoring Loop ──────────────────────────

  private startMonitoringLoop() {
    this.stopMonitoringLoop();
    this.monitoringTimer = setInterval(() => this.tick(), PRECISION_CHECK_MS);
  }

  private stopMonitoringLoop() {
    if (this.monitoringTimer) { clearInterval(this.monitoringTimer); this.monitoringTimer = undefined; }
  }

  private tick() {
    if (this.botState !== 'RUNNING') return;
    const now = Date.now();
    let changed = false;

    this.checkStuckMartingale(now);

    for (let i = 0; i < this.orders.length; i++) {
      const order = this.orders[i];
      if (order.isExecuted || order.isSkipped) continue;

      const target = order.timeInMillis - EXECUTION_ADVANCE_MS;
      const timeUntil = target - now;

      if (timeUntil < -EXECUTION_WINDOW_MS) {
        // Order kadaluarsa - skip dan notify tracking
        this.logger.warn(`[${this.userId}] ⏭️ Skipped expired: ${order.time} ${order.trend}`);
        this.orders[i] = { ...this.orders[i], isSkipped: true, skipReason: 'Expired' };
        this.callbacks.onOrderSkipped?.(order.id, 'Order expired').catch(() => {});
        changed = true;
        continue;
      }

      if (timeUntil <= 0 && timeUntil >= -EXECUTION_WINDOW_MS) {
        if (this.activeMartingaleOrderId && this.activeMartingaleOrderId !== order.id) {
          // Order bentrok dengan martingale aktif - skip dan notify tracking
          this.logger.warn(`[${this.userId}] ⏭️ Skipped (martingale aktif): ${order.time} ${order.trend}`);
          this.orders[i] = { ...this.orders[i], isSkipped: true, skipReason: 'Martingale conflict' };
          this.callbacks.onOrderSkipped?.(order.id, 'Conflict with active martingale').catch(() => {});
          changed = true;
          continue;
        }
        if (timeUntil < -2000) {
          this.logger.warn(`[${this.userId}] ⚠️ LATE EXECUTION ${order.time}: ${Math.abs(timeUntil)}ms`);
        }
        this.orders[i] = { ...order, isExecuted: true };
        changed = true;
        this.executeOrder(this.orders[i], true);
      }
    }

    if (changed) this.callbacks.onOrdersUpdate(this.orders);
  }

  // ── Trade Execution ──────────────────────────

  private async executeOrder(order: ScheduledOrder, isScheduledOrder = true) {
    const isAlways = this.config.martingale.isEnabled && this.config.martingale.isAlwaysSignal;
    const lossState = this.alwaysSignalLossState;
    const hasLoss = isAlways && lossState?.hasOutstandingLoss;
    const step = hasLoss ? lossState.currentMartingaleStep : 0;
    const amount = this.calcAmount(step);

    this.logger.log(`[${this.userId}] 🚀 Execute ${order.time} ${order.trend.toUpperCase()} amount=${amount} step=${step}`);

    let tradeData: TradeOrderData;
    try {
      tradeData = this.buildTradeOrder(order.trend, amount, true, order.timeInMillis);
    } catch (err: any) {
      this.logger.error(`[${this.userId}] ❌ Trade timing error: ${err.message}`);
      this.callbacks.onOrderFailed?.(order.id, `Timing error: ${err.message}`).catch(() => {});
      this.callbacks.onLog({
        id: uuidv4(), orderId: order.id, time: order.time,
        trend: order.trend, amount, martingaleStep: step,
        result: 'FAILED', executedAt: Date.now(),
        note: `Timing error: ${err.message}`,
        isDemoAccount: this.config.isDemoAccount,
      });
      return;
    }

    // Calculate estimated completion time for tracking
    const estimatedCompletionTime = tradeData.expireAt * 1000;

    const result = await this.wsClient.placeTrade(tradeData);
    const dealId = result.dealId;

    // Simpan execution info untuk fallback matching
    this.executionInfoMap.set(order.id, {
      orderId: order.id,
      amount,
      trend: order.trend,
      executedAt: Date.now(),
      estimatedCompletionTime,
    });

    // amount_min → stop bot, tidak ada gunanya retry
    if (result.error === 'amount_min') {
      this.logger.error(`[${this.userId}] ❌ Amount di bawah minimum Stockity — bot dihentikan`);
      this.callbacks.onStatusChange('Trade gagal: amount di bawah minimum Stockity. Cek konfigurasi.');
      this.executionInfoMap.delete(order.id);
      this.callbacks.onOrderFailed?.(order.id, 'Amount di bawah minimum Stockity').catch(() => {});
      this.callbacks.onLog({
        id: uuidv4(), orderId: order.id, time: order.time,
        trend: order.trend, amount, martingaleStep: step,
        result: 'FAILED', executedAt: Date.now(),
        note: 'Amount di bawah minimum Stockity',
        isDemoAccount: this.config.isDemoAccount,
      });
      setTimeout(async () => {
        this.stop();
        try {
          await this.callbacks.onAllCompleted();
        } catch (err: any) {
          this.logger.error(`[${this.userId}] ❌ onAllCompleted error: ${err.message}`);
        }
      }, 300);
      return;
    }

    if (dealId) {
      const idx = this.orders.findIndex(o => o.id === order.id);
      if (idx !== -1) {
        this.orders[idx] = { ...this.orders[idx], activeDealId: dealId };
        this.callbacks.onOrdersUpdate(this.orders);
      }
      // Notify tracking service
      await this.callbacks.onOrderExecuted?.(order.id, dealId, amount, estimatedCompletionTime).catch(() => {});
    } else if (result.error !== 'duplicate') {
      this.logger.error(`[${this.userId}] ❌ Trade failed for ${order.id}`);
      this.executionInfoMap.delete(order.id);
      this.callbacks.onOrderFailed?.(order.id, result.error || 'Trade failed').catch(() => {});
      if (isAlways) this.advanceAlwaysSignalLoss(order, step, amount);
    } else {
      this.logger.warn(`[${this.userId}] ⚠️ Duplicate deal ${order.id} — menunggu hasil via WS`);
      // Still notify tracking that order is being monitored
      await this.callbacks.onOrderExecuted?.(order.id, dealId || 'pending', amount, estimatedCompletionTime).catch(() => {});
    }

    this.callbacks.onLog({
      // ID deterministik: orderId + step → Firestore akan overwrite entry ini
      // saat completeOrder() dipanggil dengan ID yang sama, sehingga tidak ada duplikat.
      id: `${order.id}_s${step}`,
      orderId: order.id, time: order.time,
      trend: order.trend, amount, martingaleStep: step,
      dealId: dealId ?? undefined,
      result: (result.error && result.error !== 'duplicate') ? 'FAILED' : undefined,
      executedAt: Date.now(),
      note: result.error === 'duplicate' ? 'Duplicate deal — menunggu hasil via WS' : undefined,
      isDemoAccount: this.config.isDemoAccount,
    });
  }

  // ── Deal Result ──────────────────────────────

  /**
   * Menangani hasil trade dari WebSocket (closed / deal_result / close_deal_batch).
   *
   * bo:opened TIDAK masuk ke sini (di-filter di websocket-client.ts) — ini penting
   * agar bo:opened yang tidak punya status tidak trigger false-match via fallback.
   *
   * Matching strategy (3 lapis, Kotlin-compatible):
   *
   *  1. Exact activeDealId === payload.id
   *     (normal case jika Stockity konsisten mengirim id yang sama)
   *
   *  2. activeDealId === payload.uuid
   *     (cross-ref jika phx_reply resolve dengan uuid)
   *
   *  3. Fallback: amount + trend + time window 120s
   *     Identik dengan Kotlin isWebSocketTradeMatch():
   *       timeMatch  = elapsed < 120000ms
   *       amountMatch = amount == executionInfo.amount
   *       trendMatch  = trend.isEmpty() || trend == order.trend
   *       statusMatch = status in listOf("won","lost")   ← KRITIS: guard utama
   */
  private handleDealResult(payload: DealResultPayload) {
    const dealId = String(payload.id ?? '');
    if (!dealId) return;

    const s = (payload.status || payload.result || '').toLowerCase();

    // ── CRITICAL GUARD: statusMatch (Kotlin isWebSocketTradeMatch) ──────────
    // Bo:opened tidak punya status → tanpa guard ini, fallback matching
    // akan menganggap opened sebagai LOSS. Kotlin hanya proses
    // "closed"/"deal_result"/"trade_update" yang sudah punya status terminal.
    if (!TERMINAL_STATUSES.has(s)) {
      this.logger.debug(`[${this.userId}] handleDealResult: skip non-terminal status="${s}" dealId=${dealId}`);
      return;
    }

    const isWin  = s === 'won'  || s === 'win';
    const isDraw = s === 'stand' || s === 'draw' || s === 'tie';

    // ── Strategy 1: exact activeDealId match ──
    let orderIdx = this.orders.findIndex(o => o.activeDealId === dealId);

    // ── Strategy 2: UUID cross-reference ──
    if (orderIdx === -1 && payload.uuid && payload.uuid !== dealId) {
      orderIdx = this.orders.findIndex(o => o.activeDealId === payload.uuid);
      if (orderIdx !== -1) {
        this.logger.debug(`[${this.userId}] Match via UUID cross-ref: orderId=${this.orders[orderIdx].id}`);
      }
    }

    // ── Strategy 3: fallback by amount + trend + time window ──
    if (orderIdx === -1) {
      orderIdx = this.findOrderByExecutionInfo(payload);
      if (orderIdx !== -1) {
        const order = this.orders[orderIdx];
        this.logger.warn(
          `[${this.userId}] Fallback match ${order.time} ${order.trend} ` +
          `by amount=${payload.amount} trend=${payload.trend} ` +
          `(dealId=${dealId}, activeDealId=${order.activeDealId})`,
        );
        // Update activeDealId ke uuid agar log konsisten
        this.orders[orderIdx] = { ...this.orders[orderIdx], activeDealId: dealId };
      }
    }

    if (orderIdx === -1) {
      // Tidak ketemu — coba terapkan ke active martingale
      if (this.activeMartingaleOrderId) {
        const mIdx = this.orders.findIndex(o => o.id === this.activeMartingaleOrderId);
        if (mIdx !== -1) {
          this.logger.warn(`[${this.userId}] No order match, applying to active martingale: ${this.orders[mIdx].time}`);
          this.processMartingaleResult(mIdx, isWin, isDraw, dealId);
        }
      } else {
        this.logger.warn(
          `[${this.userId}] handleDealResult: no order found ` +
          `dealId=${dealId} uuid=${payload.uuid} amount=${payload.amount} status=${s}`,
        );
      }
      return;
    }

    const order = this.orders[orderIdx];
    this.executionInfoMap.delete(order.id);

    const isAlways  = this.config.martingale.isEnabled && this.config.martingale.isAlwaysSignal;
    const isRegular = this.config.martingale.isEnabled && !isAlways && this.config.martingale.maxSteps > 1;

    if (isDraw) {
      this.completeOrder(orderIdx, 'DRAW', dealId);
      return;
    }

    if (isWin) {
      if (isAlways) this.alwaysSignalLossState = undefined;
      if (this.activeMartingaleOrderId === order.id) {
        this.activeMartingaleOrderId = undefined;
        this.martingaleStartTime = undefined;
        this.callbacks.onActiveMartingaleChange?.(null).catch(() => {});
      }
      this.completeOrder(orderIdx, 'WIN', dealId);
    } else {
      if (isAlways) {
        const step = this.alwaysSignalLossState?.currentMartingaleStep ?? 0;
        this.advanceAlwaysSignalLoss(order, step, this.calcAmount(step));
        this.completeOrder(orderIdx, 'LOSE', dealId);
      } else if (isRegular) {
        // FIX: jika order sudah di tengah martingale (step > 0 dan isActive),
        // lanjutkan ke step berikutnya via processMartingaleResult.
        // Sebelumnya selalu memanggil startMartingale → reset ke step 1 → amount tidak naik.
        if (order.martingaleState.isActive && order.martingaleState.currentStep > 0) {
          this.processMartingaleResult(orderIdx, false, false, dealId);
        } else {
          this.startMartingale(order, orderIdx);
        }
      } else {
        this.completeOrder(orderIdx, 'LOSE', dealId);
      }
    }
  }

  /**
   * Fallback matching: Kotlin isWebSocketTradeMatch()
   *   timeMatch  = elapsed < 120_000ms
   *   amountMatch = payload.amount === info.amount
   *   trendMatch  = !payloadTrend || payloadTrend === info.trend
   *
   * statusMatch sudah dicheck di handleDealResult sebelum fungsi ini dipanggil.
   */
  private findOrderByExecutionInfo(payload: DealResultPayload): number {
    const payloadAmount = payload.amount;
    const payloadTrend  = payload.trend;   // 'call' | 'put' dari Stockity
    const now = Date.now();

    return this.orders.findIndex(o => {
      if (!o.isExecuted || o.isSkipped) return false;
      if (o.martingaleState.isCompleted) return false;

      const info = this.executionInfoMap.get(o.id);
      if (!info) return false;

      // timeMatch - INCREASED to 120s
      if (now - info.executedAt > FALLBACK_MATCH_WINDOW_MS) return false;

      // amountMatch
      if (payloadAmount !== undefined && info.amount !== payloadAmount) return false;

      // trendMatch (empty trend = any, sama dengan Kotlin)
      if (payloadTrend && info.trend !== payloadTrend) return false;

      return true;
    });
  }

  private processMartingaleResult(orderIdx: number, isWin: boolean, isDraw: boolean, dealId: string) {
    const order = this.orders[orderIdx];
    const step  = order.martingaleState.currentStep;
    const max   = this.config.martingale.maxSteps;

    if (isDraw) {
      this.activeMartingaleOrderId = undefined;
      this.martingaleStartTime = undefined;
      this.executionInfoMap.delete(order.id);
      this.callbacks.onActiveMartingaleChange?.(null).catch(() => {});
      this.completeOrder(orderIdx, 'DRAW', dealId);
      return;
    }
    if (isWin) {
      this.activeMartingaleOrderId = undefined;
      this.martingaleStartTime = undefined;
      this.executionInfoMap.delete(order.id);
      this.callbacks.onActiveMartingaleChange?.(null).catch(() => {});
      this.completeOrder(orderIdx, 'WIN', dealId);
    } else {
      if (step >= max) {
        this.activeMartingaleOrderId = undefined;
        this.martingaleStartTime = undefined;
        this.executionInfoMap.delete(order.id);
        this.callbacks.onActiveMartingaleChange?.(null).catch(() => {});
        this.completeOrder(orderIdx, 'LOSE', dealId);
      } else {
        const next = step + 1;
        this.updateMartingaleStep(orderIdx, next);
        this.placeMartingaleTrade(order, next, this.calcAmount(next));
        this.logger.log(`[${this.userId}] 🔄 Martingale step ${next}/${max}`);
      }
    }
  }

  private async placeMartingaleTrade(order: ScheduledOrder, step: number, amount: number) {
    // Update executionInfoMap untuk step martingale ini
    this.executionInfoMap.set(order.id, {
      orderId: order.id,
      amount,
      trend: order.trend,
      executedAt: Date.now(),
      estimatedCompletionTime: Date.now() + 60000, // Estimasi 60 detik
    });

    let tradeData: TradeOrderData;
    try {
      tradeData = this.buildTradeOrder(order.trend, amount, false);
    } catch (err: any) {
      this.logger.error(`[${this.userId}] ❌ Martingale timing error step ${step}: ${err.message}`);
      this.executionInfoMap.delete(order.id);
      this.callbacks.onLog({
        id: uuidv4(), orderId: order.id, time: order.time, trend: order.trend,
        amount, martingaleStep: step,
        result: 'FAILED', executedAt: Date.now(),
        note: `Martingale timing error step ${step}: ${err.message}`,
        isDemoAccount: this.config.isDemoAccount,
      });
      return;
    }

    const result = await this.wsClient.placeTrade(tradeData);
    const dealId = result.dealId;

    if (result.error === 'amount_min') {
      this.logger.error(`[${this.userId}] ❌ Martingale amount di bawah minimum — bot dihentikan`);
      this.callbacks.onStatusChange('Martingale gagal: amount di bawah minimum Stockity. Cek konfigurasi.');
      this.executionInfoMap.delete(order.id);
      this.activeMartingaleOrderId = undefined;
      this.martingaleStartTime = undefined;
      this.callbacks.onActiveMartingaleChange?.(null).catch(() => {});
      this.callbacks.onLog({
        id: uuidv4(), orderId: order.id, time: order.time, trend: order.trend,
        amount, martingaleStep: step,
        result: 'FAILED', executedAt: Date.now(),
        note: `Martingale step ${step}: amount di bawah minimum Stockity`,
        isDemoAccount: this.config.isDemoAccount,
      });
      setTimeout(async () => {
        this.stop();
        try {
          await this.callbacks.onAllCompleted();
        } catch (err: any) {
          this.logger.error(`[${this.userId}] ❌ onAllCompleted error: ${err.message}`);
        }
      }, 300);
      return;
    }

    if (dealId) {
      const idx = this.orders.findIndex(o => o.id === order.id);
      if (idx !== -1) {
        this.orders[idx] = { ...this.orders[idx], activeDealId: dealId };
        this.callbacks.onOrdersUpdate(this.orders);
      }
      // Notify tracking service
      await this.callbacks.onMartingaleStep?.(order.id, step, amount, dealId).catch(() => {});
    } else if (result.error !== 'duplicate') {
      this.executionInfoMap.delete(order.id);
    } else {
      this.logger.warn(`[${this.userId}] ⚠️ Duplicate martingale deal step ${step} — menunggu hasil via WS`);
      // Still notify tracking
      await this.callbacks.onMartingaleStep?.(order.id, step, amount, dealId || 'pending').catch(() => {});
    }

    this.callbacks.onLog({
      // ID deterministik per step martingale
      id: `${order.id}_s${step}`,
      orderId: order.id, time: order.time, trend: order.trend,
      amount, martingaleStep: step, dealId: dealId ?? undefined,
      result: (result.error && result.error !== 'duplicate') ? 'FAILED' : undefined,
      executedAt: Date.now(),
      note: result.error === 'duplicate'
        ? `Martingale step ${step}: duplicate deal — menunggu hasil via WS`
        : `Martingale step ${step}`,
      isDemoAccount: this.config.isDemoAccount,
    });
  }

  private startMartingale(order: ScheduledOrder, orderIdx: number) {
    this.activeMartingaleOrderId = order.id;
    this.martingaleStartTime = Date.now();
    const step = 1;
    this.updateMartingaleStep(orderIdx, step);
    this.placeMartingaleTrade(order, step, this.calcAmount(step));

    // Notify tracking service
    this.callbacks.onActiveMartingaleChange?.({
      orderId: order.id,
      step: 1,
      maxSteps: this.config.martingale.maxSteps,
      trend: order.trend,
      amount: this.calcAmount(1),
      startedAt: Date.now(),
    }).catch(() => {});
  }

  private updateMartingaleStep(orderIdx: number, step: number) {
    this.orders[orderIdx] = {
      ...this.orders[orderIdx],
      martingaleState: {
        ...this.orders[orderIdx].martingaleState,
        isActive: true, currentStep: step,
        lastUpdateTime: Date.now(), isCompleted: false,
      },
    };
    this.callbacks.onOrdersUpdate(this.orders);
  }

  private advanceAlwaysSignalLoss(order: ScheduledOrder, step: number, lossAmount: number) {
    const nextStep = step + 1;
    if (nextStep > this.config.martingale.maxSteps) {
      this.alwaysSignalLossState = undefined;
      return;
    }
    const prev = this.alwaysSignalLossState?.totalLoss ?? 0;
    this.alwaysSignalLossState = {
      hasOutstandingLoss: true,
      currentMartingaleStep: nextStep,
      originalOrderId: order.id,
      totalLoss: prev + lossAmount,
      currentTrend: order.trend,
    };
    this.logger.log(`[${this.userId}] 📊 AlwaysSignal step=${nextStep}/${this.config.martingale.maxSteps}`);
  }

  private completeOrder(orderIdx: number, result: 'WIN' | 'LOSE' | 'DRAW', dealId?: string) {
    const order = this.orders[orderIdx];
    const finalResult = result === 'WIN' ? 'WIN' : result === 'DRAW' ? 'DRAW' : 'LOSS';

    if (this.activeMartingaleOrderId === order.id) {
      this.activeMartingaleOrderId = undefined;
      this.martingaleStartTime = undefined;
      this.callbacks.onActiveMartingaleChange?.(null).catch(() => {});
    }

    const profitRate = (this.config.asset.profitRate ?? 85) / 100;
    let tradePnL = 0;
    if (result === 'WIN') {
      tradePnL = Math.floor(order.martingaleState.isActive
        ? this.calcAmount(order.martingaleState.currentStep) * profitRate
        : this.calcAmount(0) * profitRate);
    } else if (result === 'LOSE') {
      tradePnL = -(order.martingaleState.isActive
        ? this.calcAmount(order.martingaleState.currentStep)
        : this.calcAmount(0));
    }

    this.sessionPnL += tradePnL;

    this.logger.log(
      `[${this.userId}] ✅ ${order.time} ${order.trend} → ${result} ` +
      `| tradePnL=${tradePnL > 0 ? '+' : ''}${tradePnL} sessionPnL=${this.sessionPnL > 0 ? '+' : ''}${this.sessionPnL}`,
    );

    const resultStep = order.martingaleState.isActive ? order.martingaleState.currentStep : 0;
    const resultAmount = this.calcAmount(resultStep);

    // Emit log ke Firebase history (terpisah dari orders)
    this.callbacks.onLog({
      id: `${order.id}_s${resultStep}`,
      orderId: order.id,
      time: order.time,
      trend: order.trend,
      amount: resultAmount,
      martingaleStep: resultStep,
      dealId: dealId,
      result: finalResult,
      profit: tradePnL,
      sessionPnL: this.sessionPnL,
      executedAt: Date.now(),
      note: `Result: ${finalResult} | PnL: ${tradePnL > 0 ? '+' : ''}${tradePnL}`,
      isDemoAccount: this.config.isDemoAccount,
    });

    // Notify tracking service
    this.callbacks.onOrderCompleted?.(order.id, result, tradePnL, this.sessionPnL).catch(() => {});

    // Hapus dari active orders list (tapi sudah di-track)
    // Firestore hanya menyimpan order yang BELUM selesai untuk eksekusi
    this.orders.splice(orderIdx, 1);
    this.callbacks.onOrdersUpdate(this.orders);

    this.checkStopConditions();
  }

  /**
   * Cek Stop Loss dan Stop Profit setelah setiap trade selesai.
   * Dipanggil oleh completeOrder().
   */
  private checkStopConditions() {
    const { stopLoss, stopProfit } = this.config;
    const pnl = this.sessionPnL;

    // Stop Loss: totalLoss >= stopLoss (pnl negatif)
    if (stopLoss && stopLoss > 0 && pnl <= -stopLoss) {
      this.logger.warn(
        `[${this.userId}] 🛑 STOP LOSS triggered! ` +
        `sessionPnL=${pnl} <= -${stopLoss} — bot berhenti`,
      );
      this.callbacks.onStatusChange(`Stop Loss triggered (PnL: ${pnl})`);
      setTimeout(async () => {
        this.stop();
        try {
          // Guard: hanya panggil onAllCompleted sekali
          if (!this.hasCompleted) {
            this.hasCompleted = true;
            await this.callbacks.onAllCompleted();
          }
        } catch (err: any) {
          this.logger.error(`[${this.userId}] ❌ onAllCompleted error: ${err.message}`);
        }
      }, 1000);
      return;
    }

    // Stop Profit: totalProfit >= stopProfit (pnl positif)
    if (stopProfit && stopProfit > 0 && pnl >= stopProfit) {
      this.logger.log(
        `[${this.userId}] 🎯 STOP PROFIT triggered! ` +
        `sessionPnL=${pnl} >= ${stopProfit} — bot berhenti`,
      );
      this.callbacks.onStatusChange(`Stop Profit triggered (PnL: +${pnl})`);
      setTimeout(async () => {
        this.stop();
        try {
          // Guard: hanya panggil onAllCompleted sekali
          if (!this.hasCompleted) {
            this.hasCompleted = true;
            await this.callbacks.onAllCompleted();
          }
        } catch (err: any) {
          this.logger.error(`[${this.userId}] ❌ onAllCompleted error: ${err.message}`);
        }
      }, 1000);
    }
  }

  // ── Stuck Martingale Cleanup ──────────────────

  private checkStuckMartingale(now: number) {
    if (!this.activeMartingaleOrderId) return;
    const idx = this.orders.findIndex(o => o.id === this.activeMartingaleOrderId);
    if (idx === -1) {
      this.activeMartingaleOrderId = undefined;
      this.martingaleStartTime = undefined;
      this.callbacks.onActiveMartingaleChange?.(null).catch(() => {});
      return;
    }
    const o = this.orders[idx];
    const dur      = this.martingaleStartTime ? now - this.martingaleStartTime : 0;
    const stepDur  = o.martingaleState.lastUpdateTime ? now - o.martingaleState.lastUpdateTime : 0;
    if (dur > MARTINGALE_MAX_DURATION_MS || stepDur > STEP_STUCK_THRESHOLD_MS || o.martingaleState.isCompleted) {
      this.logger.warn(`[${this.userId}] ⚠️ Force-complete stuck martingale (dur=${dur}ms stepDur=${stepDur}ms)`);
      this.orders[idx] = {
        ...o,
        martingaleState: {
          ...o.martingaleState,
          isActive: false, isCompleted: true,
          finalResult: 'FAILED',
          failureReason: dur > MARTINGALE_MAX_DURATION_MS
            ? `Timeout: ${dur / 1000}s`
            : stepDur > STEP_STUCK_THRESHOLD_MS
              ? `Step stuck: ${stepDur / 1000}s at step ${o.martingaleState.currentStep}`
              : 'Inconsistent state',
        },
      };
      this.activeMartingaleOrderId = undefined;
      this.martingaleStartTime = undefined;
      this.executionInfoMap.delete(o.id);
      this.callbacks.onActiveMartingaleChange?.(null).catch(() => {});
      this.callbacks.onOrderFailed?.(o.id, 'Martingale timeout/stuck').catch(() => {});
      this.callbacks.onOrdersUpdate(this.orders);
    }
  }

  // ── Completion Check ──────────────────────────

  private startCompletionCheck() {
    this.stopCompletionCheck();
    this.completionTimer = setInterval(() => this.checkCompletion(), 2000);  // Check every 2s for faster response
  }

  private stopCompletionCheck() {
    if (this.completionTimer) { clearInterval(this.completionTimer); this.completionTimer = undefined; }
  }

  private checkCompletion() {
    if (this.botState !== 'RUNNING') return;
    const now = Date.now();
    if (now - this.lastCompletionCheck < 2000) return;
    this.lastCompletionCheck = now;

    // Dengan pendekatan hapus-langsung:
    //   pending  = order yang belum dieksekusi sama sekali (!isExecuted)
    //   awaiting = order yang sudah dieksekusi tapi belum dapat hasil WS (isExecuted, masih di list)
    const hasPending = this.orders.some(o => !o.isExecuted);

    // Cek awaiting + tangani timeout
    const timedOut: string[] = [];
    let hasAwaiting = false;
    for (const o of this.orders) {
      if (!o.isExecuted) continue;
      const info = this.executionInfoMap.get(o.id);
      const waitedMs = now - (info?.executedAt ?? o.timeInMillis);
      if (waitedMs > MAX_RESULT_WAIT_MS) {
        this.logger.warn(
          `[${this.userId}] ⚠️ Result timeout ${o.time} (${Math.round(waitedMs / 1000)}s) — force remove`,
        );
        this.executionInfoMap.delete(o.id);
        this.callbacks.onOrderFailed?.(o.id, 'Result timeout').catch(() => {});
        timedOut.push(o.id);
      } else {
        hasAwaiting = true;
      }
    }
    if (timedOut.length > 0) {
      this.orders = this.orders.filter(o => !timedOut.includes(o.id));
      this.callbacks.onOrdersUpdate(this.orders);
    }

    if (!hasPending && !hasAwaiting && !this.activeMartingaleOrderId && this.orders.length === 0) {
      this.logger.log(`[${this.userId}] ✅ All schedules completed`);
      setTimeout(async () => {
        this.stop();
        try {
          if (!this.hasCompleted) {
            this.hasCompleted = true;
            await this.callbacks.onAllCompleted();
          }
        } catch (err: any) {
          this.logger.error(`[${this.userId}] ❌ onAllCompleted error: ${err.message}`);
        }
      }, 3000);
    }
  }

  // ── Trade Builder ──────────────────────────────

  private buildTradeOrder(trend: TrendType, amount: number, isScheduledOrder: boolean, scheduledTimeMs?: number): TradeOrderData {
    const baseMs          = isScheduledOrder && scheduledTimeMs ? scheduledTimeMs : Date.now();
    const nowFloorSeconds = Math.floor(baseMs / 1000);
    const createdAtSeconds = isScheduledOrder ? nowFloorSeconds : nowFloorSeconds + 1;
    const secondsInMinute  = createdAtSeconds % 60;

    let finalExpireAt: number;

    if (isScheduledOrder) {
      // Scheduled: expire di boundary menit jadwal (secondsInMinute selalu 0)
      let expireAtSeconds: number;
      if (secondsInMinute <= 10) {
        expireAtSeconds = createdAtSeconds + (60 - secondsInMinute);
      } else {
        expireAtSeconds = createdAtSeconds + (120 - secondsInMinute);
      }
      const duration = expireAtSeconds - createdAtSeconds;
      finalExpireAt = (duration < 55 || duration > 120) ? createdAtSeconds + 60 : expireAtSeconds;

    } else {
      // Martingale/instant: NEAREST minute boundary dengan min 45s.
      // Tujuan: expire SECEPAT MUNGKIN setelah result, bukan nunggu boundary 120s.
      //
      // remainingInMinute = detik tersisa sampai boundary menit ini
      // >= 45s → pakai boundary menit ini (terpendek valid)
      //  < 45s → pakai boundary menit berikutnya
      //
      // Contoh result di :00 → createdAt :01 → remaining=59s >= 45 → expire di :00 (59s)
      // Contoh result di :20 → createdAt :21 → remaining=39s  < 45 → expire di :00+60 (99s)
      const remainingInMinute = 60 - secondsInMinute;
      finalExpireAt = remainingInMinute >= 45
        ? createdAtSeconds + remainingInMinute        // boundary menit ini
        : createdAtSeconds + remainingInMinute + 60;  // boundary menit berikutnya
    }

    const finalDuration = finalExpireAt - createdAtSeconds;

    this.logger.debug(
      `[${this.userId}] Trade timing | scheduled=${isScheduledOrder} ` +
      `createdAt=${createdAtSeconds} expireAt=${finalExpireAt} duration=${finalDuration}s ` +
      `secondsInMinute=${secondsInMinute}`,
    );

    if (finalDuration < 45) throw new Error(`Duration terlalu pendek: ${finalDuration}s (min 45s)`);
    if (finalDuration > 125) throw new Error(`Duration terlalu panjang: ${finalDuration}s (max 125s)`);
    if (finalExpireAt <= createdAtSeconds) throw new Error(`expire_at tidak valid: ${finalExpireAt} <= ${createdAtSeconds}`);

    return {
      amount,
      createdAt: createdAtSeconds * 1000,
      dealType: this.config.isDemoAccount ? 'demo' : 'real',
      expireAt: finalExpireAt,
      iso: this.config.currencyIso,
      optionType: 'turbo',
      ric: this.config.asset.ric,
      trend,
    };
  }

  private calcAmount(step: number): number {
    const m = this.config.martingale;
    if (!m.isEnabled || step === 0) return m.baseAmount;
    if (m.multiplierType === 'FIXED') return Math.floor(m.baseAmount * Math.pow(m.multiplierValue, step));
    const mult = 1 + m.multiplierValue / 100;
    return Math.floor(m.baseAmount * Math.pow(mult, step));
  }

  getStatus(): object {
    const pending = this.orders.filter(o => !o.isExecuted);
    const awaiting = this.orders.filter(o => o.isExecuted);
    const next    = [...pending].sort((a, b) => a.timeInMillis - b.timeInMillis)[0];
    const now     = Date.now();
    return {
      botState: this.botState,
      totalOrders: this.orders.length,
      pendingOrders: pending.length,
      awaitingOrders: awaiting.length,
      executedOrders: 0,   // completed orders dihapus dari list — lihat di history logs
      skippedOrders: 0,
      activeMartingaleOrderId: this.activeMartingaleOrderId ?? null,
      alwaysSignalActive: !!this.alwaysSignalLossState?.hasOutstandingLoss,
      alwaysSignalStep: this.alwaysSignalLossState?.currentMartingaleStep ?? 0,
      nextOrderTime: next?.time ?? null,
      nextOrderInSeconds: next ? Math.max(0, Math.floor((next.timeInMillis - EXECUTION_ADVANCE_MS - now) / 1000)) : null,
      wsConnected: this.wsClient.isConnected(),
      sessionPnL: this.sessionPnL,
      stopLoss: this.config.stopLoss ?? 0,
      stopProfit: this.config.stopProfit ?? 0,
    };
  }
}