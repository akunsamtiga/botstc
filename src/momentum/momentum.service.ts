import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';
import { AuthService } from '../auth/auth.service';
import { StockityWebSocketClient, DealResultPayload } from '../schedule/websocket-client';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import {
  MomentumType, MomentumSignal, MomentumOrder, MomentumMartingaleOrder,
  Candle, CandleApiResponse, BollingerBands, SignalState, MomentumStates,
  SIGNAL_COOLDOWN_MS, PRICE_MOVE_THRESHOLD, MAX_SIGNALS_PER_HOUR,
  SIGNAL_HISTORY_CLEANUP_MS, MAX_CANDLES_STORAGE, MIN_CANDLES_FOR_BB_SAR,
  CANDLES_5SEC_PER_MINUTE, FETCH_5SEC_OFFSET,
} from './types';

const BASE_URL = 'https://api.stockity.id';

/**
 * FIX: Hapus HTTP polling fetchTradeResult (selalu 404).
 * Ganti dengan WS deal result callback + promise resolver + 90s timeout fallback.
 */
const RESULT_TIMEOUT_MS = 90_000;

export interface MomentumConfig {
  asset: { ric: string; name: string } | null;
  enabledMomentums: {
    candleSabit: boolean;
    dojiTerjepit: boolean;
    dojiPembatalan: boolean;
    bbSarBreak: boolean;
  };
  martingale: {
    isEnabled: boolean;
    maxSteps: number;
    baseAmount: number;
    multiplierValue: number;
    multiplierType: 'FIXED' | 'PERCENTAGE';
  };
  isDemoAccount: boolean;
  currency: string;
}

export interface MomentumLog {
  id: string;
  orderId: string;
  momentumType: MomentumType;
  trend: string;
  amount: number;
  martingaleStep: number;
  dealId?: string;
  result?: string;
  profit?: number;
  sessionPnL?: number;
  executedAt: number;
  note?: string;
}

interface PendingDeal {
  amount: number;
  trend: string;
  placedAt: number;
  orderId: string;
  martingaleStep: number;
  resolve: (result: { isWin: boolean; profit: number }) => void;
  timeoutRef: NodeJS.Timeout;
}

interface ActiveModeState {
  isRunning: boolean;
  wsClient: StockityWebSocketClient;
  candleStorage: Candle[];
  momentumOrders: MomentumOrder[];
  activeMartingaleOrders: Map<string, MomentumMartingaleOrder>;
  activeMomentumOrders: Map<string, {
    momentumType: MomentumType; orderId: string; trend: string;
    executedTime: number; isSettled: boolean;
  }>;
  momentumStates: MomentumStates;
  totalExecutions: number;
  totalWins: number;
  totalLosses: number;
  sessionPnL: number;
  processedOrderIds: Set<string>;
  logs: MomentumLog[];
  pendingDeals: Map<string, PendingDeal>;
}

@Injectable()
export class MomentumService implements OnModuleDestroy {
  private readonly logger = new Logger(MomentumService.name);
  private configs = new Map<string, MomentumConfig>();
  private activeModes = new Map<string, ActiveModeState>();

  constructor(
    private readonly firebaseService: FirebaseService,
    private readonly authService: AuthService,
  ) {}

  onModuleDestroy() {
    for (const [userId] of this.activeModes) this.stopMomentumMode(userId);
  }

  // ==================== CONFIG ====================

  async getConfig(userId: string): Promise<MomentumConfig> {
    if (this.configs.has(userId)) return this.configs.get(userId)!;

    const doc = await this.firebaseService.db.collection('momentum_configs').doc(userId).get();
    if (doc.exists) {
      const d = doc.data() as any;
      const cfg: MomentumConfig = {
        asset: d.asset || null,
        enabledMomentums: d.enabledMomentums || { candleSabit: true, dojiTerjepit: true, dojiPembatalan: true, bbSarBreak: true },
        martingale: d.martingale || { isEnabled: true, maxSteps: 2, baseAmount: 1400000, multiplierValue: 2.5, multiplierType: 'FIXED' },
        isDemoAccount: d.isDemoAccount ?? true,
        currency: d.currency || 'IDR',
      };
      this.configs.set(userId, cfg);
      return cfg;
    }

    const def: MomentumConfig = {
      asset: null,
      enabledMomentums: { candleSabit: true, dojiTerjepit: true, dojiPembatalan: true, bbSarBreak: true },
      martingale: { isEnabled: true, maxSteps: 2, baseAmount: 1400000, multiplierValue: 2.5, multiplierType: 'FIXED' },
      isDemoAccount: true, currency: 'IDR',
    };
    this.configs.set(userId, def);
    return def;
  }

