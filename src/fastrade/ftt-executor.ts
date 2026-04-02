import { Logger } from '@nestjs/common';
import { StockityWebSocketClient } from '../schedule/websocket-client';
import { FastradeBaseExecutor, FastradeExecutorCallbacks, SessionInfo } from './fastrade-base.executor';
import { FastradeConfig, FastradeOrder, TrendType } from './fastrade-types';

// ──────────────────────────────────────────────────────────────
// FTT (Follow Trade) — mirrors Kotlin FollowOrderManager
//
// Logic:
//  1. Wait until next minute boundary + 300ms offset
//  2. Fetch candle close price  (price 1)
//  3. Wait another minute
//  4. Fetch candle close price  (price 2)
//  5. Compare:
//      price2 > price1 → CALL
//      price2 < price1 → PUT
//      price2 == price1 → restart cycle (FIX [FOM-3])
//  6. Execute immediately
//  7. WIN  → same trend, execute immediately
//  8. LOSE (martingale on)  → same trend, next martingale step immediately
//  8. LOSE (martingale off) → wait DIRECT_LOSS_DELAY_MS (120s) → restart cycle
//  9. DRAW → same trend, same step, execute immediately
// ──────────────────────────────────────────────────────────────

const FIRST_FETCH_OFFSET_MS  = 300;
const SECOND_FETCH_OFFSET_MS = 300;
const DIRECT_LOSS_DELAY_MS   = 120_000;  // 2 min delay on direct loss (no martingale)
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
  | 'WAITING_LOSS_DELAY';

export class FttExecutor extends FastradeBaseExecutor {
  private phase: FttPhase = 'IDLE';

  // Cycle-level timers (separate from result timeout)
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

  // ── Lifecycle ──────────────────────────────────────

  stop() {
    this.clearCycleTimer();
    super.stop();
  }

  // ── Cycle ──────────────────────────────────────────

  protected startNewCycle(): void {
    if (!this.isRunning) return;

    this.cycleNumber++;
    this.currentTrend = undefined;
    this.phase = 'IDLE';
    this.resetMartingale();
    this.clearCycleTimer();

    this.logger.log(`[${this.userId}] 🔄 FTT CYCLE ${this.cycleNumber}: Starting`);
    this.callbacks.onStatusChange(`FTT CYCLE ${this.cycleNumber}: Menunggu batas menit...`);

    // Run async cycle (errors caught inside)
    this.runCycle().catch((err) => {
      this.logger.error(`[${this.userId}] FTT CYCLE ${this.cycleNumber} unhandled error: ${err.message}`);
      if (this.isRunning) {
        this.scheduleNewCycle(CYCLE_RESTART_DELAY_MS);
      }
    });
  }

  private async runCycle(): Promise<void> {
    // ── Step 1: Wait for next minute boundary ──────────
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

    // ── Step 2: Fetch first candle ─────────────────────
    this.phase = 'FETCHING_1';
    this.callbacks.onStatusChange(`FTT CYCLE ${this.cycleNumber}: Mengambil candle pertama...`);

    const price1 = await this.fetchCandleClosePrice();

    if (price1 === null) {
      this.logger.warn(`[${this.userId}] FTT CYCLE ${this.cycleNumber}: First fetch failed, restarting`);
      if (this.isRunning) this.scheduleNewCycle(CYCLE_RESTART_DELAY_MS);
      return;
    }

    this.logger.log(`[${this.userId}] FTT CYCLE ${this.cycleNumber}: Price 1 = ${price1}`);

    // ── Step 3: Wait for second minute boundary ────────
    this.phase = 'WAITING_MINUTE_2';
    this.callbacks.onStatusChange(`FTT CYCLE ${this.cycleNumber}: Menunggu menit kedua (Price1=${price1})...`);

    const secondBoundary = firstBoundary + 60_000;
    const waitToSecond = secondBoundary - Date.now();

    if (waitToSecond > 0) await this.sleep(waitToSecond);
    if (!this.isRunning) return;

    await this.sleep(SECOND_FETCH_OFFSET_MS);
    if (!this.isRunning) return;

    // ── Step 4: Fetch second candle ────────────────────
    this.phase = 'FETCHING_2';
    this.callbacks.onStatusChange(`FTT CYCLE ${this.cycleNumber}: Mengambil candle kedua...`);

    const price2 = await this.fetchCandleClosePrice();

    if (price2 === null) {
      this.logger.warn(`[${this.userId}] FTT CYCLE ${this.cycleNumber}: Second fetch failed, restarting`);
      if (this.isRunning) this.scheduleNewCycle(CYCLE_RESTART_DELAY_MS);
      return;
    }

    this.logger.log(`[${this.userId}] FTT CYCLE ${this.cycleNumber}: Price 2 = ${price2}`);

    // ── Step 5: Determine trend ────────────────────────
    this.phase = 'ANALYZING';

    // FTT: equal price → null → restart cycle (FIX [FOM-3])
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

    // ── Step 6: Execute first trade ────────────────────
    await this.executeWithTrend(trend, 0);
  }

