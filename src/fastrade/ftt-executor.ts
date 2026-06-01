import { StockityWebSocketClient } from '../schedule/websocket-client';
import { FastradeBaseExecutor, FastradeExecutorCallbacks, SessionInfo } from './fastrade-base.executor';
import { FastradeConfig, FastradeOrder, TrendType } from './fastrade-types';

const FETCH_OFFSET_MS        = 300;
const DIRECT_LOSS_DELAY_MS   = 120_000;
const CYCLE_RESTART_DELAY_MS = 2_000;

type FttPhase =
  | 'IDLE'
  | 'WAITING_MINUTE_1'
  | 'FETCHING_1'
  | 'WAITING_MINUTE_2'
  | 'FETCHING_2'
  | 'ANALYZING'
  | 'EXECUTING'
  | 'WAITING_RESULT'
  | 'WAITING_LOSS_DELAY'
  | 'ALWAYS_SIGNAL_WAITING';

export class FttExecutor extends FastradeBaseExecutor {
  private phase: FttPhase = 'IDLE';
  private cycleTimer?: NodeJS.Timeout;

  protected get modeName(): string { return 'FTT'; }

  constructor(
    userId: string,
    wsClient: StockityWebSocketClient,
    config: FastradeConfig,
    session: SessionInfo,
    callbacks: FastradeExecutorCallbacks,
  ) {
    super(userId, wsClient, config, session, callbacks);
  }

  stop() {
    this.clearCycleTimer();
    super.stop();
  }

  // ── Abstract hook implementations ─────────────────────────────────────────

  protected setExecutingPhase(): void {
    this.phase = 'EXECUTING';
  }

  protected setWaitingResultPhase(trend: TrendType, step: number): void {
    this.phase = 'WAITING_RESULT';
    this.callbacks.onStatusChange(
      `FTT CYCLE ${this.cycleNumber}: Menunggu hasil ${trend.toUpperCase()} (step=${step})...`,
    );
  }

  // ── Cycle lifecycle ───────────────────────────────────────────────────────

  protected startNewCycle(): void {
    if (!this.isRunning) return;

    this.cycleNumber++;
    this.currentTrend = undefined;
    this.phase = 'IDLE';
    this.clearCycleTimer();

    if (!this.alwaysSignalLossState?.hasOutstandingLoss) {
      this.resetMartingale();
    }

    if (this.alwaysSignalLossState?.hasOutstandingLoss) {
      const step = this.alwaysSignalLossState.currentMartingaleStep;
      this.logger.log(`[${this.userId}] 🔄 FTT CYCLE ${this.cycleNumber}: Always Signal aktif (step ${step}) — analisis candle dulu`);
      this.callbacks.onStatusChange(`FTT CYCLE ${this.cycleNumber}: Always Signal step ${step} — Menunggu batas menit...`);
    } else {
      this.logger.log(`[${this.userId}] 🔄 FTT CYCLE ${this.cycleNumber}: Starting`);
      this.callbacks.onStatusChange(`FTT CYCLE ${this.cycleNumber}: Menunggu batas menit...`);
    }

    this.runCycle().catch((err) => {
      this.logger.error(`[${this.userId}] FTT CYCLE ${this.cycleNumber} unhandled error: ${err.message}`);
      if (this.isRunning) this.scheduleNewCycle(CYCLE_RESTART_DELAY_MS);
    });
  }