  async updateConfig(userId: string, dto: Partial<MomentumConfig>): Promise<MomentumConfig> {
    const current = await this.getConfig(userId);
    const updated = { ...current, ...dto };
    this.configs.set(userId, updated);
    await this.firebaseService.db.collection('momentum_configs').doc(userId).set(
      { ...JSON.parse(JSON.stringify(updated)), updatedAt: this.firebaseService.FieldValue.serverTimestamp() },
      { merge: true },
    );
    return updated;
  }

  // ==================== CONTROL ====================

  async startMomentumMode(userId: string): Promise<{ message: string; status: string }> {
    const existing = this.activeModes.get(userId);
    if (existing?.isRunning) return { message: 'Momentum mode sudah berjalan', status: 'RUNNING' };

    const session = await this.authService.getSession(userId);
    if (!session) throw new Error('Session tidak ditemukan');

    const config = await this.getConfig(userId);
    if (!config.asset?.ric) throw new Error('Asset belum dikonfigurasi');

    const ws = new StockityWebSocketClient(
      userId, session.stockityToken, session.deviceId,
      session.deviceType || 'web', session.userAgent,
    );

    // FIX: daftarkan WS deal result handler — satu-satunya sumber hasil trade
    ws.setOnDealResult((payload) => {
      this.handleWsDealResult(userId, payload).catch((err) =>
        this.logger.error(`[${userId}] WS deal result error: ${err.message}`),
      );
    });

    try {
      await ws.connect();
    } catch (err: any) {
      ws.disconnect();
      throw new Error(`Gagal koneksi WebSocket: ${err.message}`);
    }

    this.activeModes.set(userId, {
      isRunning: true, wsClient: ws,
      candleStorage: [], momentumOrders: [],
      activeMartingaleOrders: new Map(), activeMomentumOrders: new Map(),
      momentumStates: {
        candleSabit: this.createSignalState(), dojiTerjepit: this.createSignalState(),
        dojiPembatalan: this.createSignalState(), bbSarBreak: this.createSignalState(),
      },
      totalExecutions: 0, totalWins: 0, totalLosses: 0, sessionPnL: 0,
      processedOrderIds: new Set(), logs: [],
      pendingDeals: new Map(), // FIX: WS-based promise map
    });

    await this.updateStatus(userId, 'RUNNING');
    this.logger.log(`[${userId}] Momentum mode started`);
    this.startCandleStorageLoop(userId, config, session);

    return { message: 'Momentum mode dimulai', status: 'RUNNING' };
  }

  async stopMomentumMode(userId: string): Promise<{ message: string }> {
    const mode = this.activeModes.get(userId);
    if (!mode?.isRunning) return { message: 'Momentum mode tidak berjalan' };

    mode.isRunning = false;

    // Bersihkan pending deals saat stop
    for (const [, pending] of mode.pendingDeals) {
      clearTimeout(pending.timeoutRef);
      pending.resolve({ isWin: false, profit: 0 });
    }
    mode.pendingDeals.clear();
    mode.wsClient.disconnect();
    this.activeModes.delete(userId);

    await this.updateStatus(userId, 'STOPPED');
    this.logger.log(`[${userId}] Momentum mode stopped`);
    return { message: 'Momentum mode dihentikan' };
  }

