import { StockityWebSocketClient } from '../schedule/websocket-client';
import { FastradeBaseExecutor, FastradeExecutorCallbacks, SessionInfo } from './fastrade-base.executor';
import { FastradeConfig, FastradeOrder, TrendType } from './fastrade-types';

const FETCH_OFFSET_MS            = 50;
const CYCLE_RESTART_DELAY_MS     = 2_000;
const BOUNDARY_INTERVAL_SECS     = 5;
const EXECUTION_MIN_ADVANCE_MS   = 1_000;
const INSTANT_EXEC_THRESHOLD_MS  = 200;

type CtcPhase =
  | 'IDLE'
  | 'WAITING_MINUTE_1'
  | 'FETCHING_1'
  | 'WAITING_MINUTE_2'
  | 'FETCHING_2'
  | 'ANALYZING'
  | 'WAITING_EXEC_SYNC'
  | 'EXECUTING'
  | 'WAITING_RESULT'
  | 'ALWAYS_SIGNAL_WAITING';

export class CtcExecutor extends FastradeBaseExecutor {
  private phase: CtcPhase = 'IDLE';
  private cycleTimer?: NodeJS.Timeout;   // FIX KEANDALAN: ditambahkan — sebelumnya tidak ada

  /**
   * Trend aktif CTC: WIN → lanjut sama, LOSE → reverse.
   * Dipertahankan lintas result, berbeda dari currentTrend base yang reset tiap cycle.
   */
  private activeTrend?: TrendType;