  /**
   * Analisis 2 candle lalu eksekusi trade.
   *
   * FIX: sleep double → single call per boundary (hemat 1 timer per boundary).
   * FIX: fetchCandleClosePrice sekarang retry 3x di base — kegagalan transient
   *      tidak lagi membuang sinyal 2 menit.
   */
  private async runCycle(): Promise<void> {
    // ── Candle 1 ──────────────────────────────────────────────────────────
    this.phase = 'WAITING_MINUTE_1';
    const firstBoundary = this.getNextMinuteBoundary();
    const waitToFirst = firstBoundary - Date.now();

    this.logger.log(`[${this.userId}] FTT CYCLE ${this.cycleNumber}: Waiting ${waitToFirst}ms to first boundary`);

    await this.sleep(Math.max(0, waitToFirst) + FETCH_OFFSET_MS);
    if (!this.isRunning) return;

    this.phase = 'FETCHING_1';
    this.callbacks.onStatusChange(`FTT CYCLE ${this.cycleNumber}: Mengambil candle pertama...`);

    const price1 = await this.fetchCandleClosePrice();
    if (price1 === null) {
      this.logger.warn(`[${this.userId}] FTT CYCLE ${this.cycleNumber}: First fetch failed setelah retry — restart`);
      if (this.isRunning) this.scheduleNewCycle(CYCLE_RESTART_DELAY_MS);
      return;
    }

    this.logger.log(`[${this.userId}] FTT CYCLE ${this.cycleNumber}: Price 1 = ${price1}`);

    // ── Candle 2 ──────────────────────────────────────────────────────────
    this.phase = 'WAITING_MINUTE_2';
    this.callbacks.onStatusChange(`FTT CYCLE ${this.cycleNumber}: Menunggu menit kedua (Price1=${price1})...`);

    const secondBoundary = firstBoundary + 60_000;
    const waitToSecond = secondBoundary - Date.now();

    await this.sleep(Math.max(0, waitToSecond) + FETCH_OFFSET_MS);
    if (!this.isRunning) return;

    this.phase = 'FETCHING_2';
    this.callbacks.onStatusChange(`FTT CYCLE ${this.cycleNumber}: Mengambil candle kedua...`);

    const price2 = await this.fetchCandleClosePrice();
    if (price2 === null) {
      this.logger.warn(`[${this.userId}] FTT CYCLE ${this.cycleNumber}: Second fetch failed setelah retry — restart`);
      if (this.isRunning) this.scheduleNewCycle(CYCLE_RESTART_DELAY_MS);
      return;
    }

    this.logger.log(`[${this.userId}] FTT CYCLE ${this.cycleNumber}: Price 2 = ${price2}`);

    // ── Analysis & Execute ────────────────────────────────────────────────
    this.phase = 'ANALYZING';
    const trend = this.determineTrend(price1, price2);

    if (trend === null) {
      this.logger.log(`[${this.userId}] FTT CYCLE ${this.cycleNumber}: Harga sama (${price1}) — cycle ulang`);
      this.callbacks.onStatusChange(`FTT CYCLE ${this.cycleNumber}: Harga sama — cycle ulang`);
      if (this.isRunning) this.scheduleNewCycle(CYCLE_RESTART_DELAY_MS);
      return;
    }

    this.currentTrend = trend;
    const delta = (price2 - price1).toFixed(6);
    this.logger.log(
      `[${this.userId}] FTT CYCLE ${this.cycleNumber}: ` +
      `Trend=${trend.toUpperCase()} (Δ=${price2 > price1 ? '+' : ''}${delta})`,
    );
    this.callbacks.onStatusChange(`FTT CYCLE ${this.cycleNumber}: Trend ${trend.toUpperCase()} — Eksekusi segera`);

    await this.executeWithTrend(trend, 0);
  }

  // ── Result handlers ───────────────────────────────────────────────────────

  protected onWin(order: FastradeOrder): void {
    const trend = this.currentTrend ?? order.trend;
    this.logger.log(`[${this.userId}] FTT WIN ✅ — same trend: ${trend.toUpperCase()}`);
    this.callbacks.onStatusChange(`FTT WIN ✅ — Lanjut ${trend.toUpperCase()} segera`);
    this.resetMartingale();

    // FIX: afterDelay (bukan setTimeout) — dilindungi stopGeneration.
    // Jika stop() dipanggil dalam 200ms, callback ini tidak akan execute.
    this.afterDelay(200, () => this.executeWithTrend(trend, 0));
  }