  async getStatus(userId: string): Promise<object> {
    const mode = this.activeModes.get(userId);
    const config = await this.getConfig(userId);

    if (mode) {
      return {
        isRunning: mode.isRunning,
        botState: mode.isRunning ? 'RUNNING' : 'STOPPED',
        totalExecutions: mode.totalExecutions, totalWins: mode.totalWins,
        totalLosses: mode.totalLosses, totalTrades: mode.totalExecutions,
        sessionPnL: mode.sessionPnL, wsConnected: mode.wsClient.isConnected(),
        candleStorageCount: mode.candleStorage.length,
        pendingDeals: mode.pendingDeals.size,
        lastStatus: `Candles: ${mode.candleStorage.length} | Trades: ${mode.totalExecutions}`,
        config,
      };
    }

    const statusDoc = await this.firebaseService.db.collection('momentum_status').doc(userId).get();
    return {
      isRunning: false,
      botState: statusDoc.exists ? (statusDoc.data()?.botState ?? 'STOPPED') : 'STOPPED',
      totalExecutions: 0, totalWins: 0, totalLosses: 0, totalTrades: 0, sessionPnL: 0, config,
    };
  }

  async getLogs(userId: string, limit = 100): Promise<MomentumLog[]> {
    const mode = this.activeModes.get(userId);
    if (mode && mode.logs.length > 0) return mode.logs.slice(-limit);

    const snap = await this.firebaseService.db
      .collection('momentum_logs').doc(userId).collection('entries')
      .orderBy('executedAt', 'desc').limit(limit).get();

    return snap.docs.map((d) => {
      const data = d.data() as any;
      return { ...data, executedAt: data.executedAt?.toMillis?.() ?? data.executedAt ?? 0 } as MomentumLog;
    });
  }

  // ==================== CANDLE LOOP ====================

