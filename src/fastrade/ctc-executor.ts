import { Logger } from '@nestjs/common';
import { StockityWebSocketClient } from '../schedule/websocket-client';
import { FastradeBaseExecutor, FastradeExecutorCallbacks, SessionInfo } from './fastrade-base.executor';
import { FastradeConfig, FastradeOrder, TrendType } from './fastrade-types';

// ──────────────────────────────────────────────────────────────
// CTC (Candle-to-Candle) — mirrors Kotlin CTCOrderManager
//
// Logic:
//  1. Wait until next minute boundary + 300ms offset
//  2. Fetch candle close price  (price 1)
//  3. Wait another minute
//  4. Fetch candle close price  (price 2)
//  5. Compare:
//      price2 > price1 → CALL
//      price2 < price1 → PUT
//      price2 == price1 → PUT  (unlike FTT which restarts)
//  6. Sync to nearest 5-second boundary, then execute immediately
//  7. WIN  → SAME trend, execute immediately (no new candle fetch)
//  8. LOSE (martingale on)  → REVERSE trend, next step, execute immediately
//  8. LOSE (martingale off) → SAME trend, execute immediately (truly continuous)
//  9. DRAW → same trend, same step, execute immediately
//  10. Martingale max steps reached → REVERSE trend, reset, continue immediately
// ──────────────────────────────────────────────────────────────

const FIRST_FETCH_OFFSET_MS    = 300;
const SECOND_FETCH_OFFSET_MS   = 300;
const CYCLE_RESTART_DELAY_MS   = 2_000;
const RESULT_TIMEOUT_MS        = 180_000;

// Execution sync to 5-second boundary (Kotlin EXECUTION_SYNC_TO_BOUNDARY)
const BOUNDARY_INTERVAL_SECS   = 5;
// Minimum seconds before minute end to allow execution (Kotlin EXECUTION_MIN_ADVANCE_MS)
const EXECUTION_MIN_ADVANCE_MS = 5_000;

type CtcPhase =
  | 'IDLE'
  | 'WAITING_MINUTE_1'
  | 'FETCHING_1'
  | 'WAITING_MINUTE_2'
  | 'FETCHING_2'
  | 'ANALYZING'
  | 'WAITING_EXEC_SYNC'
  | 'EXECUTING'
  | 'WAITING_RESULT';

export class CtcExecutor extends FastradeBaseExecutor {
  private phase: CtcPhase = 'IDLE';

  /**
   * activeTrend = the trend that should be executed next.
   * Differs from currentTrend when martingale reverses direction.
   * Mirrors Kotlin currentActiveTrend.
   */
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

  // ── Lifecycle ──────────────────────────────────────

  stop() {
    super.stop();
    this.activeTrend = undefined;
  }

  // ── Cycle ──────────────────────────────────────────

  protected startNewCycle(): void {
    if (!this.isRunning) return;

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
    // ── Step 1: Wait for next minute boundary ──────────
    this.phase = 'WAITING_MINUTE_1';
    const firstBoundary = this.getNextMinuteBoundary();
    const waitToFirst = firstBoundary - Date.now();

    this.logger.log(
      `[${this.userId}] CTC CYCLE ${this.cycleNumber}: ` +
      `Waiting ${waitToFirst}ms to first minute boundary`,
    );

    if (waitToFirst > 0) await this.sleep(waitToFirst);
    if (!this.isRunning) return;

    await this.sleep(FIRST_FETCH_OFFSET_MS);
    if (!this.isRunning) return;

    // ── Step 2: Fetch first candle ─────────────────────
    this.phase = 'FETCHING_1';
    this.callbacks.onStatusChange(`CTC CYCLE ${this.cycleNumber}: Mengambil candle pertama...`);

    const price1 = await this.fetchCandleClosePrice();

    if (price1 === null) {
      this.logger.warn(`[${this.userId}] CTC CYCLE ${this.cycleNumber}: First fetch failed, restarting`);
      if (this.isRunning) setTimeout(() => this.startNewCycle(), CYCLE_RESTART_DELAY_MS);
      return;
    }

    this.logger.log(`[${this.userId}] CTC CYCLE ${this.cycleNumber}: Price 1 = ${price1}`);

    // ── Step 3: Wait for second minute boundary ────────
    this.phase = 'WAITING_MINUTE_2';
    this.callbacks.onStatusChange(`CTC CYCLE ${this.cycleNumber}: Menunggu menit kedua (Price1=${price1})...`);

    const secondBoundary = firstBoundary + 60_000;
    const waitToSecond = secondBoundary - Date.now();

    if (waitToSecond > 0) await this.sleep(waitToSecond);
    if (!this.isRunning) return;

    await this.sleep(SECOND_FETCH_OFFSET_MS);
    if (!this.isRunning) return;

    // ── Step 4: Fetch second candle ────────────────────
    this.phase = 'FETCHING_2';
    this.callbacks.onStatusChange(`CTC CYCLE ${this.cycleNumber}: Mengambil candle kedua...`);

    const price2 = await this.fetchCandleClosePrice();

    if (price2 === null) {
      this.logger.warn(`[${this.userId}] CTC CYCLE ${this.cycleNumber}: Second fetch failed, restarting`);
      if (this.isRunning) setTimeout(() => this.startNewCycle(), CYCLE_RESTART_DELAY_MS);
      return;
    }

    this.logger.log(`[${this.userId}] CTC CYCLE ${this.cycleNumber}: Price 2 = ${price2}`);

    // ── Step 5: Determine trend ────────────────────────
    // CTC: equal price → 'put' (unlike FTT which restarts)
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

    // ── Step 6: Sync to 5-second boundary ─────────────
    this.phase = 'WAITING_EXEC_SYNC';
    const execTime = this.calculateOptimalExecutionTime();
    const waitForExec = execTime - Date.now();

    if (waitForExec > 0) {
      this.logger.log(
        `[${this.userId}] CTC CYCLE ${this.cycleNumber}: ` +
        `Syncing to 5s boundary, wait ${waitForExec}ms`,
      );
      await this.sleep(waitForExec);
    }

    if (!this.isRunning) return;

    this.callbacks.onStatusChange(
      `CTC CYCLE ${this.cycleNumber}: Eksekusi ${trend.toUpperCase()} segera`,
    );

    // ── Step 7: Execute first trade ────────────────────
    await this.executeWithTrend(trend, 0);
  }