  protected onLose(order: FastradeOrder): void {
    const m = this.config.martingale;
    const trend = this.currentTrend ?? order.trend;

    // ── Always Signal ──────────────────────────────────────────────────────
    if (m.isEnabled && m.isAlwaysSignal) {
      this.phase = 'ALWAYS_SIGNAL_WAITING';
      const nextStep = this.alwaysSignalLossState?.currentMartingaleStep ?? 1;
      this.logger.log(
        `[${this.userId}] FTT LOSE — Always Signal: menunggu candle berikutnya (step ${nextStep}/${m.maxSteps})`,
      );
      this.callbacks.onStatusChange(`FTT LOSE — Always Signal step ${nextStep}: Menunggu sinyal berikutnya...`);
      this.scheduleNewCycle(CYCLE_RESTART_DELAY_MS);
      return;
    }

    // ── Martingale regular ─────────────────────────────────────────────────
    if (m.isEnabled && m.maxSteps > 0) {
      const nextStep = this.martingaleStep + 1;

      if (nextStep <= m.maxSteps) {
        this.martingaleStep = nextStep;
        this.martingaleActive = true;
        this.martingaleTotalLoss += order.amount;

        this.logger.log(`[${this.userId}] FTT LOSE — Martingale step ${nextStep}/${m.maxSteps} trend=${trend.toUpperCase()}`);
        this.callbacks.onStatusChange(`FTT LOSE — Martingale ${nextStep}/${m.maxSteps} ${trend.toUpperCase()}`);

        this.afterDelay(200, () => this.executeWithTrend(trend, nextStep));
        return;
      }

      // Martingale max → reverse, lanjut segera
      // FIX: capture step SEBELUM resetMartingale() agar log tampilkan angka benar
      const reachedStep = this.martingaleStep;
      const reversedTrend = this.reverseTrend(trend);
      this.currentTrend = reversedTrend;
      this.resetMartingale();

      this.logger.log(
        `[${this.userId}] FTT: Martingale max reached (step ${reachedStep}/${m.maxSteps}) ` +
        `— REVERSE ${trend.toUpperCase()} → ${reversedTrend.toUpperCase()}`,
      );
      this.callbacks.onStatusChange(`FTT Martingale max ❌ — REVERSED → ${reversedTrend.toUpperCase()} (order segera)`);

      this.afterDelay(200, () => this.executeWithTrend(reversedTrend, 0));
      return;
    }

    // ── No martingale ─────────────────────────────────────────────────────
    this.phase = 'WAITING_LOSS_DELAY';
    this.resetMartingale();

    this.logger.log(`[${this.userId}] FTT LOSE ❌ — Waiting ${DIRECT_LOSS_DELAY_MS / 1000}s before new cycle`);
    this.callbacks.onStatusChange(`FTT LOSE ❌ — Tunggu ${DIRECT_LOSS_DELAY_MS / 1000}s lalu cycle baru...`);

    this.scheduleNewCycle(DIRECT_LOSS_DELAY_MS);
  }

  protected onDraw(order: FastradeOrder): void {
    const trend = this.currentTrend ?? order.trend;
    this.logger.log(`[${this.userId}] FTT DRAW — continue ${trend.toUpperCase()} step=${this.martingaleStep}`);
    this.callbacks.onStatusChange(`FTT DRAW — Lanjut ${trend.toUpperCase()}`);

    this.afterDelay(200, () => this.executeWithTrend(trend, this.martingaleStep));
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private scheduleNewCycle(delayMs: number): void {
    this.clearCycleTimer();
    this.cycleTimer = setTimeout(() => {
      if (this.isRunning) this.startNewCycle();
    }, delayMs);
  }

  private clearCycleTimer(): void {
    if (this.cycleTimer) {
      clearTimeout(this.cycleTimer);
      this.cycleTimer = undefined;
    }
  }

  getStatus() {
    return { ...super.getStatus(), mode: 'FTT', phase: this.phase };
  }
}