import { Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { curlGet } from '../common/http-utils';
import { StockityWebSocketClient, DealResultPayload } from '../schedule/websocket-client';
import {
  FastradeConfig, FastradeLog, FastradeOrder, TrendType, FastradeTradeOrder,
  FastradeAlwaysSignalLossState,
} from './fastrade-types';

const BASE_URL = 'https://api.stockity.id';
const MAX_PRICE_FETCH_TIME   = 5;
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

  protected isRunning = false;
  protected cycleNumber = 0;
  protected currentTrend?: TrendType;
  protected sessionPnL = 0;
  protected totalWins = 0;
  protected totalLosses = 0;
  protected totalTrades = 0;

  protected activeOrder?: FastradeOrder;
  protected executionTime?: number;

  protected martingaleStep = 0;
  protected martingaleActive = false;
  protected martingaleTotalLoss = 0;

  protected alwaysSignalLossState: FastradeAlwaysSignalLossState | null = null;

  protected resultTimeoutTimer?: NodeJS.Timeout;

  private _sleepTimer?: NodeJS.Timeout;
  private _sleepResolve?: () => void;

  // ── Keandalan: stop-generation counter ────────────────────────────────────
  // Naik setiap stop()/start() — dipakai oleh afterDelay() agar callback yang
  // dijadwalkan sebelum stop() tidak bisa execute setelah start() baru.
  protected stopGeneration = 0;

  // ── Konstanta — override di subclass jika perlu ───────────────────────────
  protected readonly MAX_RETRIES   = 5;
  protected readonly RETRY_DELAY_MS = 2_000;
  protected readonly RESULT_TIMEOUT_MS = 180_000;

  /** Nama mode untuk log/status ('FTT' / 'CTC'). */
  protected abstract get modeName(): string;

  constructor(
    protected readonly userId: string,
    protected readonly wsClient: StockityWebSocketClient,
    protected readonly config: FastradeConfig,
    protected readonly session: SessionInfo,
    protected readonly callbacks: FastradeExecutorCallbacks,
  ) {
    this.logger = new Logger(this.constructor.name);
    this.wsClient.setOnDealResult((p) => this.handleDealResult(p));
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.stopGeneration++;          // invalidate semua callback lama
    this.sessionPnL = 0;
    this.totalWins = 0;
    this.totalLosses = 0;
    this.totalTrades = 0;
    this.cycleNumber = 0;
    this.activeOrder = undefined;
    this.executionTime = undefined;
    this.resetMartingale();
    this.alwaysSignalLossState = null;
    this.logger.log(`[${this.userId}] ▶️ Starting (gen=${this.stopGeneration})`);
    this.startNewCycle();
  }

  stop() {
    if (!this.isRunning && !this.activeOrder) return;
    this.isRunning = false;
    this.stopGeneration++;          // invalidate semua callback yang dijadwalkan
    this.clearResultTimeout();
    this.wakeUp();
    this.activeOrder = undefined;
    this.executionTime = undefined;
    this.resetMartingale();
    this.alwaysSignalLossState = null;
    this.logger.log(`[${this.userId}] ⏹️ Stopped (gen=${this.stopGeneration})`);
    this.callbacks.onStopped();
  }

  isActive(): boolean { return this.isRunning; }

  protected abstract startNewCycle(): void;
  protected abstract onWin(order: FastradeOrder): void;
  protected abstract onLose(order: FastradeOrder): void;
  protected abstract onDraw(order: FastradeOrder): void;

  protected abstract setExecutingPhase(): void;
  protected abstract setWaitingResultPhase(trend: TrendType, step: number): void;

  // ── afterDelay: pengganti setTimeout yang aman terhadap race stop/start ───
  //
  // Sebelumnya: setTimeout(() => { if (this.isRunning) fn(); }, ms)
  // Masalah: jika stop() + start() terjadi dalam window `ms`, stopGeneration
  //   sudah berubah di stop() (naik 1) tapi naik lagi di start() (naik 1 lagi).
  //   Callback lama membawa gen lama → gen !== stopGeneration → tidak execute.
  //   Callback baru dari start() membawa gen baru → lolos.
  //
  // Ini mencegah "trade basi" yang bisa terjadi jika user stop+start cepat.
  protected afterDelay(ms: number, fn: () => void): void {
    const gen = this.stopGeneration;
    setTimeout(() => {
      if (this.isRunning && this.stopGeneration === gen) fn();
    }, ms);
  }

  // ── executeWithTrend (terpusat di base, tidak duplikat di FTT/CTC) ─────────
  protected async executeWithTrend(trend: TrendType, step: number, retryCount = 0): Promise<void> {
    if (!this.isRunning) return;

    if (retryCount >= this.MAX_RETRIES) {
      this.logger.error(`[${this.userId}] ${this.modeName}: Trade gagal ${this.MAX_RETRIES}x — bot dihentikan`);
      this.callbacks.onStatusChange(`${this.modeName}: Trade gagal ${this.MAX_RETRIES}x — cek koneksi/amount`);
      this.stop();
      return;
    }

    // waitForWsReady hanya dipanggil SATU KALI di sini.
    // executeTrade() TIDAK memanggil waitForWsReady lagi (sudah dihapus).
    await this.waitForWsReady(15_000);
    if (!this.isRunning) return;

    const effectiveStep =
      (this.alwaysSignalLossState?.hasOutstandingLoss && step === 0)
        ? this.alwaysSignalLossState.currentMartingaleStep
        : step;

    if (effectiveStep !== step) {
      this.logger.log(`[${this.userId}] ${this.modeName}: Always Signal override — step ${step}→${effectiveStep}`);
    }

    const amount = this.calcAmount(effectiveStep);
    this.setExecutingPhase();

    this.logger.log(
      `[${this.userId}] ${this.modeName}: Execute trend=${trend.toUpperCase()} ` +
      `amount=${amount} step=${effectiveStep} cycle=${this.cycleNumber}` +
      (retryCount > 0 ? ` (retry ${retryCount}/${this.MAX_RETRIES})` : ''),
    );

    const order = await this.executeTrade(trend, amount, effectiveStep, this.cycleNumber);

    if (!order) {
      if (!this.isRunning) return;
      this.logger.error(
        `[${this.userId}] ${this.modeName}: Placement failed — retry ${retryCount + 1}/${this.MAX_RETRIES} in ${this.RETRY_DELAY_MS}ms`,
      );
      // afterDelay: retry juga diproteksi stopGeneration
      this.afterDelay(this.RETRY_DELAY_MS, () => this.executeWithTrend(trend, step, retryCount + 1));
      return;
    }

    this.activeOrder = order;
    this.setWaitingResultPhase(trend, step);
    this.startResultTimeout(order.id);
  }

  // ── Candle fetching ───────────────────────────────────────────────────────

  /**
   * Ambil harga close candle terakhir dari Stockity API.
   *
   * FIX PERFORMA: sebelumnya 1 attempt → 1 gagal = restart cycle + tunggu 2+ menit.
   * Sekarang: 3 attempt dengan 1s jeda per retry.
   * HTTP error transient (timeout jaringan, server busy) tidak lagi membuang sinyal.
   */
  protected async fetchCandleClosePrice(maxAttempts = 3): Promise<number | null> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (!this.isRunning) return null;

      const price = await this._fetchCandleOnce();
      if (price !== null) return price;

      if (attempt < maxAttempts) {
        this.logger.warn(
          `[${this.userId}] Candle fetch attempt ${attempt}/${maxAttempts} failed — retry in 1s`,
        );
        await new Promise<void>(r => setTimeout(r, 1_000));
      }
    }

    this.logger.error(`[${this.userId}] Candle fetch failed after ${maxAttempts} attempts`);
    return null;
  }

  private async _fetchCandleOnce(): Promise<number | null> {
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

      const candles: any[] = response.data?.data;
      if (!candles?.length) return null;

      const last = [...candles]
        .sort((a, b) => (a.created_at as string).localeCompare(b.created_at as string))
        .at(-1)!;

      const closePrice = parseFloat(last.close);
      return isNaN(closePrice) ? null : closePrice;

    } catch (err: any) {
      this.logger.error(`[${this.userId}] _fetchCandleOnce error: ${err.message}`);
      return null;
    }
  }

  protected determineTrend(price1: number, price2: number): TrendType | null {
    if (price2 > price1) return 'call';
    if (price2 < price1) return 'put';
    return null;
  }

  protected reverseTrend(trend: TrendType): TrendType {
    return trend === 'call' ? 'put' : 'call';
  }

  protected getNextMinuteBoundary(): number {
    const now = Date.now();
    return now + (60_000 - (now % 60_000));
  }

  protected formatApiDate(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return (
      `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
      `T${pad(date.getUTCHours())}:00:00`
    );
  }

  // ── Trade execution ───────────────────────────────────────────────────────

  /**
   * Kirim trade ke Stockity via WebSocket.
   * waitForWsReady() TIDAK dipanggil di sini — caller (executeWithTrend) sudah
   * memanggil satu kali. Duplikasi sebelumnya bisa menyebabkan delay +15s per trade.
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

    if (result.error === 'amount_min') {
      this.logger.error(`[${this.userId}] ❌ Amount ${amount} di bawah minimum Stockity — bot dihentikan`);
      this.callbacks.onLog({
        id: uuidv4(), orderId, trend, amount, martingaleStep,
        result: 'FAILED', executedAt: now, cycleNumber: cycleNum,
        note: 'Amount di bawah minimum Stockity. Cek konfigurasi.',
        isDemoAccount: this.config.isDemoAccount,
      });
      this.callbacks.onStatusChange(`❌ Amount ${amount} di bawah minimum Stockity — bot dihentikan.`);
      setTimeout(() => this.stop(), 300);
      return null;
    }

    if (result.error === 'amount_max') {
      this.logger.error(`[${this.userId}] ❌ Amount ${amount} melebihi maksimum Stockity — bot dihentikan`);
      this.callbacks.onLog({
        id: uuidv4(), orderId, trend, amount, martingaleStep,
        result: 'FAILED', executedAt: now, cycleNumber: cycleNum,
        note: `Amount ${amount} melebihi batas maksimum. Kurangi multiplier/baseAmount.`,
        isDemoAccount: this.config.isDemoAccount,
      });
      this.callbacks.onStatusChange(`❌ Amount ${amount} melebihi maksimum Stockity (step=${martingaleStep}) — kurangi multiplier.`);
      setTimeout(() => this.stop(), 300);
      return null;
    }

    if (result.error === 'duplicate') {
      this.logger.warn(`[${this.userId}] ⚠️ Duplicate deal — menunggu hasil via WS`);
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

    if (!dealId && result.error !== 'duplicate') return null;

    this.executionTime = now;
    return order;
  }

  /**
   * Bangun payload trade untuk eksekusi instan (non-scheduled).
   *
   * FIX PERFORMA: sebelumnya `remainingInMinute >= 45` bisa menghasilkan
   * durasi tepat 45s jika dipanggil di detik :15 menit — di batas minimum
   * Stockity tanpa slack. Sekarang threshold dinaikkan ke 48 agar durasi
   * minimal ~48s, memberikan 3 detik buffer untuk prosesan server.
   */
  protected buildInstantTrade(trend: TrendType, amount: number): FastradeTradeOrder {
    const nowMs = Date.now();
    const createdAtSeconds = Math.floor(nowMs / 1000) + 1;
    const remainingInMinute = 60 - (createdAtSeconds % 60);

    // FIX: threshold 48 (bukan 45) → durasi minimal 48s, bukan tepat 45s
    const expireAt = remainingInMinute >= 48
      ? createdAtSeconds + remainingInMinute
      : createdAtSeconds + remainingInMinute + 60;

    const duration = expireAt - createdAtSeconds;
    if (duration < 45)  throw new Error(`Duration terlalu pendek: ${duration}s (min 45s)`);
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

  // ── Always Signal helpers ─────────────────────────────────────────────────

  protected handleAlwaysSignalLoss(order: FastradeOrder): void {
    const m = this.config.martingale;
    if (!m.isEnabled || !m.isAlwaysSignal) return;

    const currentStep = this.alwaysSignalLossState?.currentMartingaleStep ?? 0;
    const nextStep = currentStep + 1;

    if (nextStep > m.maxSteps) {
      this.logger.log(`[${this.userId}] 📊 Always Signal: max steps (${m.maxSteps}) reached — reset`);
      this.alwaysSignalLossState = null;
      return;
    }

    const totalLoss = (this.alwaysSignalLossState?.totalLoss ?? 0) + order.amount;
    this.alwaysSignalLossState = {
      hasOutstandingLoss: true,
      currentMartingaleStep: nextStep,
      originalOrderId: order.id,
      totalLoss,
    };

    this.logger.log(
      `[${this.userId}] 📊 Always Signal: step=${currentStep}→${nextStep}/${m.maxSteps} ` +
      `loss=${order.amount} totalLoss=${totalLoss}`,
    );
  }

  protected clearAlwaysSignalLoss(): void {
    if (this.alwaysSignalLossState) {
      this.logger.log(`[${this.userId}] ✅ Always Signal: cleared (WIN)`);
      this.alwaysSignalLossState = null;
    }
  }

  // ── Deal result handling ──────────────────────────────────────────────────

  protected handleDealResult(payload: DealResultPayload) {
    const s = (payload.status || payload.result || '').toLowerCase();
    if (!TERMINAL_STATUSES.has(s)) {
      this.logger.debug(`[${this.userId}] Skip non-terminal status="${s}"`);
      return;
    }

    const active = this.activeOrder;
    if (!active) return;

    const dealId = String(payload.id ?? '');
    const isWin  = s === 'won' || s === 'win';
    const isDraw = s === 'stand' || s === 'draw' || s === 'tie';

    let isMatch = active.dealId === dealId;

    if (!isMatch && payload.uuid && payload.uuid !== dealId) {
      isMatch = active.dealId === payload.uuid;
      if (isMatch) this.logger.debug(`[${this.userId}] Match via UUID cross-ref`);
    }

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

    const _m = this.config.martingale;
    const _isMidSequenceLoss =
      _m.isEnabled && _m.maxSteps > 0 &&
      !isWin && !isDraw &&
      active.martingaleStep < _m.maxSteps;

    if (!_isMidSequenceLoss) {
      this.totalTrades++;
      if (isWin) this.totalWins++;
      else if (!isDraw) this.totalLosses++;
    }

    this.logger.log(
      `[${this.userId}] ✅ ${result} | amount=${active.amount} step=${active.martingaleStep} ` +
      `tradePnL=${tradePnL >= 0 ? '+' : ''}${tradePnL} sessionPnL=${this.sessionPnL >= 0 ? '+' : ''}${this.sessionPnL}`,
    );

    this.callbacks.onLog({
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

    const completedOrder: FastradeOrder = {
      ...active,
      result: result as any,
      dealId: dealId || active.dealId,
    };
    this.activeOrder = undefined;
    this.executionTime = undefined;

    if (!this.isRunning) return;
    if (this.checkStopConditions()) return;

    if (isWin) {
      this.clearAlwaysSignalLoss();
      this.onWin(completedOrder);
    } else if (isDraw) {
      this.onDraw(completedOrder);
    } else {
      if (this.config.martingale.isEnabled && this.config.martingale.isAlwaysSignal) {
        this.handleAlwaysSignalLoss(completedOrder);
      }
      this.onLose(completedOrder);
    }
  }

  protected isFallbackMatch(payload: DealResultPayload, order: FastradeOrder): boolean {
    if (!this.executionTime) return false;
    if (Date.now() - this.executionTime > FALLBACK_MATCH_WINDOW_MS) return false;
    if (payload.amount !== undefined && payload.amount !== order.amount) return false;
    if (payload.trend && payload.trend !== order.trend) return false;
    return true;
  }

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

  // ── Result timeout ────────────────────────────────────────────────────────

  protected startResultTimeout(orderId: string, timeoutMs?: number) {
    this.clearResultTimeout();
    const timeout = timeoutMs ?? this.RESULT_TIMEOUT_MS;
    this.resultTimeoutTimer = setTimeout(() => {
      if (this.activeOrder?.id !== orderId) return;
      this.logger.warn(`[${this.userId}] ⚠️ Result timeout for order ${orderId} — treating as LOSE`);
      const timedOut = this.activeOrder!;
      this.activeOrder = undefined;
      this.executionTime = undefined;
      if (this.isRunning) this.onLose(timedOut);
    }, timeout);
  }

  protected clearResultTimeout() {
    if (this.resultTimeoutTimer) {
      clearTimeout(this.resultTimeoutTimer);
      this.resultTimeoutTimer = undefined;
    }
  }

  // ── Status ────────────────────────────────────────────────────────────────

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
      alwaysSignalActive: this.alwaysSignalLossState?.hasOutstandingLoss ?? false,
      alwaysSignalStep: this.alwaysSignalLossState?.currentMartingaleStep ?? 0,
      stopGeneration: this.stopGeneration,
    };
  }

  // ── Sleep utilities ───────────────────────────────────────────────────────

  protected sleep(ms: number): Promise<void> {
    // FIX: wake up sleep lama sebelum register yang baru — mencegah _sleepResolve
    // ditimpa tanpa resolve, yang menyebabkan memory leak dan race condition.
    if (this._sleepTimer) this.wakeUp();

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

  /**
   * Tunggu sampai WS connected + required channels ready.
   *
   * FIX PERFORMA: logging dikurangi — log satu kali saat mulai tunggu,
   * satu kali saat ready. Sebelumnya log warn setiap 300ms → ~50 baris noise per reconnect.
   */
  protected async waitForWsReady(timeoutMs = 15_000): Promise<void> {
    const CHECK_INTERVAL_MS = 300;
    const deadline = Date.now() + timeoutMs;
    let hasLoggedWaiting = false;

    while (Date.now() < deadline) {
      if (!this.isRunning) return;
      if (this.wsClient.isConnected() && this.wsClient.isRequiredChannelsReady()) {
        if (hasLoggedWaiting) this.logger.log(`[${this.userId}] ✅ WS ready`);
        return;
      }
      if (!hasLoggedWaiting) {
        this.logger.warn(
          `[${this.userId}] ⏳ WS not ready — waiting up to ${timeoutMs}ms ` +
          `(connected=${this.wsClient.isConnected()} channels=${this.wsClient.isRequiredChannelsReady()})`,
        );
        hasLoggedWaiting = true;
      }
      await new Promise<void>(r => setTimeout(r, CHECK_INTERVAL_MS));
    }

    this.logger.warn(`[${this.userId}] ⚠️ waitForWsReady timeout ${timeoutMs}ms — proceeding anyway`);
  }
}