  protected get modeName(): string { return 'CTC'; }

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
    // FIX KEANDALAN: clearCycleTimer() ditambahkan di sini.
    // Sebelumnya CTC tidak punya clearCycleTimer() di stop() — berbeda dari FTT
    // yang sudah punya. Akibatnya, jika user stop() saat bot menunggu delay
    // (misal ALWAYS_SIGNAL_WAITING + CYCLE_RESTART_DELAY_MS), timer bocor dan
    // startNewCycle() tetap berjalan 2s kemudian, melakukan trade setelah bot
    // seharusnya berhenti. Dengan timer bocor yang menumpuk, memory juga meningkat.
    this.clearCycleTimer();
    this.activeTrend = undefined;
    super.stop();
  }

  // ── Abstract hook implementations ─────────────────────────────────────────

  protected setExecutingPhase(): void {
    this.phase = 'EXECUTING';
  }

  protected setWaitingResultPhase(trend: TrendType, step: number): void {
    this.phase = 'WAITING_RESULT';
    this.callbacks.onStatusChange(
      `CTC CYCLE ${this.cycleNumber}: Menunggu hasil ${trend.toUpperCase()} (step=${step})...`,
    );
  }

  // ── Cycle lifecycle ───────────────────────────────────────────────────────

  protected startNewCycle(): void {
    if (!this.isRunning) return;

    this.cycleNumber++;
    this.currentTrend = undefined;
    this.activeTrend = undefined;
    this.phase = 'IDLE';
    this.clearCycleTimer();

    if (!this.alwaysSignalLossState?.hasOutstandingLoss) {
      this.resetMartingale();
    }

    if (this.alwaysSignalLossState?.hasOutstandingLoss) {
      const step = this.alwaysSignalLossState.currentMartingaleStep;
      this.logger.log(`[${this.userId}] 🔄 CTC CYCLE ${this.cycleNumber}: Always Signal aktif (step ${step}) — analisis candle dulu`);
      this.callbacks.onStatusChange(`CTC CYCLE ${this.cycleNumber}: Always Signal step ${step} — Menunggu batas menit...`);
    } else {
      this.logger.log(`[${this.userId}] 🔄 CTC CYCLE ${this.cycleNumber}: Starting`);
      this.callbacks.onStatusChange(`CTC CYCLE ${this.cycleNumber}: Menunggu batas menit...`);
    }

    this.runCycle().catch((err) => {
      this.logger.error(`[${this.userId}] CTC CYCLE ${this.cycleNumber} unhandled error: ${err.message}`);
      if (this.isRunning) this.scheduleNewCycle(CYCLE_RESTART_DELAY_MS);
    });
  }

  /**
   * Analisis 2 candle, sync ke boundary 5 detik, lalu eksekusi.
   *
   * FIX: sleep double → single per boundary.
   * FIX: fetchCandleClosePrice sekarang retry 3x di base — kegagalan transient
   *      tidak lagi membuang sinyal 2 menit.
   * CTC: jika harga sama → default PUT (FTT = cycle ulang).
   */
  private async runCycle(): Promise<void> {
    // ── Candle 1 ──────────────────────────────────────────────────────────
    this.phase = 'WAITING_MINUTE_1';
    const firstBoundary = this.getNextMinuteBoundary();
    const waitToFirst = firstBoundary - Date.now();

    this.logger.log(`[${this.userId}] CTC CYCLE ${this.cycleNumber}: Waiting ${waitToFirst}ms to first boundary`);

    await this.sleep(Math.max(0, waitToFirst) + FETCH_OFFSET_MS);
    if (!this.isRunning) return;

    this.phase = 'FETCHING_1';
    this.callbacks.onStatusChange(`CTC CYCLE ${this.cycleNumber}: Mengambil candle pertama...`);

    const price1 = await this.fetchCandleClosePrice();
    if (price1 === null) {
      this.logger.warn(`[${this.userId}] CTC CYCLE ${this.cycleNumber}: First fetch failed setelah retry — restart`);
      if (this.isRunning) this.scheduleNewCycle(CYCLE_RESTART_DELAY_MS);
      return;
    }

    this.logger.log(`[${this.userId}] CTC CYCLE ${this.cycleNumber}: Price 1 = ${price1}`);

    // ── Candle 2 ──────────────────────────────────────────────────────────
    this.phase = 'WAITING_MINUTE_2';
    this.callbacks.onStatusChange(`CTC CYCLE ${this.cycleNumber}: Menunggu menit kedua (Price1=${price1})...`);

    const secondBoundary = firstBoundary + 60_000;
    const waitToSecond = secondBoundary - Date.now();

    await this.sleep(Math.max(0, waitToSecond) + FETCH_OFFSET_MS);
    if (!this.isRunning) return;

    this.phase = 'FETCHING_2';
    this.callbacks.onStatusChange(`CTC CYCLE ${this.cycleNumber}: Mengambil candle kedua...`);

    const price2 = await this.fetchCandleClosePrice();
    if (price2 === null) {
      this.logger.warn(`[${this.userId}] CTC CYCLE ${this.cycleNumber}: Second fetch failed setelah retry — restart`);
      if (this.isRunning) this.scheduleNewCycle(CYCLE_RESTART_DELAY_MS);
      return;
    }

    this.logger.log(`[${this.userId}] CTC CYCLE ${this.cycleNumber}: Price 2 = ${price2}`);

    // ── Analysis ──────────────────────────────────────────────────────────
    this.phase = 'ANALYZING';
    const trend = this.determineTrend(price1, price2) ?? 'put';
    this.currentTrend = trend;
    this.activeTrend = trend;

    const delta = (price2 - price1).toFixed(6);
    this.logger.log(
      `[${this.userId}] CTC CYCLE ${this.cycleNumber}: ` +
      `Trend=${trend.toUpperCase()} (Δ=${price2 >= price1 ? '+' : ''}${delta})`,
    );

    // ── Sync ke boundary 5 detik ──────────────────────────────────────────
    this.phase = 'WAITING_EXEC_SYNC';
    const execTime = this.calculateOptimalExecutionTime();
    const waitForExec = execTime - Date.now();

    if (waitForExec > 0) {
      this.logger.log(`[${this.userId}] CTC CYCLE ${this.cycleNumber}: Sync 5s boundary — wait ${waitForExec}ms`);
      await this.sleep(waitForExec);
    }
    if (!this.isRunning) return;

    this.callbacks.onStatusChange(`CTC CYCLE ${this.cycleNumber}: Eksekusi ${trend.toUpperCase()} segera`);
    await this.executeWithTrend(trend, 0);
  }

  /**
   * Hitung waktu eksekusi optimal paling dekat dengan boundary 5 detik.
   *
   * 1. Jika sisa ke boundary < 200ms → eksekusi sekarang (sudah di boundary)
   * 2. Jika candidate boundary < 1s sebelum akhir menit → defer ke menit berikutnya
   * 3. Selainnya → gunakan candidate boundary
   */
  private calculateOptimalExecutionTime(): number {
    const now = Date.now();
    const msIntoCurrentSec = now % 1000;
    const currentSec = Math.floor(now / 1000);
    const secInMinute = currentSec % 60;
    const secsUntilBoundary = BOUNDARY_INTERVAL_SECS - (secInMinute % BOUNDARY_INTERVAL_SECS);
    const msToBoundary = secsUntilBoundary * 1000 - msIntoCurrentSec;

    if (msToBoundary <= INSTANT_EXEC_THRESHOLD_MS) {
      this.logger.log(`[${this.userId}] CTC: Already at boundary (${msToBoundary}ms away) — instant execute`);
      return now;
    }

    const candidateMs = now + msToBoundary;
    const candidateSec = Math.floor(candidateMs / 1000);
    const msUntilMinuteEnd = (60 - (candidateSec % 60)) * 1000;

    if (msUntilMinuteEnd < EXECUTION_MIN_ADVANCE_MS) {
      const nextMinuteMs = candidateMs + msUntilMinuteEnd;
      const nextBoundaryMs = nextMinuteMs + BOUNDARY_INTERVAL_SECS * 1000;
      this.logger.log(
        `[${this.userId}] CTC: Candidate terlalu dekat akhir menit (${msUntilMinuteEnd}ms) ` +
        `— defer ke boundary berikutnya (+${Math.round(nextBoundaryMs - now)}ms)`,
      );
      return nextBoundaryMs;
    }

    return candidateMs;
  }

  // ── Result handlers ───────────────────────────────────────────────────────

  protected onWin(order: FastradeOrder): void {
    const trend = this.activeTrend ?? this.currentTrend ?? order.trend;
    this.logger.log(`[${this.userId}] CTC WIN ✅ — Keep trend: ${trend.toUpperCase()}`);
    this.callbacks.onStatusChange(`CTC WIN ✅ — Lanjut ${trend.toUpperCase()} segera`);
    this.resetMartingale();

    // FIX: afterDelay — dilindungi stopGeneration agar tidak execute setelah stop()
    this.afterDelay(200, () => this.executeWithTrend(trend, 0));
  }

  protected onLose(order: FastradeOrder): void {
    const m = this.config.martingale;
    const currentActiveTrend = this.activeTrend ?? this.currentTrend ?? order.trend;

    // ── Always Signal ──────────────────────────────────────────────────────
    if (m.isEnabled && m.isAlwaysSignal) {
      this.phase = 'ALWAYS_SIGNAL_WAITING';
      const nextStep = this.alwaysSignalLossState?.currentMartingaleStep ?? 1;
      this.logger.log(
        `[${this.userId}] CTC LOSE — Always Signal: menunggu candle berikutnya (step ${nextStep}/${m.maxSteps})`,
      );
      this.callbacks.onStatusChange(`CTC LOSE — Always Signal step ${nextStep}: Menunggu sinyal berikutnya...`);
      this.scheduleNewCycle(CYCLE_RESTART_DELAY_MS);
      return;
    }

    // ── Martingale regular: setiap LOSE → reverse arah ────────────────────
    if (m.isEnabled && m.maxSteps > 0) {
      const nextStep = this.martingaleStep + 1;

      if (nextStep <= m.maxSteps) {
        const reversedTrend = this.reverseTrend(currentActiveTrend);
        this.activeTrend = reversedTrend;
        this.martingaleStep = nextStep;
        this.martingaleActive = true;
        this.martingaleTotalLoss += order.amount;

        this.logger.log(
          `[${this.userId}] CTC LOSE — Martingale step ${nextStep}/${m.maxSteps} ` +
          `REVERSED: ${currentActiveTrend.toUpperCase()} → ${reversedTrend.toUpperCase()}`,
        );
        this.callbacks.onStatusChange(
          `CTC LOSE — Martingale ${nextStep}/${m.maxSteps}: REVERSED → ${reversedTrend.toUpperCase()}`,
        );

        this.afterDelay(200, () => this.executeWithTrend(reversedTrend, nextStep));
        return;
      }

      // Martingale max → reverse, lanjut segera
      // FIX: capture step SEBELUM resetMartingale() agar log benar
      const reachedStep = this.martingaleStep;
      const reversedTrend = this.reverseTrend(currentActiveTrend);
      this.activeTrend = reversedTrend;
      this.resetMartingale();

      this.logger.log(
        `[${this.userId}] CTC: Martingale max (step ${reachedStep}/${m.maxSteps}) ` +
        `— REVERSE to ${reversedTrend.toUpperCase()} lanjut segera`,
      );
      this.callbacks.onStatusChange(
        `CTC Martingale max ❌ — REVERSED → ${reversedTrend.toUpperCase()} (lanjut segera)`,
      );

      this.afterDelay(200, () => this.executeWithTrend(reversedTrend, 0));
      return;
    }

    // ── No martingale: lanjut trend sama (CTC tanpa martingale tidak reverse) ──
    this.logger.log(
      `[${this.userId}] CTC LOSE (no martingale) — Continue SAME trend: ${currentActiveTrend.toUpperCase()}`,
    );
    this.callbacks.onStatusChange(`CTC LOSE — Lanjut ${currentActiveTrend.toUpperCase()} (tanpa martingale)`);

    this.afterDelay(200, () => this.executeWithTrend(currentActiveTrend, 0));
  }

  protected onDraw(order: FastradeOrder): void {
    const trend = this.activeTrend ?? this.currentTrend ?? order.trend;
    this.logger.log(`[${this.userId}] CTC DRAW — Continue ${trend.toUpperCase()} step=${this.martingaleStep}`);
    this.callbacks.onStatusChange(`CTC DRAW — Lanjut ${trend.toUpperCase()}`);

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
    return {
      ...super.getStatus(),
      mode: 'CTC',
      phase: this.phase,
      activeTrend: this.activeTrend ?? null,
    };
  }
}