  private startCandleStorageLoop(userId: string, config: MomentumConfig, session: any) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    const runCycle = async () => {
      if (!mode.isRunning) return;
      try {
        const serverNow = Date.now();
        const nextMinuteStart = this.calculateNextMinuteStart(serverNow);
        const waitTime = nextMinuteStart - serverNow;
        if (waitTime > 0) await this.sleep(waitTime);
        if (!mode.isRunning) return;
        await this.sleep(FETCH_5SEC_OFFSET);

        const newCandle = await this.fetchAndAggregateOneMinuteCandle(config.asset!.ric, session);
        if (newCandle) {
          this.addCandleToStorage(userId, newCandle);
          if (mode.candleStorage.length >= 2) await this.analyzeAllMomentums(userId, config, session);
        }
      } catch (err) {
        this.logger.error(`[${userId}] Candle loop error: ${err}`);
      }
      if (mode.isRunning) setTimeout(() => runCycle(), 1000);
    };
    runCycle();
  }

  private calculateNextMinuteStart(serverTime: number): number {
    const seconds = Math.floor((serverTime / 1000) % 60);
    const millis = serverTime % 1000;
    return serverTime + ((60 - seconds) * 1000) - millis;
  }

  private async fetchAndAggregateOneMinuteCandle(symbol: string, session: any): Promise<Candle | null> {
    try {
      const encodedSymbol = symbol.replace('/', '%2F');
      const now = new Date();
      const dateForApi = now.toISOString().slice(0, 13) + ':00:00';
      const response = await axios.get<CandleApiResponse>(
        `${BASE_URL}/candles/v1/${encodedSymbol}/${dateForApi}/5`,
        { headers: this.buildStockityHeaders(session), timeout: 5000 },
      );
      if (response.data?.data) {
        const candles5Sec = response.data.data
          .map((d) => this.parseCandleData(d))
          .filter((c): c is Candle => c !== null);
        return this.aggregateCandlesToOneMinute(candles5Sec.slice(-CANDLES_5SEC_PER_MINUTE));
      }
      return null;
    } catch (err) {
      this.logger.error(`Error fetching candles: ${err}`);
      return null;
    }
  }

  private parseCandleData(data: any): Candle | null {
    try {
      const c: Candle = {
        open: parseFloat(data.open), close: parseFloat(data.close),
        high: parseFloat(data.high), low: parseFloat(data.low), createdAt: data.created_at,
      };
      return c.open > 0 && c.close > 0 ? c : null;
    } catch { return null; }
  }

  private aggregateCandlesToOneMinute(candles5Sec: Candle[]): Candle | null {
    if (candles5Sec.length === 0) return null;
    return {
      open: candles5Sec[0].open,
      close: candles5Sec[candles5Sec.length - 1].close,
      high: Math.max(...candles5Sec.map((c) => c.high)),
      low: Math.min(...candles5Sec.map((c) => c.low)),
      createdAt: candles5Sec[candles5Sec.length - 1].createdAt,
    };
  }

  private addCandleToStorage(userId: string, candle: Candle) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;
    mode.candleStorage.push(candle);
    if (mode.candleStorage.length > MAX_CANDLES_STORAGE) mode.candleStorage.shift();
    this.logger.debug(`[${userId}] Candle added. Storage: ${mode.candleStorage.length}/${MAX_CANDLES_STORAGE}`);
  }

  // ==================== ANALYSIS ====================

  private async analyzeAllMomentums(userId: string, config: MomentumConfig, session: any) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;
    const signals: MomentumSignal[] = [];

    if (config.enabledMomentums.candleSabit) {
      const s = this.analyzeCandleSabit(mode.candleStorage, mode.momentumStates.candleSabit);
      if (s) { signals.push(s); this.logger.log(`[${userId}] Signal: CANDLE_SABIT (${s.trend})`); }
    }
    if (config.enabledMomentums.dojiTerjepit) {
      const s = this.analyzeDojiTerjepit(mode.candleStorage, mode.momentumStates.dojiTerjepit);
      if (s) { signals.push(s); this.logger.log(`[${userId}] Signal: DOJI_TERJEPIT (${s.trend})`); }
    }
    if (config.enabledMomentums.dojiPembatalan) {
      const s = this.analyzeDojiPembatalan(mode.candleStorage, mode.momentumStates.dojiPembatalan);
      if (s) { signals.push(s); this.logger.log(`[${userId}] Signal: DOJI_PEMBATALAN (${s.trend})`); }
    }
    if (config.enabledMomentums.bbSarBreak && mode.candleStorage.length >= MIN_CANDLES_FOR_BB_SAR) {
      const s = this.analyzeBBSARBreak(mode.candleStorage, mode.momentumStates.bbSarBreak);
      if (s) { signals.push(s); this.logger.log(`[${userId}] Signal: BB_SAR_BREAK (${s.trend})`); }
    }

    for (const signal of signals) await this.executeMomentumOrder(userId, config, session, signal);
  }

  private analyzeCandleSabit(candles: Candle[], state: SignalState): MomentumSignal | null {
    if (candles.length < 4) return null;
    const last4 = candles.slice(-4);
    const [c1, c2, c3, c4] = last4;
    const t2 = this.getCandleTrend(c2), t3 = this.getCandleTrend(c3), t4 = this.getCandleTrend(c4);
    if (t2 !== t3 || t3 !== t4) return null;
    const b2 = Math.abs(c2.close - c2.open), b3 = Math.abs(c3.close - c3.open), b4 = Math.abs(c4.close - c4.open);
    if (!(b2 < b3 && b3 < b4)) return null;
    const signalTrend = t2 === 'buy' ? 'call' : 'put';
    if (!this.shouldAllowSignal(state, signalTrend, c4.close, Date.now())) return null;
    this.recordSignal(state, signalTrend, c4.close, Date.now());
    return { momentumType: MomentumType.CANDLE_SABIT, trend: signalTrend, confidence: this.calculateConfidence(b2, b3, b4), details: 'Candle Sabit: increasing body sizes' };
  }

  private analyzeDojiTerjepit(candles: Candle[], state: SignalState): MomentumSignal | null {
    if (candles.length < 4) return null;
    const last4 = candles.slice(-4);
    const [c1, c2, c3, c4] = last4;
    const t1 = this.getCandleTrend(c1), t2 = this.getCandleTrend(c2), t3 = this.getCandleTrend(c3);
    if (t1 !== t2 || t2 !== t3) return null;
    if (!(this.calculateBodyPercentage(c1) > 60 && this.calculateBodyPercentage(c2) > 60 && this.calculateBodyPercentage(c3) > 60 && this.calculateBodyPercentage(c4) < 10)) return null;
    const t4 = this.getCandleTrend(c4);
    let signalTrend: string;
    if (t1 === 'buy' && t4 === 'sell') signalTrend = 'put';
    else if (t1 === 'sell' && t4 === 'buy') signalTrend = 'call';
    else return null;
    if (!this.shouldAllowSignal(state, signalTrend, c4.close, Date.now())) return null;
    this.recordSignal(state, signalTrend, c4.close, Date.now());
    return { momentumType: MomentumType.DOJI_TERJEPIT, trend: signalTrend, confidence: 0.8, details: 'Doji Terjepit: 3 panjang + doji reversal' };
  }

  private analyzeDojiPembatalan(candles: Candle[], state: SignalState): MomentumSignal | null {
    if (candles.length < 2) return null;
    const [prev, cur] = candles.slice(-2);
    if (this.calculateBodyPercentage(cur) >= 10) return null;
    const prevTrend = this.getCandleTrend(prev), dojiTrend = this.getCandleTrend(cur);
    let signalTrend: string;
    if (prevTrend === 'sell' && dojiTrend === 'buy') signalTrend = 'call';
    else if (prevTrend === 'buy' && dojiTrend === 'sell') signalTrend = 'put';
    else return null;
    if (!this.shouldAllowSignal(state, signalTrend, cur.close, Date.now())) return null;
    this.recordSignal(state, signalTrend, cur.close, Date.now());
    return { momentumType: MomentumType.DOJI_PEMBATALAN, trend: signalTrend, confidence: 0.75, details: 'Doji Pembatalan: reversal' };
  }

  private analyzeBBSARBreak(candles: Candle[], state: SignalState): MomentumSignal | null {
    if (candles.length < MIN_CANDLES_FOR_BB_SAR) return null;
    const closePrice = candles[candles.length - 1].close;
    const bb = this.calculateBollingerBands(candles, 20, 2);
    const sar = this.calculateParabolicSAR(candles);
    if (!bb) return null;
    let currentSignal: string;
    if (closePrice > bb.upper && closePrice > sar) currentSignal = 'call';
    else if (closePrice < bb.lower && closePrice < sar) currentSignal = 'put';
    else return null;
    if (!this.shouldAllowSignal(state, currentSignal, closePrice, Date.now())) return null;
    this.recordSignal(state, currentSignal, closePrice, Date.now());
    return { momentumType: MomentumType.BB_SAR_BREAK, trend: currentSignal, confidence: 0.85, details: 'BB/SAR Break' };
  }

  // ==================== SIGNAL STATE ====================

  private createSignalState(): SignalState {
    return { lastSignal: null, lastSignalTime: 0, lastPrice: null, consecutiveSignals: 0, signalHistory: [], isOrderActive: false };
  }

  private shouldAllowSignal(state: SignalState, currentSignal: string, currentPrice: number, currentTime: number): boolean {
    if (currentSignal === state.lastSignal) {
      if (currentTime - state.lastSignalTime < SIGNAL_COOLDOWN_MS) return false;
      if (state.lastPrice !== null && Math.abs((currentPrice - state.lastPrice) / state.lastPrice) < PRICE_MOVE_THRESHOLD) return false;
    }
    this.cleanupOldSignals(state, currentTime);
    return state.signalHistory.length < MAX_SIGNALS_PER_HOUR;
  }

  private recordSignal(state: SignalState, signal: string, price: number, time: number) {
    state.lastSignal = signal; state.lastSignalTime = time; state.lastPrice = price;
    state.consecutiveSignals++; state.signalHistory.push(time);
  }

  private cleanupOldSignals(state: SignalState, currentTime: number) {
    state.signalHistory = state.signalHistory.filter((t) => currentTime - t <= SIGNAL_HISTORY_CLEANUP_MS);
  }

  // ==================== TECHNICAL ====================

  private getCandleTrend(candle: Candle): string { return candle.close > candle.open ? 'buy' : 'sell'; }

  private calculateBodyPercentage(candle: Candle): number {
    const range = Math.abs(candle.high - candle.low);
    return range === 0 ? 0 : (Math.abs(candle.close - candle.open) / range) * 100;
  }

  private calculateConfidence(body2: number, body3: number, body4: number): number {
    if (body2 === 0 || body3 === 0) return 0.5;
    return Math.min(0.9, 0.5 + (body3 / body2 + body4 / body3) * 0.1);
  }

  private calculateBollingerBands(candles: Candle[], period: number, stdDevMultiplier: number): BollingerBands | null {
    if (candles.length < period) return null;
    const closes = candles.slice(-period).map((c) => c.close);
    const sma = closes.reduce((a, b) => a + b, 0) / period;
    const stdDev = Math.sqrt(closes.reduce((acc, val) => acc + Math.pow(val - sma, 2), 0) / period);
    return { upper: sma + stdDev * stdDevMultiplier, middle: sma, lower: sma - stdDev * stdDevMultiplier };
  }

  private calculateParabolicSAR(candles: Candle[]): number {
    if (candles.length < 2) return candles[candles.length - 1].close;
    const last = candles[candles.length - 1], previous = candles[candles.length - 2];
    return last.close > previous.close ? Math.min(last.low, previous.low) : Math.max(last.high, previous.high);
  }

  // ==================== ORDER EXECUTION ====================

  private async executeMomentumOrder(userId: string, config: MomentumConfig, session: any, signal: MomentumSignal) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    const existing = mode.activeMomentumOrders.get(signal.momentumType);
    if (existing && !existing.isSettled) {
      this.logger.warn(`[${userId}] Duplicate prevented: ${signal.momentumType} already active`);
      return;
    }

    const orderId = uuidv4();
    const currentTime = Date.now();
    const amount = config.martingale.baseAmount;

    mode.momentumOrders.push({
      id: orderId, assetRic: config.asset!.ric, assetName: config.asset!.name,
      trend: signal.trend, amount, executionTime: currentTime,
      momentumType: signal.momentumType, confidence: signal.confidence,
      sourceCandle: mode.candleStorage[mode.candleStorage.length - 1],
      isExecuted: true, isSkipped: false,
      martingaleState: { isActive: false, currentStep: 0, isCompleted: false, totalLoss: 0, totalRecovered: 0 },
    });
    mode.activeMomentumOrders.set(signal.momentumType, {
      momentumType: signal.momentumType, orderId, trend: signal.trend, executedTime: currentTime, isSettled: false,
    });
    mode.totalExecutions++;

    this.logger.log(`[${userId}] Executing ${signal.momentumType}: ${signal.trend.toUpperCase()} amount=${amount}`);

    // Log eksekusi awal
    this.appendLog(userId, {
      id: orderId, orderId, momentumType: signal.momentumType, trend: signal.trend,
      amount, martingaleStep: 0, executedAt: currentTime, note: `${signal.momentumType} | ${signal.details}`,
    });

    const tradeResult = await mode.wsClient.placeTrade(this.buildTradePayload(session, config, amount, signal.trend));

    if (tradeResult?.dealId) {
      this.updateLog(userId, orderId, { dealId: tradeResult.dealId }, 0);
      this.logger.log(`[${userId}] Trade placed: dealId=${tradeResult.dealId}`);
    } else {
      this.logger.warn(`[${userId}] Trade placement no dealId for ${signal.momentumType}`);
    }

    // FIX: tunggu hasil via WS promise — tidak ada HTTP polling
    this.waitForDealResult(userId, config, session, orderId, signal.momentumType, amount, signal.trend, 0);
  }

  /**
   * FIX: Buat promise yang akan di-resolve oleh handleWsDealResult.
   * Fallback: timeout 90 detik → anggap LOSE untuk martingale.
   */
  private waitForDealResult(
    userId: string, config: MomentumConfig, session: any, orderId: string,
    momentumType: MomentumType, amount: number, trend: string, step: number,
  ) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    const pendingKey = uuidv4();
    const placedAt = Date.now();

    const timeoutRef = setTimeout(() => {
      if (!mode.pendingDeals.has(pendingKey)) return;
      mode.pendingDeals.delete(pendingKey);
      this.logger.warn(`[${userId}] Deal timeout: orderId=${orderId} step=${step}`);
      this.updateLog(userId, orderId, { result: 'TIMEOUT', note: 'Hasil tidak diterima dalam 90 detik' }, step);
      this.afterDealResult(userId, config, session, orderId, momentumType, false, 0, step);
    }, RESULT_TIMEOUT_MS);

    mode.pendingDeals.set(pendingKey, {
      amount, trend, placedAt, orderId, martingaleStep: step,
      timeoutRef,
      resolve: (result) => {
        clearTimeout(timeoutRef);
        mode.pendingDeals.delete(pendingKey);
        if (!mode.isRunning) return;

        mode.sessionPnL += result.profit;
        this.updateLog(userId, orderId, {
          result: result.isWin ? 'WIN' : 'LOSE',
          profit: result.profit, sessionPnL: mode.sessionPnL,
        }, step);

        if (result.isWin) mode.totalWins++; else mode.totalLosses++;
        this.logger.log(`[${userId}] ${momentumType} step=${step}: ${result.isWin ? 'WIN' : 'LOSE'} profit=${result.profit}`);
        this.afterDealResult(userId, config, session, orderId, momentumType, result.isWin, result.profit, step);
      },
    });
  }

  /**
   * FIX: Handler WS bo:closed. Cari pending deal yang cocok berdasarkan
   * amount + trend + 120 detik window, lalu resolve. Tidak ada HTTP polling.
   */
  private async handleWsDealResult(userId: string, payload: DealResultPayload) {
    const mode = this.activeModes.get(userId);
    if (!mode || mode.pendingDeals.size === 0) return;

    const result: string = (payload as any).result ?? (payload as any).status ?? '';
    const payloadAmount: number = (payload as any).amount ?? 0;
    const payloadTrend: string = (payload as any).trend ?? '';
    const isWin = /^(won|win)$/i.test(result);
    const profit = isWin ? ((payload as any).win ?? 0) : 0;

    const now = Date.now();

    for (const [key, pending] of mode.pendingDeals.entries()) {
      const withinWindow = now - pending.placedAt <= 120_000;
      const amountMatch = payloadAmount === 0 || payloadAmount === pending.amount;
      const trendMatch = !payloadTrend || payloadTrend === pending.trend;

      if (withinWindow && amountMatch && trendMatch) {
        this.logger.log(`[${userId}] WS deal matched: ${result} amount=${payloadAmount} trend=${payloadTrend}`);
        mode.pendingDeals.delete(key);
        pending.resolve({ isWin, profit: isWin ? profit : -pending.amount });
        return;
      }
    }

    this.logger.debug(`[${userId}] WS deal tidak cocok (amount=${payloadAmount} trend=${payloadTrend})`);
  }

  private afterDealResult(
    userId: string, config: MomentumConfig, session: any, orderId: string,
    momentumType: MomentumType, isWin: boolean, profit: number, step: number,
  ) {
    const mode = this.activeModes.get(userId);
    if (!mode || !mode.isRunning) return;

    const order = mode.momentumOrders.find((o) => o.id === orderId);
    if (order) {
      order.martingaleState.isCompleted = true;
      order.martingaleState.finalResult = isWin ? 'WIN' : 'LOSE';
      if (isWin) order.martingaleState.totalRecovered = profit;
      else order.martingaleState.totalLoss += config.martingale.baseAmount;
    }

    const activeOrder = mode.activeMomentumOrders.get(momentumType);
    if (activeOrder) activeOrder.isSettled = true;

    if (isWin) {
      mode.activeMomentumOrders.delete(momentumType);
      mode.activeMartingaleOrders.delete(orderId);
    } else if (config.martingale.isEnabled) {
      this.startMartingale(userId, config, session, orderId, momentumType, step + 1);
    } else {
      mode.activeMomentumOrders.delete(momentumType);
    }
  }

  private startMartingale(
    userId: string, config: MomentumConfig, session: any,
    parentOrderId: string, momentumType: MomentumType, step: number,
  ) {
    const mode = this.activeModes.get(userId);
    if (!mode || !mode.isRunning) return;

    if (step > config.martingale.maxSteps) {
      this.logger.log(`[${userId}] Max martingale (${config.martingale.maxSteps}) reached for ${momentumType}`);
      mode.activeMomentumOrders.delete(momentumType);
      mode.activeMartingaleOrders.delete(parentOrderId);
      return;
    }

    const martingaleAmount = this.calculateMartingaleAmount(config, step);
    const parentOrder = mode.momentumOrders.find((o) => o.id === parentOrderId);
    if (!parentOrder) return;

    this.logger.log(`[${userId}] ${momentumType} martingale step ${step}/${config.martingale.maxSteps}: amount=${martingaleAmount}`);

    mode.activeMartingaleOrders.set(parentOrderId, {
      originalOrderId: parentOrderId, momentumType, currentStep: step,
      maxSteps: config.martingale.maxSteps, totalLoss: parentOrder.amount,
      nextAmount: martingaleAmount, trend: parentOrder.trend, isActive: true,
    });

    const martingaleLogId = uuidv4();
    this.appendLog(userId, {
      id: martingaleLogId, orderId: parentOrderId, momentumType,
      trend: parentOrder.trend, amount: martingaleAmount, martingaleStep: step,
      executedAt: Date.now(), note: `Martingale step ${step}/${config.martingale.maxSteps}`,
    });

    mode.wsClient.placeTrade(this.buildTradePayload(session, config, martingaleAmount, parentOrder.trend))
      .then((tradeResult) => {
        if (tradeResult?.dealId) this.updateLog(userId, parentOrderId, { dealId: tradeResult.dealId }, step);
        this.waitForDealResult(userId, config, session, parentOrderId, momentumType, martingaleAmount, parentOrder.trend, step);
      })
      .catch((err) => this.logger.error(`[${userId}] Martingale trade error: ${err.message}`));
  }

  private calculateMartingaleAmount(config: MomentumConfig, step: number): number {
    const multiplier = config.martingale.multiplierType === 'FIXED'
      ? config.martingale.multiplierValue
      : 1 + config.martingale.multiplierValue / 100;
    return Math.floor(config.martingale.baseAmount * Math.pow(multiplier, step - 1));
  }

  // ==================== LOG HELPERS ====================

  private appendLog(userId: string, log: MomentumLog) {
    const mode = this.activeModes.get(userId);
    if (mode) {
      const idx = mode.logs.findIndex((l) => l.id === log.id);
      if (idx !== -1) mode.logs[idx] = log; else mode.logs.push(log);
      if (mode.logs.length > 500) mode.logs.splice(0, mode.logs.length - 500);
    }
    this.persistLogToFirebase(userId, log).catch((err) =>
      this.logger.error(`[${userId}] Log persist failed: ${err.message}`),
    );
  }

  private updateLog(userId: string, orderId: string, updates: Partial<MomentumLog>, step = 0) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;
    const idx = mode.logs.findIndex((l) => l.orderId === orderId && l.martingaleStep === step);
    if (idx !== -1) {
      mode.logs[idx] = { ...mode.logs[idx], ...updates };
      this.persistLogToFirebase(userId, mode.logs[idx]).catch(() => {});
    }
  }

  private async persistLogToFirebase(userId: string, log: MomentumLog) {
    await this.firebaseService.db
      .collection('momentum_logs').doc(userId).collection('entries').doc(log.id)
      .set({ ...log, executedAt: this.firebaseService.Timestamp.fromMillis(log.executedAt) });
  }

  // ==================== HELPERS ====================

  private buildTradePayload(session: any, config: MomentumConfig, amount: number, trend: string): any {
    const nowMs = Date.now();
    const createdAtSec = Math.floor(nowMs / 1000) + 1;
    const secondsInMinute = createdAtSec % 60;
    const remaining = 60 - secondsInMinute;
    const expireAt = remaining >= 45 ? createdAtSec + remaining : createdAtSec + remaining + 60;
    return {
      amount, createdAt: createdAtSec * 1000, dealType: config.isDemoAccount ? 'demo' : 'real',
      expireAt, iso: session.currencyIso || config.currency || 'IDR',
      optionType: 'turbo', ric: config.asset!.ric, trend,
    };
  }

  private buildStockityHeaders(session: any): Record<string, string> {
    return {
      'authorization-token': session.stockityToken, 'device-id': session.deviceId,
      'device-type': session.deviceType || 'web', 'user-timezone': session.userTimezone || 'Asia/Jakarta',
      'User-Agent': session.userAgent, 'Accept': 'application/json, text/plain, */*',
      'Origin': 'https://stockity.id', 'Referer': 'https://stockity.id/',
    };
  }

  private async updateStatus(userId: string, botState: string) {
    await this.firebaseService.db.collection('momentum_status').doc(userId).set(
      { botState, updatedAt: this.firebaseService.FieldValue.serverTimestamp() },
      { merge: true },
    );
  }

  private sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
}