  // ── Trade execution helpers ────────────────────────

  private async executeWithTrend(trend: TrendType, step: number): Promise<void> {
    if (!this.isRunning) return;

    this.phase = 'EXECUTING';
    const amount = this.calcAmount(step);

    this.logger.log(
      `[${this.userId}] FTT: Execute trend=${trend.toUpperCase()} amount=${amount} step=${step} ` +
      `cycle=${this.cycleNumber}`,
    );

    const order = await this.executeTrade(trend, amount, step, this.cycleNumber);

    if (!order) {
      // Trade placement failed
      this.logger.error(`[${this.userId}] FTT: Trade placement failed — waiting before new cycle`);
      if (this.isRunning) this.scheduleNewCycle(CYCLE_RESTART_DELAY_MS);
      return;
    }

    this.activeOrder = order;
    this.phase = 'WAITING_RESULT';
    this.callbacks.onStatusChange(
      `FTT CYCLE ${this.cycleNumber}: Menunggu hasil ${trend.toUpperCase()} (step=${step})...`,
    );

    this.startResultTimeout(order.id, RESULT_TIMEOUT_MS);
  }

  // ── Result callbacks ───────────────────────────────

  /**
   * WIN: keep same trend, execute immediately (no new candle analysis needed).
   */
  protected onWin(order: FastradeOrder): void {
    const trend = this.currentTrend ?? order.trend;
    this.logger.log(`[${this.userId}] FTT WIN — same trend: ${trend.toUpperCase()}`);
    this.callbacks.onStatusChange(`FTT WIN ✅ — Lanjut ${trend.toUpperCase()} segera`);
    this.resetMartingale();

    setTimeout(() => {
      if (this.isRunning) this.executeWithTrend(trend, 0);
    }, 200);
  }

  /**
   * LOSE:
   *  - Martingale on  → same trend, next step, execute immediately
   *  - Martingale off → wait 120 seconds then restart cycle with new candle analysis
   */
  protected onLose(order: FastradeOrder): void {
    const m = this.config.martingale;
    const trend = this.currentTrend ?? order.trend;

    if (m.isEnabled && m.maxSteps > 0) {
      const nextStep = this.martingaleStep + 1;

      if (nextStep <= m.maxSteps) {
        // ── Martingale: SAME trend ──────────────────
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

      // Max martingale steps reached → fall through to 120s delay + new cycle
      this.logger.log(
        `[${this.userId}] FTT: Martingale max reached (step ${this.martingaleStep}/${m.maxSteps}) — new cycle after delay`,
      );
    }

    // No martingale / max steps reached → 120s delay then new cycle
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

  /**
   * DRAW: same trend, same step, execute immediately.
   */
  protected onDraw(order: FastradeOrder): void {
    const trend = this.currentTrend ?? order.trend;
    this.logger.log(`[${this.userId}] FTT DRAW — continue ${trend.toUpperCase()}`);
    this.callbacks.onStatusChange(`FTT DRAW — Lanjut ${trend.toUpperCase()}`);

    setTimeout(() => {
      if (this.isRunning) this.executeWithTrend(trend, this.martingaleStep);
    }, 200);
  }

  // ── Timer helpers ──────────────────────────────────

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

  // ── Status ─────────────────────────────────────────

  getStatus() {
    return {
      ...super.getStatus(),
      mode: 'FTT',
      phase: this.phase,
    };
  }
}