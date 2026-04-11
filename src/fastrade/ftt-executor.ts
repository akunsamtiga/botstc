import { Logger } from '@nestjs/common';
import { StockityWebSocketClient } from '../schedule/websocket-client';
import { FastradeBaseExecutor, FastradeExecutorCallbacks, SessionInfo } from './fastrade-base.executor';
import { FastradeConfig, FastradeOrder, TrendType } from './fastrade-types';

const FIRST_FETCH_OFFSET_MS  = 300;
const SECOND_FETCH_OFFSET_MS = 300;
const DIRECT_LOSS_DELAY_MS   = 120_000;
const CYCLE_RESTART_DELAY_MS = 2_000;
const RESULT_TIMEOUT_MS      = 180_000;

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

  constructor(
    userId: string,
    wsClient: StockityWebSocketClient,
    config: FastradeConfig,
    session: SessionInfo,
    callbacks: FastradeExecutorCallbacks,
  ) {
    super(userId, wsClient, config, session, callbacks);
    this.logger = new Logger('FttExecutor');
  }

  stop() {
    this.clearCycleTimer();
    super.stop();
  }

  protected startNewCycle(): void {
    if (!this.isRunning) return;

    // Check Always Signal - jika ada loss yang belum tertutupi, eksekusi martingale
    if (this.alwaysSignalLossState?.hasOutstandingLoss) {
      this.logger.log(
        `[${this.userId}] 🔄 FTT: Always Signal active - executing martingale step ` +
        `${this.alwaysSignalLossState.currentMartingaleStep}`
      );
      this.executeAlwaysSignalMartingale();
      return;
    }

    this.cycleNumber++;
    this.currentTrend = undefined;
    this.phase = 'IDLE';
    this.resetMartingale();
    this.clearCycleTimer();

    this.logger.log(`[${this.userId}] 🔄 FTT CYCLE ${this.cycleNumber}: Starting`);
    this.callbacks.onStatusChange(`FTT CYCLE ${this.cycleNumber}: Menunggu batas menit...`);

    this.runCycle().catch((err) => {
      this.logger.error(`[${this.userId}] FTT CYCLE ${this.cycleNumber} unhandled error: ${err.message}`);
      if (this.isRunning) {
        this.scheduleNewCycle(CYCLE_RESTART_DELAY_MS);
      }
    });
  }

  private async runCycle(): Promise<void> {
    this.phase = 'WAITING_MINUTE_1';
    const firstBoundary = this.getNextMinuteBoundary();
    const waitToFirst = firstBoundary - Date.now();

    this.logger.log(
      `[${this.userId}] FTT CYCLE ${this.cycleNumber}: ` +
      `Waiting ${waitToFirst}ms to first minute boundary`,
    );

    if (waitToFirst > 0) await this.sleep(waitToFirst);
    if (!this.isRunning) return;

    await this.sleep(FIRST_FETCH_OFFSET_MS);
    if (!this.isRunning) return;

    this.phase = 'FETCHING_1';
    this.callbacks.onStatusChange(`FTT CYCLE ${this.cycleNumber}: Mengambil candle pertama...`);

    const price1 = await this.fetchCandleClosePrice();

    if (price1 === null) {
      this.logger.warn(`[${this.userId}] FTT CYCLE ${this.cycleNumber}: First fetch failed, restarting`);
      if (this.isRunning) this.scheduleNewCycle(CYCLE_RESTART_DELAY_MS);
      return;
    }

    this.logger.log(`[${this.userId}] FTT CYCLE ${this.cycleNumber}: Price 1 = ${price1}`);

    this.phase = 'WAITING_MINUTE_2';
    this.callbacks.onStatusChange(`FTT CYCLE ${this.cycleNumber}: Menunggu menit kedua (Price1=${price1})...`);

    const secondBoundary = firstBoundary + 60_000;
    const waitToSecond = secondBoundary - Date.now();

    if (waitToSecond > 0) await this.sleep(waitToSecond);
    if (!this.isRunning) return;

    await this.sleep(SECOND_FETCH_OFFSET_MS);
    if (!this.isRunning) return;

    this.phase = 'FETCHING_2';
    this.callbacks.onStatusChange(`FTT CYCLE ${this.cycleNumber}: Mengambil candle kedua...`);

    const price2 = await this.fetchCandleClosePrice();

    if (price2 === null) {
      this.logger.warn(`[${this.userId}] FTT CYCLE ${this.cycleNumber}: Second fetch failed, restarting`);
      if (this.isRunning) this.scheduleNewCycle(CYCLE_RESTART_DELAY_MS);
      return;
    }

    this.logger.log(`[${this.userId}] FTT CYCLE ${this.cycleNumber}: Price 2 = ${price2}`);

    this.phase = 'ANALYZING';

    const trend = this.determineTrend(price1, price2);

    if (trend === null) {
      this.logger.log(
        `[${this.userId}] FTT CYCLE ${this.cycleNumber}: ` +
        `Harga sama (${price1}), memulai cycle baru`,
      );
      this.callbacks.onStatusChange(
        `FTT CYCLE ${this.cycleNumber}: Harga sama — cycle ulang`,
      );
      if (this.isRunning) this.scheduleNewCycle(CYCLE_RESTART_DELAY_MS);
      return;
    }

    this.currentTrend = trend;
    const priceChange = price2 - price1;
    this.logger.log(
      `[${this.userId}] FTT CYCLE ${this.cycleNumber}: ` +
      `Trend=${trend.toUpperCase()} (Δ=${priceChange > 0 ? '+' : ''}${priceChange.toFixed(6)})`,
    );
    this.callbacks.onStatusChange(
      `FTT CYCLE ${this.cycleNumber}: Trend ${trend.toUpperCase()} — Eksekusi segera`,
    );

    await this.executeWithTrend(trend, 0);
  }

  private async executeWithTrend(trend: TrendType, step: number, retryCount = 0): Promise<void> {
    if (!this.isRunning) return;

    const MAX_RETRIES = 3;
    if (retryCount >= MAX_RETRIES) {
      this.logger.error(
        `[${this.userId}] FTT: Trade gagal ${MAX_RETRIES}x berturut-turut — bot dihentikan`,
      );
      this.callbacks.onStatusChange(
        `FTT: Trade gagal ${MAX_RETRIES}x — cek konfigurasi amount/koneksi`,
      );
      this.stop();
      return;
    }

    this.phase = 'EXECUTING';
    const amount = this.calcAmount(step);

    this.logger.log(
      `[${this.userId}] FTT: Execute trend=${trend.toUpperCase()} amount=${amount} step=${step} ` +
      `cycle=${this.cycleNumber}` +
      (retryCount > 0 ? ` (retry ${retryCount}/${MAX_RETRIES})` : ''),
    );

    const order = await this.executeTrade(trend, amount, step, this.cycleNumber);

    if (!order) {
      if (!this.isRunning) return;

      this.logger.error(
        `[${this.userId}] FTT: Trade placement failed — retry ${retryCount + 1}/${MAX_RETRIES} in 2s`,
      );
      setTimeout(() => {
        if (this.isRunning) this.executeWithTrend(trend, step, retryCount + 1);
      }, 2000);
      return;
    }

    this.activeOrder = order;
    this.phase = 'WAITING_RESULT';
    this.callbacks.onStatusChange(
      `FTT CYCLE ${this.cycleNumber}: Menunggu hasil ${trend.toUpperCase()} (step=${step})...`,
    );

    this.startResultTimeout(order.id, RESULT_TIMEOUT_MS);
  }

  protected onWin(order: FastradeOrder): void {
    const trend = this.currentTrend ?? order.trend;
    this.logger.log(`[${this.userId}] FTT WIN — same trend: ${trend.toUpperCase()}`);
    this.callbacks.onStatusChange(`FTT WIN ✅ — Lanjut ${trend.toUpperCase()} segera`);
    this.resetMartingale();

    setTimeout(() => {
      if (this.isRunning) this.executeWithTrend(trend, 0);
    }, 200);
  }

  protected onLose(order: FastradeOrder): void {
    const m = this.config.martingale;
    const trend = this.currentTrend ?? order.trend;

    // Jika Always Signal mode aktif, loss sudah di-handle di handleDealResult
    // dan martingale akan di-trigger pada cycle berikutnya
    if (m.isEnabled && m.isAlwaysSignal) {
      this.phase = 'ALWAYS_SIGNAL_WAITING';
      this.logger.log(
        `[${this.userId}] FTT LOSE — Always Signal: Menunggu sinyal berikutnya ` +
        `untuk martingale step ${this.alwaysSignalLossState?.currentMartingaleStep ?? 1}`
      );
      this.callbacks.onStatusChange(
        `FTT LOSE — Always Signal: Menunggu sinyal berikutnya...`
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
        this.martingaleStep = nextStep;
        this.martingaleActive = true;
        this.martingaleTotalLoss += order.amount;

        this.logger.log(
          `[${this.userId}] FTT LOSE — Martingale step ${nextStep}/${m.maxSteps} ` +
          `trend=${trend.toUpperCase()}`,
        );
        this.callbacks.onStatusChange(
          `FTT LOSE — Martingale ${nextStep}/${m.maxSteps} ${trend.toUpperCase()}`,
        );

        setTimeout(() => {
          if (this.isRunning) this.executeWithTrend(trend, nextStep);
        }, 200);
        return;
      }

      // Martingale max step tercapai → langsung reverse arah dan order (tanpa tunggu cycle baru)
      const reversedTrend = this.reverseTrend(trend);
      this.currentTrend = reversedTrend;
      this.resetMartingale();

      this.logger.log(
        `[${this.userId}] FTT: Martingale max reached (step ${this.martingaleStep}/${m.maxSteps}) ` +
        `— REVERSE ${trend.toUpperCase()} → ${reversedTrend.toUpperCase()} (langsung order)`,
      );
      this.callbacks.onStatusChange(
        `FTT Martingale max ❌ — REVERSED → ${reversedTrend.toUpperCase()} (order segera)`,
      );

      setTimeout(() => {
        if (this.isRunning) this.executeWithTrend(reversedTrend, 0);
      }, 200);
      return;
    }

    this.phase = 'WAITING_LOSS_DELAY';
    this.resetMartingale();

    this.logger.log(
      `[${this.userId}] FTT LOSE — Waiting ${DIRECT_LOSS_DELAY_MS / 1000}s before new cycle`,
    );
    this.callbacks.onStatusChange(
      `FTT LOSE ❌ — Tunggu ${DIRECT_LOSS_DELAY_MS / 1000}s lalu cycle baru...`,
    );

    this.scheduleNewCycle(DIRECT_LOSS_DELAY_MS);
  }

  protected onDraw(order: FastradeOrder): void {
    const trend = this.currentTrend ?? order.trend;
    this.logger.log(`[${this.userId}] FTT DRAW — continue ${trend.toUpperCase()}`);
    this.callbacks.onStatusChange(`FTT DRAW — Lanjut ${trend.toUpperCase()}`);

    setTimeout(() => {
      if (this.isRunning) this.executeWithTrend(trend, this.martingaleStep);
    }, 200);
  }

  private scheduleNewCycle(delayMs: number) {
    this.clearCycleTimer();
    this.cycleTimer = setTimeout(() => {
      if (this.isRunning) this.startNewCycle();
    }, delayMs);
  }

  private clearCycleTimer() {
    if (this.cycleTimer) {
      clearTimeout(this.cycleTimer);
      this.cycleTimer = undefined;
    }
  }

  getStatus() {
    return {
      ...super.getStatus(),
      mode: 'FTT',
      phase: this.phase,
    };
  }
}