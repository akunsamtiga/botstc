import { Logger } from '@nestjs/common';
import { StockityWebSocketClient } from '../schedule/websocket-client';
import { FastradeBaseExecutor, FastradeExecutorCallbacks, SessionInfo } from './fastrade-base.executor';
import { FastradeConfig, FastradeOrder, TrendType } from './fastrade-types';

// Offset minimal agar candle sudah settle di server Stockity (~50ms cukup)
const FIRST_FETCH_OFFSET_MS    = 50;
const SECOND_FETCH_OFFSET_MS   = 50;
const CYCLE_RESTART_DELAY_MS   = 2_000;
const RESULT_TIMEOUT_MS        = 180_000;
const BOUNDARY_INTERVAL_SECS   = 5;
// Toleransi minimum sebelum akhir menit — dikurangi dari 5000 ke 1000ms
// agar tidak mudah skip ke menit berikutnya
const EXECUTION_MIN_ADVANCE_MS = 1_000;
// Jika jarak ke boundary berikutnya < nilai ini, eksekusi langsung sekarang
const INSTANT_EXEC_THRESHOLD_MS = 200;

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
  private activeTrend?: TrendType;

  constructor(
    userId: string,
    wsClient: StockityWebSocketClient,
    config: FastradeConfig,
    session: SessionInfo,
    callbacks: FastradeExecutorCallbacks,
  ) {
    super(userId, wsClient, config, session, callbacks);
    this.logger = new Logger('CtcExecutor');
  }

  stop() {
    super.stop();
    this.activeTrend = undefined;
  }

  protected startNewCycle(): void {
    if (!this.isRunning) return;

    // Check Always Signal - jika ada loss yang belum tertutupi, eksekusi martingale
    if (this.alwaysSignalLossState?.hasOutstandingLoss) {
      this.logger.log(
        `[${this.userId}] 🔄 CTC: Always Signal active - executing martingale step ` +
        `${this.alwaysSignalLossState.currentMartingaleStep}`
      );
      this.executeAlwaysSignalMartingale();
      return;
    }

    this.cycleNumber++;
    this.currentTrend = undefined;
    this.activeTrend = undefined;
    this.phase = 'IDLE';
    this.resetMartingale();

    this.logger.log(`[${this.userId}] 🔄 CTC CYCLE ${this.cycleNumber}: Starting`);
    this.callbacks.onStatusChange(`CTC CYCLE ${this.cycleNumber}: Menunggu batas menit...`);

    this.runCycle().catch((err) => {
      this.logger.error(`[${this.userId}] CTC CYCLE ${this.cycleNumber} unhandled error: ${err.message}`);
      if (this.isRunning) {
        setTimeout(() => this.startNewCycle(), CYCLE_RESTART_DELAY_MS);
      }
    });
  }

  private async runCycle(): Promise<void> {
    this.phase = 'WAITING_MINUTE_1';
    const firstBoundary = this.getNextMinuteBoundary();
    const waitToFirst = firstBoundary - Date.now();

    this.logger.log(
      `[${this.userId}] CTC CYCLE ${this.cycleNumber}: ` +
      `Waiting ${waitToFirst}ms to first minute boundary`,
    );

    if (waitToFirst > 0) await this.sleep(waitToFirst);
    if (!this.isRunning) return;

    // Offset minimal — hanya cukup untuk candle settle di server
    await this.sleep(FIRST_FETCH_OFFSET_MS);
    if (!this.isRunning) return;

    this.phase = 'FETCHING_1';
    this.callbacks.onStatusChange(`CTC CYCLE ${this.cycleNumber}: Mengambil candle pertama...`);

    const price1 = await this.fetchCandleClosePrice();

    if (price1 === null) {
      this.logger.warn(`[${this.userId}] CTC CYCLE ${this.cycleNumber}: First fetch failed, restarting`);
      if (this.isRunning) setTimeout(() => this.startNewCycle(), CYCLE_RESTART_DELAY_MS);
      return;
    }

    this.logger.log(`[${this.userId}] CTC CYCLE ${this.cycleNumber}: Price 1 = ${price1}`);

    this.phase = 'WAITING_MINUTE_2';
    this.callbacks.onStatusChange(`CTC CYCLE ${this.cycleNumber}: Menunggu menit kedua (Price1=${price1})...`);

    // Tunggu tepat ke batas menit kedua (dari firstBoundary, bukan dari Date.now())
    const secondBoundary = firstBoundary + 60_000;
    const waitToSecond = secondBoundary - Date.now();

    if (waitToSecond > 0) await this.sleep(waitToSecond);
    if (!this.isRunning) return;

    // Offset minimal — sama seperti fetch pertama
    await this.sleep(SECOND_FETCH_OFFSET_MS);
    if (!this.isRunning) return;

    this.phase = 'FETCHING_2';
    this.callbacks.onStatusChange(`CTC CYCLE ${this.cycleNumber}: Mengambil candle kedua...`);

    const price2 = await this.fetchCandleClosePrice();

    if (price2 === null) {
      this.logger.warn(`[${this.userId}] CTC CYCLE ${this.cycleNumber}: Second fetch failed, restarting`);
      if (this.isRunning) setTimeout(() => this.startNewCycle(), CYCLE_RESTART_DELAY_MS);
      return;
    }

    this.logger.log(`[${this.userId}] CTC CYCLE ${this.cycleNumber}: Price 2 = ${price2}`);

    this.phase = 'ANALYZING';
    let trend = this.determineTrend(price1, price2);
    if (trend === null) {
      this.logger.log(
        `[${this.userId}] CTC CYCLE ${this.cycleNumber}: Harga sama (${price1}) → default PUT`,
      );
      trend = 'put';
    }

    this.currentTrend = trend;
    this.activeTrend = trend;

    const priceChange = price2 - price1;
    this.logger.log(
      `[${this.userId}] CTC CYCLE ${this.cycleNumber}: ` +
      `Trend=${trend.toUpperCase()} (Δ=${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(6)}) ` +
      `activeTrend set to ${trend.toUpperCase()}`,
    );

    this.phase = 'WAITING_EXEC_SYNC';
    const execTime = this.calculateOptimalExecutionTime();
    const waitForExec = execTime - Date.now();

    if (waitForExec > 0) {
      this.logger.log(
        `[${this.userId}] CTC CYCLE ${this.cycleNumber}: ` +
        `Syncing to 5s boundary, wait ${waitForExec}ms`,
      );
      await this.sleep(waitForExec);
    } else {
      this.logger.log(
        `[${this.userId}] CTC CYCLE ${this.cycleNumber}: Already at boundary — execute instantly`,
      );
    }

    if (!this.isRunning) return;

    this.callbacks.onStatusChange(
      `CTC CYCLE ${this.cycleNumber}: Eksekusi ${trend.toUpperCase()} segera`,
    );

    await this.executeWithTrend(trend, 0);
  }

  /**
   * Hitung waktu eksekusi optimal yang paling dekat dengan boundary 5 detik.
   *
   * Logika:
   * 1. Hitung sisa ms ke boundary 5s berikutnya
   * 2. Jika sisa < INSTANT_EXEC_THRESHOLD_MS (200ms) → eksekusi sekarang (skip wait)
   * 3. Jika candidate boundary < EXECUTION_MIN_ADVANCE_MS (1s) sebelum akhir menit
   *    → pakai boundary 5s pertama di menit berikutnya (bukan +60s penuh)
   * 4. Selainnya → pakai candidate boundary tersebut
   */
  private calculateOptimalExecutionTime(): number {
    const now = Date.now();
    const msIntoCurrentSec = now % 1000;
    const currentSec = Math.floor(now / 1000);
    const secInMinute = currentSec % 60;
    const secsUntilNextBoundary = BOUNDARY_INTERVAL_SECS - (secInMinute % BOUNDARY_INTERVAL_SECS);
    const msToBoundary = secsUntilNextBoundary * 1000 - msIntoCurrentSec;

    // Sudah sangat dekat boundary → eksekusi sekarang tanpa tunggu
    if (msToBoundary <= INSTANT_EXEC_THRESHOLD_MS) {
      this.logger.log(
        `[${this.userId}] CTC: Already at boundary (${msToBoundary}ms away) — instant execute`,
      );
      return now;
    }

    const candidateMs = now + msToBoundary;
    const candidateSec = Math.floor(candidateMs / 1000);
    const msUntilMinuteEnd = (60 - (candidateSec % 60)) * 1000;

    // Candidate terlalu dekat akhir menit → cari boundary 5s pertama di menit berikutnya
    if (msUntilMinuteEnd < EXECUTION_MIN_ADVANCE_MS) {
      // Maju ke awal menit berikutnya, lalu ambil boundary 5s pertama (detik ke-5)
      const nextMinuteStartMs = candidateMs + msUntilMinuteEnd;
      const nextBoundaryMs = nextMinuteStartMs + BOUNDARY_INTERVAL_SECS * 1000;
      this.logger.log(
        `[${this.userId}] CTC: Candidate too close to minute end (${msUntilMinuteEnd}ms) ` +
        `— defer to next minute boundary (+${Math.round(nextBoundaryMs - now)}ms)`,
      );
      return nextBoundaryMs;
    }

    return candidateMs;
  }

  private async executeWithTrend(trend: TrendType, step: number, retryCount = 0): Promise<void> {
    if (!this.isRunning) return;

    const MAX_RETRIES = 3;
    if (retryCount >= MAX_RETRIES) {
      this.logger.error(
        `[${this.userId}] CTC: Trade gagal ${MAX_RETRIES}x berturut-turut — bot dihentikan`,
      );
      this.callbacks.onStatusChange(
        `CTC: Trade gagal ${MAX_RETRIES}x — cek konfigurasi amount/koneksi`,
      );
      this.stop();
      return;
    }

    this.phase = 'EXECUTING';
    const amount = this.calcAmount(step);

    this.logger.log(
      `[${this.userId}] CTC: Execute trend=${trend.toUpperCase()} amount=${amount} step=${step} ` +
      `activeTrend=${this.activeTrend} cycle=${this.cycleNumber}` +
      (retryCount > 0 ? ` (retry ${retryCount}/${MAX_RETRIES})` : ''),
    );

    const order = await this.executeTrade(trend, amount, step, this.cycleNumber);

    if (!order) {
      if (!this.isRunning) return;

      this.logger.error(
        `[${this.userId}] CTC: Trade placement failed — retry ${retryCount + 1}/${MAX_RETRIES} in 2s`,
      );
      setTimeout(() => {
        if (this.isRunning) this.executeWithTrend(trend, step, retryCount + 1);
      }, 2000);
      return;
    }

    this.activeOrder = order;
    this.phase = 'WAITING_RESULT';
    this.callbacks.onStatusChange(
      `CTC CYCLE ${this.cycleNumber}: Menunggu hasil ${trend.toUpperCase()} (step=${step})...`,
    );

    this.startResultTimeout(order.id, RESULT_TIMEOUT_MS);
  }

  protected onWin(order: FastradeOrder): void {
    const trend = this.activeTrend ?? this.currentTrend ?? order.trend;
    this.logger.log(
      `[${this.userId}] CTC WIN ✅ — Keep trend: ${trend.toUpperCase()} (activeTrend unchanged)`,
    );
    this.callbacks.onStatusChange(`CTC WIN ✅ — Lanjut ${trend.toUpperCase()} segera`);
    this.resetMartingale();

    setTimeout(() => {
      if (this.isRunning) this.executeWithTrend(trend, 0);
    }, 200);
  }

  protected onLose(order: FastradeOrder): void {
    const m = this.config.martingale;
    const currentActiveTrend = this.activeTrend ?? this.currentTrend ?? order.trend;

    // Jika Always Signal mode aktif, loss sudah di-handle di handleDealResult
    // dan martingale akan di-trigger pada cycle berikutnya
    if (m.isEnabled && m.isAlwaysSignal) {
      this.phase = 'ALWAYS_SIGNAL_WAITING';
      this.logger.log(
        `[${this.userId}] CTC LOSE — Always Signal: Menunggu sinyal berikutnya ` +
        `untuk martingale step ${this.alwaysSignalLossState?.currentMartingaleStep ?? 1}`
      );
      this.callbacks.onStatusChange(
        `CTC LOSE — Always Signal: Menunggu sinyal berikutnya...`
      );
      // Lanjutkan ke cycle baru untuk menunggu sinyal berikutnya
      setTimeout(() => {
        if (this.isRunning) this.startNewCycle();
      }, CYCLE_RESTART_DELAY_MS);
      return;
    }

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

        setTimeout(() => {
          if (this.isRunning) this.executeWithTrend(reversedTrend, nextStep);
        }, 200);
        return;
      }

      const reversedTrend = this.reverseTrend(currentActiveTrend);
      this.activeTrend = reversedTrend;

      this.logger.log(
        `[${this.userId}] CTC: Martingale max reached (step ${this.martingaleStep}/${m.maxSteps}) ` +
        `— REVERSE to ${reversedTrend.toUpperCase()} and continue immediately`,
      );
      this.callbacks.onStatusChange(
        `CTC Martingale max — REVERSED → ${reversedTrend.toUpperCase()} (lanjut segera)`,
      );

      this.resetMartingale();

      setTimeout(() => {
        if (this.isRunning) this.executeWithTrend(reversedTrend, 0);
      }, 200);
      return;
    }

    this.logger.log(
      `[${this.userId}] CTC LOSE (no martingale) — Continue SAME trend: ${currentActiveTrend.toUpperCase()}`,
    );
    this.callbacks.onStatusChange(
      `CTC LOSE — Lanjut ${currentActiveTrend.toUpperCase()} (tanpa martingale)`,
    );

    setTimeout(() => {
      if (this.isRunning) this.executeWithTrend(currentActiveTrend, 0);
    }, 200);
  }

  protected onDraw(order: FastradeOrder): void {
    const trend = this.activeTrend ?? this.currentTrend ?? order.trend;
    this.logger.log(`[${this.userId}] CTC DRAW — Continue ${trend.toUpperCase()} (no martingale)`);
    this.callbacks.onStatusChange(`CTC DRAW — Lanjut ${trend.toUpperCase()}`);

    setTimeout(() => {
      if (this.isRunning) this.executeWithTrend(trend, this.martingaleStep);
    }, 200);
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