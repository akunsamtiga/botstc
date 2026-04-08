import { Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { curlGet } from '../common/http-utils';
import { StockityWebSocketClient, DealResultPayload } from '../schedule/websocket-client';
import {
  FastradeConfig, FastradeLog, FastradeOrder, TrendType, FastradeTradeOrder,
} from './fastrade-types';

const BASE_URL = 'https://api.stockity.id';
const MAX_PRICE_FETCH_TIME = 5; // seconds for curl timeout
const FALLBACK_MATCH_WINDOW_MS = 120_000;
const TERMINAL_STATUSES = new Set(['won', 'win', 'lost', 'lose', 'loss', 'stand', 'draw', 'tie']);

export interface FastradeExecutorCallbacks {
  onLog: (log: FastradeLog) => void;
  onStatusChange: (status: string) => void;
  onStopped: () => void;
}

export interface SessionInfo {
  stockityToken: string;
  deviceId: string;
  deviceType: string;
  userAgent: string;
  userTimezone?: string;
}

export abstract class FastradeBaseExecutor {
  protected logger: Logger;

  // ── State ──────────────────────────────────────────
  protected isRunning = false;
  protected cycleNumber = 0;
  protected currentTrend?: TrendType;
  protected sessionPnL = 0;
  protected totalWins = 0;
  protected totalLosses = 0;
  protected totalTrades = 0;

  // ── Active order tracking ──────────────────────────
  protected activeOrder?: FastradeOrder;
  protected executionTime?: number;

  // ── Martingale state ───────────────────────────────
  protected martingaleStep = 0;
  protected martingaleActive = false;
  protected martingaleTotalLoss = 0;

  // ── Timers ─────────────────────────────────────────
  protected resultTimeoutTimer?: NodeJS.Timeout;

  // ── Interruptible sleep ─────────────────────────────
  // Allows stop() to immediately cancel any active sleep(), so the executor
  // doesn't hang for up to 60s waiting for a minute boundary after stop is called.
  private _sleepTimer?: NodeJS.Timeout;
  private _sleepResolve?: () => void;

  constructor(
    protected readonly userId: string,
    protected readonly wsClient: StockityWebSocketClient,
    protected readonly config: FastradeConfig,
    protected readonly session: SessionInfo,
    protected readonly callbacks: FastradeExecutorCallbacks,
  ) {
    this.logger = new Logger(this.constructor.name);
    // Register deal result handler on WS
    this.wsClient.setOnDealResult((p) => this.handleDealResult(p));
  }

  // ── Lifecycle ──────────────────────────────────────

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.sessionPnL = 0;
    this.totalWins = 0;
    this.totalLosses = 0;
    this.totalTrades = 0;
    this.cycleNumber = 0;
    this.activeOrder = undefined;
    this.executionTime = undefined;
    this.resetMartingale();
    this.logger.log(`[${this.userId}] ▶️ Starting`);
    this.startNewCycle();
  }

  stop() {
    if (!this.isRunning && !this.activeOrder) return;
    this.isRunning = false;
    this.clearResultTimeout();
    this.wakeUp();           // FIX: interrupt any active sleep() immediately
    this.activeOrder = undefined;
    this.executionTime = undefined;
    this.resetMartingale();
    this.logger.log(`[${this.userId}] ⏹️ Stopped`);
    this.callbacks.onStopped();
  }

  isActive(): boolean { return this.isRunning; }

  // ── Abstract methods (subclass implements) ─────────
  protected abstract startNewCycle(): void;
  protected abstract onWin(order: FastradeOrder): void;
  protected abstract onLose(order: FastradeOrder): void;
  protected abstract onDraw(order: FastradeOrder): void;

  // ── Candle price fetch ─────────────────────────────

  /**
   * Fetches the latest candle close price from Stockity API using curl.
   * Mirrors Kotlin fetchPriceDataWithPreWarming() + parseCandleResponse().
   * Returns the close price of the last candle, or null on failure.
   */
  protected async fetchCandleClosePrice(): Promise<number | null> {
    try {
      const utcDate = new Date();
      const dateStr = this.formatApiDate(utcDate);
      const encodedSymbol = encodeURIComponent(this.config.asset.ric);

      const response = await curlGet(
        `${BASE_URL}/candles/v1/${encodedSymbol}/${dateStr}/5`,
        {
          'authorization-token': this.session.stockityToken,
          'device-id': this.session.deviceId,
          'device-type': this.session.deviceType,
          'User-Agent': this.session.userAgent,
          'user-timezone': this.session.userTimezone ?? 'Asia/Bangkok',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'id-ID,id;q=0.9',
          'Origin': 'https://stockity.id',
          'Referer': 'https://stockity.id/',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        },
        MAX_PRICE_FETCH_TIME,
      );

      if (!response.data?.data) return null;

      const candles: any[] = response.data.data;
      if (!candles || candles.length === 0) return null;

      // Sort by created_at asc, take last candle close price
      const sorted = [...candles].sort((a, b) =>
        (a.created_at as string).localeCompare(b.created_at as string),
      );
      const last = sorted[sorted.length - 1];
      const closePrice = parseFloat(last.close);
      return isNaN(closePrice) ? null : closePrice;

    } catch (err: any) {
      this.logger.error(`[${this.userId}] fetchCandleClosePrice error: ${err.message}`);
      return null;
    }
  }

  /**
   * Compares two close prices and returns trend direction.
   * FTT: returns null if equal (triggers cycle restart).
   * CTC overrides this to return 'put' on equal.
   */
  protected determineTrend(price1: number, price2: number): TrendType | null {
    if (price2 > price1) return 'call';
    if (price2 < price1) return 'put';
    return null; // Equal → subclass decides behavior
  }

  protected reverseTrend(trend: TrendType): TrendType {
    return trend === 'call' ? 'put' : 'call';
  }

  // ── Time utilities ─────────────────────────────────

  /**
   * Returns the Unix ms timestamp of the next minute boundary.
   * E.g. if now is 12:34:42.500, returns 12:35:00.000
   */
  protected getNextMinuteBoundary(): number {
    const now = Date.now();
    const msIntoMinute = now % 60_000;
    return now + (60_000 - msIntoMinute);
  }

  /**
   * Formats date as "yyyy-MM-ddTHH:00:00" in UTC — Stockity candle API format.
   * Mirrors Kotlin apiDateFormat.
   */
  protected formatApiDate(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return (
      `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
      `T${pad(date.getUTCHours())}:00:00`
    );
  }

  // ── Trade execution ────────────────────────────────

  /**
   * Builds and places an instant (non-scheduled) trade via WebSocket.
   * Returns the created FastradeOrder, or null if placement failed.
   */
  protected async executeTrade(
    trend: TrendType,
    amount: number,
    martingaleStep: number,
    cycleNum: number,
  ): Promise<FastradeOrder | null> {
    const orderId = uuidv4();
    const now = Date.now();

    let tradeData: FastradeTradeOrder;
    try {
      tradeData = this.buildInstantTrade(trend, amount);
    } catch (err: any) {
      this.logger.error(`[${this.userId}] Trade build error: ${err.message}`);
      this.callbacks.onLog({
        id: uuidv4(), orderId, trend, amount, martingaleStep,
        result: 'FAILED', executedAt: now, cycleNumber: cycleNum,
        note: `Build error: ${err.message}`,
        isDemoAccount: this.config.isDemoAccount,
      });
      return null;
    }

    const result = await this.wsClient.placeTrade(tradeData as any);

    // ── Handle permanent errors — stop bot immediately ───────────────
    if (result.error === 'amount_min') {
      this.logger.error(
        `[${this.userId}] ❌ Amount ${amount} di bawah minimum Stockity — bot dihentikan`,
      );
      this.callbacks.onLog({
        id: uuidv4(), orderId, trend, amount, martingaleStep,
        result: 'FAILED', executedAt: now, cycleNumber: cycleNum,
        note: 'Trade gagal: amount di bawah minimum Stockity. Cek konfigurasi.',
        isDemoAccount: this.config.isDemoAccount,
      });
      this.callbacks.onStatusChange(
        `❌ Amount ${amount} di bawah minimum Stockity — bot dihentikan. Cek konfigurasi.`,
      );
      setTimeout(() => this.stop(), 300);
      return null;
    }

    // ── Handle duplicate — trade sudah masuk, lanjut tanpa dealId ────
    if (result.error === 'duplicate') {
      this.logger.warn(
        `[${this.userId}] ⚠️ Duplicate deal — trade probably went through, tracking without dealId`,
      );
      // Lanjut dengan dealId null, fallback match akan handle result dari WS
    }

    const dealId = result.dealId ?? null;

    const order: FastradeOrder = {
      id: orderId,
      trend,
      amount,
      executedAt: now,
      dealId: dealId ?? undefined,
      martingaleStep,
      isMartingale: martingaleStep > 0,
      cycleNumber: cycleNum,
    };

    this.callbacks.onLog({
      // ID deterministik: orderId + step → Firestore akan overwrite entry ini
      // saat handleDealResult() emit result log dengan ID yang sama.
      id: `${orderId}_s${martingaleStep}`,
      orderId, trend, amount, martingaleStep,
      dealId: dealId ?? undefined,
      result: (result.error && result.error !== 'duplicate') ? 'FAILED' : undefined,
      executedAt: now,
      cycleNumber: cycleNum,
      note: result.error === 'duplicate'
        ? 'Duplicate deal — menunggu hasil via WS'
        : (!dealId ? 'Trade gagal: WS tidak merespons' : undefined),
      isDemoAccount: this.config.isDemoAccount,
    });

    // Jika error non-duplicate dan tidak ada dealId, return null (gagal)
    if (!dealId && result.error !== 'duplicate') return null;

    this.executionTime = now;
    return order;
  }

  /**
   * Builds instant trade timing — identical to ScheduleExecutor.buildTradeOrder(isScheduledOrder=false).
   * Uses nearest minute boundary with min 45s rule.
   */
  protected buildInstantTrade(trend: TrendType, amount: number): FastradeTradeOrder {
    const nowMs = Date.now();
    const createdAtSeconds = Math.floor(nowMs / 1000) + 1;
    const secondsInMinute = createdAtSeconds % 60;
    const remainingInMinute = 60 - secondsInMinute;

    // Nearest minute boundary with min 45s (Kotlin: isScheduledOrder=false branch)
    const expireAt =
      remainingInMinute >= 45
        ? createdAtSeconds + remainingInMinute        // this minute boundary
        : createdAtSeconds + remainingInMinute + 60; // next minute boundary

    const duration = expireAt - createdAtSeconds;
    if (duration < 45) throw new Error(`Duration terlalu pendek: ${duration}s (min 45s)`);
    if (duration > 125) throw new Error(`Duration terlalu panjang: ${duration}s (max 125s)`);
    if (expireAt <= createdAtSeconds) throw new Error(`expireAt tidak valid`);

    return {
      amount,
      createdAt: createdAtSeconds * 1000,
      dealType: this.config.isDemoAccount ? 'demo' : 'real',
      expireAt,
      iso: this.config.currencyIso,
      optionType: 'turbo',
      ric: this.config.asset.ric,
      trend,
    };
  }

  // ── Martingale ─────────────────────────────────────

  /**
   * Calculates trade amount for a given martingale step.
   * Identical to ScheduleExecutor.calcAmount().
   */
  protected calcAmount(step: number): number {
    const m = this.config.martingale;
    if (!m.isEnabled || step === 0) return m.baseAmount;
    if (m.multiplierType === 'FIXED') {
      return Math.floor(m.baseAmount * Math.pow(m.multiplierValue, step));
    }
    const mult = 1 + m.multiplierValue / 100;
    return Math.floor(m.baseAmount * Math.pow(mult, step));
  }

  protected resetMartingale() {
    this.martingaleStep = 0;
    this.martingaleActive = false;
    this.martingaleTotalLoss = 0;
  }

  // ── Deal result handler ────────────────────────────

  /**
   * Handles incoming WebSocket deal results.
   * Uses 3-layer matching identical to ScheduleExecutor.handleDealResult():
   *   1. Exact dealId match
   *   2. UUID cross-reference
   *   3. Fallback: amount + trend + 120s window (Kotlin isWebSocketTradeMatch)
   */
  protected handleDealResult(payload: DealResultPayload) {
    const s = (payload.status || payload.result || '').toLowerCase();

    // Critical guard: statusMatch — only process terminal statuses (Kotlin pattern)
    if (!TERMINAL_STATUSES.has(s)) {
      this.logger.debug(`[${this.userId}] Skip non-terminal status="${s}"`);
      return;
    }

    const active = this.activeOrder;
    if (!active) return;

    const dealId = String(payload.id ?? '');
    const isWin  = s === 'won' || s === 'win';
    const isDraw = s === 'stand' || s === 'draw' || s === 'tie';

    // Strategy 1: exact dealId
    let isMatch = active.dealId === dealId;

    // Strategy 2: UUID cross-reference
    if (!isMatch && payload.uuid && payload.uuid !== dealId) {
      isMatch = active.dealId === payload.uuid;
      if (isMatch) this.logger.debug(`[${this.userId}] Match via UUID cross-ref`);
    }

    // Strategy 3: fallback (amount + trend + 120s window)
    if (!isMatch) {
      isMatch = this.isFallbackMatch(payload, active);
      if (isMatch) {
        this.logger.warn(
          `[${this.userId}] ⚠️ Fallback match: trend=${active.trend} amount=${active.amount} ` +
          `elapsed=${this.executionTime ? Date.now() - this.executionTime : '?'}ms`,
        );
      }
    }

    if (!isMatch) return;

    this.clearResultTimeout();

    const result = isWin ? 'WIN' : isDraw ? 'DRAW' : 'LOSE';
    const profitRate = (this.config.asset.profitRate ?? 85) / 100;
    let tradePnL = 0;
    if (isWin) tradePnL = Math.floor(active.amount * profitRate);
    else if (!isDraw) tradePnL = -active.amount;
    this.sessionPnL += tradePnL;

    this.totalTrades++;
    if (isWin) this.totalWins++;
    else if (!isDraw) this.totalLosses++;

    this.logger.log(
      `[${this.userId}] ✅ ${result} | amount=${active.amount} step=${active.martingaleStep} ` +
      `tradePnL=${tradePnL >= 0 ? '+' : ''}${tradePnL} sessionPnL=${this.sessionPnL >= 0 ? '+' : ''}${this.sessionPnL}`,
    );

    this.callbacks.onLog({
      // Pakai ID yang sama dengan execution log → Firestore overwrite entry lama
      // sehingga tidak ada 2 baris untuk 1 trade.
      id: `${active.id}_s${active.martingaleStep}`,
      orderId: active.id,
      trend: active.trend,
      amount: active.amount,
      martingaleStep: active.martingaleStep,
      dealId: dealId || active.dealId,
      result,
      profit: tradePnL,
      sessionPnL: this.sessionPnL,
      executedAt: Date.now(),
      cycleNumber: active.cycleNumber,
      isDemoAccount: this.config.isDemoAccount,
    });

    const completedOrder: FastradeOrder = { ...active, result: result as any, dealId: dealId || active.dealId };
    this.activeOrder = undefined;
    this.executionTime = undefined;

    if (!this.isRunning) return;

    // Check stop conditions before routing result
    if (this.checkStopConditions()) return;

    if (isWin) this.onWin(completedOrder);
    else if (isDraw) this.onDraw(completedOrder);
    else this.onLose(completedOrder);
  }

  /**
   * Fallback matching identical to Kotlin isWebSocketTradeMatch():
   *   timeMatch  = elapsed < 120_000ms
   *   amountMatch = payload.amount == info.amount
   *   trendMatch  = !payloadTrend || payloadTrend == order.trend
   */
  protected isFallbackMatch(payload: DealResultPayload, order: FastradeOrder): boolean {
    if (!this.executionTime) return false;
    const elapsed = Date.now() - this.executionTime;
    if (elapsed > FALLBACK_MATCH_WINDOW_MS) return false;
    if (payload.amount !== undefined && payload.amount !== order.amount) return false;
    if (payload.trend && payload.trend !== order.trend) return false;
    return true;
  }

  // ── Stop conditions ────────────────────────────────

  protected checkStopConditions(): boolean {
    const { stopLoss, stopProfit } = this.config;

    if (stopLoss && stopLoss > 0 && this.sessionPnL <= -stopLoss) {
      this.logger.warn(`[${this.userId}] 🛑 Stop Loss triggered! sessionPnL=${this.sessionPnL}`);
      this.callbacks.onStatusChange(`Stop Loss triggered (PnL: ${this.sessionPnL})`);
      setTimeout(() => this.stop(), 300);
      return true;
    }

    if (stopProfit && stopProfit > 0 && this.sessionPnL >= stopProfit) {
      this.logger.log(`[${this.userId}] 🎯 Stop Profit triggered! sessionPnL=${this.sessionPnL}`);
      this.callbacks.onStatusChange(`Stop Profit triggered (PnL: +${this.sessionPnL})`);
      setTimeout(() => this.stop(), 300);
      return true;
    }

    return false;
  }

  // ── Result timeout ─────────────────────────────────

  protected startResultTimeout(orderId: string, timeoutMs = 180_000) {
    this.clearResultTimeout();
    this.resultTimeoutTimer = setTimeout(() => {
      if (this.activeOrder?.id !== orderId) return;
      this.logger.warn(`[${this.userId}] ⚠️ Result timeout for order ${orderId} — treating as LOSE`);
      const timedOut = this.activeOrder!;
      this.activeOrder = undefined;
      this.executionTime = undefined;
      if (this.isRunning) this.onLose(timedOut);
    }, timeoutMs);
  }

  protected clearResultTimeout() {
    if (this.resultTimeoutTimer) {
      clearTimeout(this.resultTimeoutTimer);
      this.resultTimeoutTimer = undefined;
    }
  }

  // ── Status ─────────────────────────────────────────

  getStatus() {
    return {
      isRunning: this.isRunning,
      cycleNumber: this.cycleNumber,
      currentTrend: this.currentTrend ?? null,
      martingaleStep: this.martingaleStep,
      isMartingaleActive: this.martingaleActive,
      martingaleTotalLoss: this.martingaleTotalLoss,
      sessionPnL: this.sessionPnL,
      stopLoss: this.config.stopLoss ?? 0,
      stopProfit: this.config.stopProfit ?? 0,
      totalTrades: this.totalTrades,
      totalWins: this.totalWins,
      totalLosses: this.totalLosses,
      activeOrderId: this.activeOrder?.id ?? null,
      wsConnected: this.wsClient.isConnected(),
    };
  }

  // ── Utility ────────────────────────────────────────

  protected sleep(ms: number): Promise<void> {
    // Interruptible sleep: calling wakeUp() resolves this promise early.
    // This ensures stop() exits runCycle() within milliseconds instead of
    // waiting up to 60s for a minute boundary sleep to finish.
    return new Promise((resolve) => {
      this._sleepResolve = resolve;
      this._sleepTimer = setTimeout(() => {
        this._sleepTimer = undefined;
        this._sleepResolve = undefined;
        resolve();
      }, ms);
    });
  }

  protected wakeUp() {
    if (this._sleepTimer) {
      clearTimeout(this._sleepTimer);
      this._sleepTimer = undefined;
    }
    const res = this._sleepResolve;
    this._sleepResolve = undefined;
    res?.();
  }
}
