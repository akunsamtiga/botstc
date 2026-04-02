import { Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { StockityWebSocketClient, DealResultPayload } from './websocket-client';
import {
  ScheduledOrder, ScheduleConfig, BotState,
  AlwaysSignalLossState, TradeOrderData,
  ExecutionLog, TrendType,
} from './types';

const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;
const EXECUTION_ADVANCE_MS = 2000;
const PRECISION_CHECK_MS = 100;
const EXECUTION_WINDOW_MS = 4900;
const MARTINGALE_MAX_DURATION_MS = 600000;
const STEP_STUCK_THRESHOLD_MS = 150000;
const MIN_PREP_TIME_MS = 10000;

export interface ExecutorCallbacks {
  onOrdersUpdate: (orders: ScheduledOrder[]) => void;
  onLog: (log: ExecutionLog) => void;
  onAllCompleted: () => void;
  onStatusChange: (status: string) => void;
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
    this.alwaysSignalLossState = undefined;
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
    if (this.activeMartingaleOrderId) {
      const idx = this.orders.findIndex(o => o.id === this.activeMartingaleOrderId);
      if (idx !== -1) {
        this.orders[idx] = {
          ...this.orders[idx],
          martingaleState: {
            ...this.orders[idx].martingaleState,
            isActive: false, isCompleted: true,
            finalResult: 'FAILED', failureReason: 'Bot stopped',
          },
        };
      }
    }
    this.activeMartingaleOrderId = undefined;
    this.martingaleStartTime = undefined;
    this.alwaysSignalLossState = undefined;
    this.callbacks.onOrdersUpdate(this.orders);
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
    if (this.activeMartingaleOrderId === orderId) this.activeMartingaleOrderId = undefined;
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
    if (this.botState === 'RUNNING') this.stop();
    this.callbacks.onOrdersUpdate([]);
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

      // Expired — lebih dari 5 detik melewati window
      if (timeUntil < -EXECUTION_WINDOW_MS) {
        this.orders[i] = { ...order, isSkipped: true, skipReason: `Expired ${Math.abs(timeUntil)}ms ago` };
        changed = true;
        this.logger.warn(`[${this.userId}] ⏭️ Skipped expired: ${order.time} ${order.trend}`);
        continue;
      }

      // Execute window: dari 0ms hingga -EXECUTION_WINDOW_MS (4900ms)
      if (timeUntil <= 0 && timeUntil >= -EXECUTION_WINDOW_MS) {
        if (this.activeMartingaleOrderId && this.activeMartingaleOrderId !== order.id) {
          this.orders[i] = { ...order, isSkipped: true, skipReason: 'Martingale aktif dari order lain' };
          changed = true;
          continue;
        }
        if (timeUntil < -2000) {
          this.logger.warn(`[${this.userId}] ⚠️ LATE EXECUTION ${order.time}: ${Math.abs(timeUntil)}ms (still within window)`);
        }
        this.orders[i] = { ...order, isExecuted: true };
        changed = true;
        // isScheduledOrder = true → createdAt pakai floor(now/1000) tanpa +1
        this.executeOrder(this.orders[i], true);
      }
    }

    // Hapus order hari kemarin yang sudah selesai
    const startToday = this.getStartOfJakartaDay();
    const before = this.orders.length;
    this.orders = this.orders.filter(o => !((o.isExecuted || o.isSkipped) && o.timeInMillis < startToday));
    if (this.orders.length !== before) changed = true;

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
      // Order terjadwal: isScheduledOrder=true (createdAt = floor tanpa +1)
      tradeData = this.buildTradeOrder(order.trend, amount, true);
    } catch (err: any) {
      this.logger.error(`[${this.userId}] ❌ Trade timing error: ${err.message}`);
      this.callbacks.onLog({
        id: uuidv4(), orderId: order.id, time: order.time,
        trend: order.trend, amount, martingaleStep: step,
        result: 'FAILED', executedAt: Date.now(),
        note: `Timing error: ${err.message}`,
      });
      return;
    }

    const dealId = await this.wsClient.placeTrade(tradeData);

    if (dealId) {
      const idx = this.orders.findIndex(o => o.id === order.id);
      if (idx !== -1) {
        this.orders[idx] = { ...this.orders[idx], activeDealId: dealId };
        this.callbacks.onOrdersUpdate(this.orders);
      }
    } else {
      this.logger.error(`[${this.userId}] ❌ Trade failed for ${order.id}`);
      if (isAlways) this.advanceAlwaysSignalLoss(order, step, amount);
    }

    this.callbacks.onLog({
      id: uuidv4(), orderId: order.id, time: order.time,
      trend: order.trend, amount, martingaleStep: step,
      dealId: dealId ?? undefined,
      result: dealId ? undefined : 'FAILED',
      executedAt: Date.now(),
    });
  }

  // ── Deal Result ──────────────────────────────

  private handleDealResult(payload: DealResultPayload) {
    const dealId = payload.id;
    const s = (payload.status || payload.result || '').toLowerCase();
    const isWin = s === 'won' || s === 'win';
    const isDraw = s === 'stand' || s === 'draw' || s === 'tie';

    const orderIdx = this.orders.findIndex(o => o.activeDealId === dealId);

    if (orderIdx === -1) {
      if (this.activeMartingaleOrderId) {
        const mIdx = this.orders.findIndex(o => o.id === this.activeMartingaleOrderId);
        if (mIdx !== -1) this.processMartingaleResult(mIdx, isWin, isDraw, dealId);
      }
      return;
    }

    const order = this.orders[orderIdx];
    const isAlways = this.config.martingale.isEnabled && this.config.martingale.isAlwaysSignal;
    const isRegular = this.config.martingale.isEnabled && !isAlways && this.config.martingale.maxSteps > 1;

    if (isDraw) { this.completeOrder(orderIdx, 'DRAW', dealId); return; }

    if (isWin) {
      if (isAlways) this.alwaysSignalLossState = undefined;
      if (this.activeMartingaleOrderId === order.id) {
        this.activeMartingaleOrderId = undefined;
        this.martingaleStartTime = undefined;
      }
      this.completeOrder(orderIdx, 'WIN', dealId);
    } else {
      if (isAlways) {
        const step = this.alwaysSignalLossState?.currentMartingaleStep ?? 0;
        this.advanceAlwaysSignalLoss(order, step, this.calcAmount(step));
        this.completeOrder(orderIdx, 'LOSE', dealId);
      } else if (isRegular) {
        this.startMartingale(order, orderIdx);
      } else {
        this.completeOrder(orderIdx, 'LOSE', dealId);
      }
    }
  }

  private processMartingaleResult(orderIdx: number, isWin: boolean, isDraw: boolean, dealId: string) {
    const order = this.orders[orderIdx];
    const step = order.martingaleState.currentStep;
    const max = this.config.martingale.maxSteps;

    if (isDraw) {
      this.activeMartingaleOrderId = undefined;
      this.martingaleStartTime = undefined;
      this.completeOrder(orderIdx, 'DRAW', dealId);
      return;
    }
    if (isWin) {
      this.activeMartingaleOrderId = undefined;
      this.martingaleStartTime = undefined;
      this.completeOrder(orderIdx, 'WIN', dealId);
    } else {
      if (step >= max) {
        this.activeMartingaleOrderId = undefined;
        this.martingaleStartTime = undefined;
        this.completeOrder(orderIdx, 'LOSE', dealId);
      } else {
        const next = step + 1;
        this.updateMartingaleStep(orderIdx, next);
        // Martingale = instant trade → isScheduledOrder = false → createdAt pakai +1
        this.placeMartingaleTrade(order, next, this.calcAmount(next));
        this.logger.log(`[${this.userId}] 🔄 Martingale step ${next}/${max}`);
      }
    }
  }

  private async placeMartingaleTrade(order: ScheduledOrder, step: number, amount: number) {
    let tradeData: TradeOrderData;
    try {
      // Martingale/instant → isScheduledOrder = false → createdAt = floor(now/1000) + 1
      tradeData = this.buildTradeOrder(order.trend, amount, false);
    } catch (err: any) {
      this.logger.error(`[${this.userId}] ❌ Martingale timing error step ${step}: ${err.message}`);
      this.callbacks.onLog({
        id: uuidv4(), orderId: order.id, time: order.time, trend: order.trend,
        amount, martingaleStep: step,
        result: 'FAILED', executedAt: Date.now(),
        note: `Martingale timing error step ${step}: ${err.message}`,
      });
      return;
    }

    const dealId = await this.wsClient.placeTrade(tradeData);
    if (dealId) {
      const idx = this.orders.findIndex(o => o.id === order.id);
      if (idx !== -1) {
        this.orders[idx] = { ...this.orders[idx], activeDealId: dealId };
        this.callbacks.onOrdersUpdate(this.orders);
      }
    }
    this.callbacks.onLog({
      id: uuidv4(), orderId: order.id, time: order.time, trend: order.trend,
      amount, martingaleStep: step, dealId: dealId ?? undefined,
      result: dealId ? undefined : 'FAILED', executedAt: Date.now(),
      note: `Martingale step ${step}`,
    });
  }

  private startMartingale(order: ScheduledOrder, orderIdx: number) {
    this.activeMartingaleOrderId = order.id;
    this.martingaleStartTime = Date.now();
    const step = 1;
    this.updateMartingaleStep(orderIdx, step);
    this.placeMartingaleTrade(order, step, this.calcAmount(step));
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
    this.orders[orderIdx] = {
      ...order, result,
      activeDealId: dealId,
      martingaleState: {
        ...order.martingaleState,
        isActive: false, isCompleted: true,
        finalResult, lastUpdateTime: Date.now(),
      },
    };
    this.callbacks.onOrdersUpdate(this.orders);
    this.logger.log(`[${this.userId}] ✅ ${order.time} ${order.trend} → ${result}`);
  }

  // ── Stuck Martingale Cleanup ──────────────────

  private checkStuckMartingale(now: number) {
    if (!this.activeMartingaleOrderId) return;
    const idx = this.orders.findIndex(o => o.id === this.activeMartingaleOrderId);
    if (idx === -1) { this.activeMartingaleOrderId = undefined; this.martingaleStartTime = undefined; return; }
    const o = this.orders[idx];
    const dur = this.martingaleStartTime ? now - this.martingaleStartTime : 0;
    const stepDur = o.martingaleState.lastUpdateTime ? now - o.martingaleState.lastUpdateTime : 0;
    if (dur > MARTINGALE_MAX_DURATION_MS || stepDur > STEP_STUCK_THRESHOLD_MS || o.martingaleState.isCompleted) {
      this.logger.warn(`[${this.userId}] ⚠️ Force-complete stuck martingale (dur=${dur}ms stepDur=${stepDur}ms)`);
      this.orders[idx] = {
        ...o,
        martingaleState: {
          ...o.martingaleState,
          isActive: false, isCompleted: true,
          finalResult: 'FAILED',
          failureReason: dur > MARTINGALE_MAX_DURATION_MS
            ? `Timeout: ${dur / 1000}s > ${MARTINGALE_MAX_DURATION_MS / 1000}s`
            : stepDur > STEP_STUCK_THRESHOLD_MS
              ? `Step stuck: ${stepDur / 1000}s at step ${o.martingaleState.currentStep}`
              : 'Inconsistent state: already completed',
        },
      };
      this.activeMartingaleOrderId = undefined;
      this.martingaleStartTime = undefined;
      this.callbacks.onOrdersUpdate(this.orders);
    }
  }

  // ── Completion Check ──────────────────────────

  private startCompletionCheck() {
    this.stopCompletionCheck();
    this.completionTimer = setInterval(() => this.checkCompletion(), 5000);
  }

  private stopCompletionCheck() {
    if (this.completionTimer) { clearInterval(this.completionTimer); this.completionTimer = undefined; }
  }

  private checkCompletion() {
    if (this.botState !== 'RUNNING') return;
    const now = Date.now();
    if (now - this.lastCompletionCheck < 5000) return;
    this.lastCompletionCheck = now;
    const hasPending = this.orders.some(o => !o.isExecuted && !o.isSkipped);
    const hasIncompleteMart = this.orders.some(o => o.martingaleState.isActive && !o.martingaleState.isCompleted);
    // ✅ FIX: Tunggu order yang sudah execute tapi belum dapat dealId atau result
    // (trade masih dalam proses konfirmasi dari WebSocket / placeTrade masih await)
    const hasAwaitingResult = this.orders.some(
      o => o.isExecuted && !o.isSkipped && !o.activeDealId && !o.result,
    );
    if (!hasPending && !this.activeMartingaleOrderId && !hasIncompleteMart && !hasAwaitingResult && this.orders.length > 0) {
      this.logger.log(`[${this.userId}] ✅ All schedules completed`);
      setTimeout(() => { this.stop(); this.callbacks.onAllCompleted(); }, 3000);
    }
  }

  // ── Trade Builder (sesuai logika Kotlin TradeManager) ──────

  /**
   * Membangun TradeOrderData dengan timing persis seperti Kotlin createTradeOrder().
   *
   * @param trend       - 'call' | 'put'
   * @param amount      - nominal trade dalam satuan terkecil (cents)
   * @param isScheduledOrder - true untuk order terjadwal (createdAt = floor tanpa +1)
   *                          false untuk martingale/instant (createdAt = floor + 1)
   *
   * Alur (identik dengan Kotlin):
   *  1. createdAtSeconds = floor(nowMs/1000) [+1 jika bukan scheduled]
   *  2. secondsInMinute = createdAtSeconds % 60
   *  3. expireAt awal:
   *     - secondsInMinute <= 10 → createdAt + (60 - secondsInMinute)   ← boundary menit ini
   *     - else               → createdAt + (120 - secondsInMinute)  ← boundary 2 menit
   *  4. Koreksi: duration < 55 || > 120 → finalExpireAt = createdAt + 60
   *  5. Validasi: duration < 45 → throw; duration > 125 → throw; expireAt <= createdAt → throw
   *
   * Catatan: expireAt dikirim dalam DETIK ke WebSocket, createdAt dalam MILIDETIK.
   */
  private buildTradeOrder(trend: TrendType, amount: number, isScheduledOrder: boolean): TradeOrderData {
    const nowMs = Date.now();
    const nowFloorSeconds = Math.floor(nowMs / 1000);

    // Kotlin: scheduled = floor saja; instant/martingale = floor + 1
    const createdAtSeconds = isScheduledOrder ? nowFloorSeconds : nowFloorSeconds + 1;
    const secondsInMinute = createdAtSeconds % 60;

    // Hitung expireAt awal (dalam detik)
    let expireAtSeconds: number;
    if (secondsInMinute <= 10) {
      // Dekat awal menit → target boundary menit ini (~60 - posisi saat ini)
      expireAtSeconds = createdAtSeconds + (60 - secondsInMinute);
    } else {
      // Lebih dari 10 detik → target boundary menit berikutnya (120 - posisi)
      expireAtSeconds = createdAtSeconds + (120 - secondsInMinute);
    }

    const duration = expireAtSeconds - createdAtSeconds;

    // Koreksi: jika durasi terlalu pendek (<55s) atau terlalu panjang (>120s), paksa 60s
    let finalExpireAt: number;
    if (duration < 55 || duration > 120) {
      finalExpireAt = createdAtSeconds + 60;
    } else {
      finalExpireAt = expireAtSeconds;
    }

    const finalDuration = finalExpireAt - createdAtSeconds;

    this.logger.debug(
      `[${this.userId}] Trade timing | scheduled=${isScheduledOrder} ` +
      `createdAt=${createdAtSeconds} expireAt=${finalExpireAt} duration=${finalDuration}s ` +
      `secondsInMinute=${secondsInMinute}`,
    );

    // Validasi ketat seperti Kotlin
    if (finalDuration < 45) {
      throw new Error(
        `Duration terlalu pendek: ${finalDuration}s (min 45s). ` +
        `createdAt=${createdAtSeconds} expireAt=${finalExpireAt} secondsInMinute=${secondsInMinute}`,
      );
    }
    if (finalDuration > 125) {
      throw new Error(
        `Duration terlalu panjang: ${finalDuration}s (max 125s). ` +
        `createdAt=${createdAtSeconds} expireAt=${finalExpireAt} secondsInMinute=${secondsInMinute}`,
      );
    }
    if (finalExpireAt <= createdAtSeconds) {
      throw new Error(
        `expire_at tidak valid: expire(${finalExpireAt}) <= created(${createdAtSeconds})`,
      );
    }

    return {
      amount,
      createdAt: createdAtSeconds * 1000,   // ← MILIDETIK (sesuai Kotlin: createdAtMs = createdAtSeconds * 1000)
      dealType: this.config.isDemoAccount ? 'demo' : 'real',
      expireAt: finalExpireAt,               // ← DETIK (sesuai Kotlin: finalExpireAt dalam seconds)
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

  private getStartOfJakartaDay(): number {
    const d = new Date(Date.now() + JAKARTA_OFFSET_MS);
    d.setHours(0, 0, 0, 0);
    return d.getTime() - JAKARTA_OFFSET_MS;
  }

  getStatus(): object {
    const pending = this.orders.filter(o => !o.isExecuted && !o.isSkipped);
    const next = [...pending].sort((a, b) => a.timeInMillis - b.timeInMillis)[0];
    const now = Date.now();
    return {
      botState: this.botState,
      totalOrders: this.orders.length,
      pendingOrders: pending.length,
      executedOrders: this.orders.filter(o => o.isExecuted).length,
      skippedOrders: this.orders.filter(o => o.isSkipped).length,
      activeMartingaleOrderId: this.activeMartingaleOrderId ?? null,
      alwaysSignalActive: !!this.alwaysSignalLossState?.hasOutstandingLoss,
      alwaysSignalStep: this.alwaysSignalLossState?.currentMartingaleStep ?? 0,
      nextOrderTime: next?.time ?? null,
      nextOrderInSeconds: next ? Math.max(0, Math.floor((next.timeInMillis - EXECUTION_ADVANCE_MS - now) / 1000)) : null,
      wsConnected: this.wsClient.isConnected(),
    };
  }
}