  // ── Execution timing (Kotlin calculateOptimalExecutionTime) ────

  /**
   * Returns the next 5-second boundary timestamp.
   * If the resulting boundary is too close to the minute end
   * (< EXECUTION_MIN_ADVANCE_MS), uses the next cycle's boundary.
   * Mirrors Kotlin calculateOptimalExecutionTime().
   */
  private calculateOptimalExecutionTime(): number {
    const now = Date.now();
    const currentSec = Math.floor(now / 1000);
    const secInMinute = currentSec % 60;
    const secUntilNextBoundary = BOUNDARY_INTERVAL_SECS - (secInMinute % BOUNDARY_INTERVAL_SECS);

    const candidateMs = now + secUntilNextBoundary * 1000;
    const candidateSec = Math.floor(candidateMs / 1000);
    const secUntilMinuteEnd = 60 - (candidateSec % 60);

    if (secUntilMinuteEnd * 1000 < EXECUTION_MIN_ADVANCE_MS) {
      // Too close to minute end — jump to next available 5s boundary after current minute
      return candidateMs + 60_000;
    }

    return candidateMs;
  }

  // ── Trade execution helper ─────────────────────────

  private async executeWithTrend(trend: TrendType, step: number): Promise<void> {
    if (!this.isRunning) return;

    this.phase = 'EXECUTING';
    const amount = this.calcAmount(step);

    this.logger.log(
      `[${this.userId}] CTC: Execute trend=${trend.toUpperCase()} amount=${amount} step=${step} ` +
      `activeTrend=${this.activeTrend} cycle=${this.cycleNumber}`,
    );

    const order = await this.executeTrade(trend, amount, step, this.cycleNumber);

    if (!order) {
      // Trade failed — CTC retries immediately (no long delay, unlike FTT)
      this.logger.error(`[${this.userId}] CTC: Trade placement failed — retrying in 500ms`);
      setTimeout(() => {
        if (this.isRunning) this.executeWithTrend(trend, step);
      }, 500);
      return;
    }

    this.activeOrder = order;
    this.phase = 'WAITING_RESULT';
    this.callbacks.onStatusChange(
      `CTC CYCLE ${this.cycleNumber}: Menunggu hasil ${trend.toUpperCase()} (step=${step})...`,
    );

    this.startResultTimeout(order.id, RESULT_TIMEOUT_MS);
  }

  // ── Result callbacks ───────────────────────────────

  /**
   * WIN: keep same activeTrend, execute immediately.
   * Mirrors Kotlin handleCTCWin() — "KEEP_SAME_TREND".
   */
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

  /**
   * LOSE:
   *  - Martingale on  → REVERSE trend, next step, execute immediately
   *  - Martingale off → SAME trend, execute immediately (truly continuous, no delay)
   *
   * If martingale max steps reached → REVERSE trend, reset, continue immediately.
   * Mirrors Kotlin handleCTCLoss() + startNewCTCMartingaleUltraFast().
   */
  protected onLose(order: FastradeOrder): void {
    const m = this.config.martingale;
    const currentActiveTrend = this.activeTrend ?? this.currentTrend ?? order.trend;

    if (m.isEnabled && m.maxSteps > 0) {
      const nextStep = this.martingaleStep + 1;

      if (nextStep <= m.maxSteps) {
        // ── Martingale: REVERSE trend ───────────────
        const reversedTrend = this.reverseTrend(currentActiveTrend);
        this.activeTrend = reversedTrend;  // Update activeTrend BEFORE execute
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

      // ── Max martingale steps reached → REVERSE and continue ──
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

    // ── No martingale: SAME trend, continue immediately (CTC is continuous) ──
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

  /**
   * DRAW: continue without martingale (same trend, same step).
   * Mirrors Kotlin FIX [CTC-H1]: "DRAW lanjut tanpa martingale".
   */
  protected onDraw(order: FastradeOrder): void {
    const trend = this.activeTrend ?? this.currentTrend ?? order.trend;
    this.logger.log(`[${this.userId}] CTC DRAW — Continue ${trend.toUpperCase()} (no martingale)`);
    this.callbacks.onStatusChange(`CTC DRAW — Lanjut ${trend.toUpperCase()}`);

    setTimeout(() => {
      if (this.isRunning) this.executeWithTrend(trend, this.martingaleStep);
    }, 200);
  }

  // ── Status ─────────────────────────────────────────

  getStatus() {
    return {
      ...super.getStatus(),
      mode: 'CTC',
      phase: this.phase,
      activeTrend: this.activeTrend ?? null,
    };
  }
}