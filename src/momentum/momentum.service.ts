import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';
import { AuthService } from '../auth/auth.service';
import { StockityWebSocketClient } from '../schedule/websocket-client';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import {
  MomentumType,
  MomentumSignal,
  MomentumOrder,
  MomentumMartingaleOrder,
  Candle,
  CandleApiResponse,
  BollingerBands,
  SignalState,
  MomentumStates,
  SIGNAL_COOLDOWN_MS,
  PRICE_MOVE_THRESHOLD,
  MAX_SIGNALS_PER_HOUR,
  SIGNAL_HISTORY_CLEANUP_MS,
  MAX_CANDLES_STORAGE,
  MIN_CANDLES_FOR_BB_SAR,
  CANDLES_5SEC_PER_MINUTE,
  FETCH_5SEC_OFFSET,
} from './types';

const BASE_URL = 'https://api.stockity.id';

// Terminal statuses — sama seperti FastradeBaseExecutor & IndicatorService
const TERMINAL_STATUSES = new Set(['won', 'win', 'lost', 'lose', 'loss', 'stand', 'draw', 'tie']);

// Exported so the controller can reference it without TS4053
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

// FIX: Log structure matching frontend MomentumLog expectations
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

interface ActiveModeState {
  isRunning: boolean; // FIX: was isActive — matches frontend MomentumStatus.isRunning
  wsClient: StockityWebSocketClient;
  candleStorage: Candle[];
  momentumOrders: MomentumOrder[];
  activeMartingaleOrders: Map<string, MomentumMartingaleOrder>;
  activeMomentumOrders: Map<string, { momentumType: MomentumType; orderId: string; trend: string; executedTime: number; isSettled: boolean }>;
  momentumStates: MomentumStates;
  totalExecutions: number;
  totalWins: number;
  totalLosses: number;
  sessionPnL: number; // FIX: track running P&L
  candleFetchInterval?: NodeJS.Timeout;
  processedOrderIds: Set<string>;
  logs: MomentumLog[]; // FIX: in-memory log storage (like fastrade)
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
    for (const [userId] of this.activeModes) {
      this.stopMomentumMode(userId);
    }
  }

  // ==================== CONFIG ====================

  async getConfig(userId: string): Promise<MomentumConfig> {
    if (this.configs.has(userId)) return this.configs.get(userId)!;

    const doc = await this.firebaseService.db.collection('momentum_configs').doc(userId).get();
    if (doc.exists) {
      const d = doc.data() as any;
      const cfg: MomentumConfig = {
        asset: d.asset || null,
        enabledMomentums: d.enabledMomentums || {
          candleSabit: true,
          dojiTerjepit: true,
          dojiPembatalan: true,
          bbSarBreak: true,
        },
        martingale: d.martingale || {
          isEnabled: true,
          maxSteps: 2,
          baseAmount: 1400000,
          multiplierValue: 2.5,
          multiplierType: 'FIXED',
        },
        isDemoAccount: d.isDemoAccount ?? true,
        currency: d.currency || 'IDR',
      };
      this.configs.set(userId, cfg);
      return cfg;
    }

    const def: MomentumConfig = {
      asset: null,
      enabledMomentums: {
        candleSabit: true,
        dojiTerjepit: true,
        dojiPembatalan: true,
        bbSarBreak: true,
      },
      martingale: {
        isEnabled: true,
        maxSteps: 2,
        baseAmount: 1400000,
        multiplierValue: 2.5,
        multiplierType: 'FIXED',
      },
      isDemoAccount: true,
      currency: 'IDR',
    };
    this.configs.set(userId, def);
    return def;
  }

  async updateConfig(userId: string, dto: Partial<MomentumConfig>): Promise<MomentumConfig> {
    const current = await this.getConfig(userId);
    const updated = { ...current, ...dto };
    this.configs.set(userId, updated);

    const plainCfg = JSON.parse(JSON.stringify(updated));
    await this.firebaseService.db.collection('momentum_configs').doc(userId).set(
      { ...plainCfg, updatedAt: this.firebaseService.FieldValue.serverTimestamp() },
      { merge: true },
    );

    return updated;
  }

  // ==================== MOMENTUM MODE CONTROL ====================

  async startMomentumMode(userId: string): Promise<{ message: string; status: string }> {
    const existing = this.activeModes.get(userId);
    // FIX: check isRunning (was isActive)
    if (existing?.isRunning) {
      return { message: 'Momentum mode sudah berjalan', status: 'RUNNING' };
    }

    const session = await this.authService.getSession(userId);
    if (!session) throw new Error('Session tidak ditemukan');

    const config = await this.getConfig(userId);
    if (!config.asset?.ric) {
      throw new Error('Asset belum dikonfigurasi');
    }

    const ws = new StockityWebSocketClient(
      userId,
      session.stockityToken,
      session.deviceId,
      session.deviceType || 'web',
      session.userAgent,
    );

    // FIX: register WS deal result callback for reliable result tracking
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

    const initialStates: MomentumStates = {
      candleSabit: this.createSignalState(),
      dojiTerjepit: this.createSignalState(),
      dojiPembatalan: this.createSignalState(),
      bbSarBreak: this.createSignalState(),
    };

    this.activeModes.set(userId, {
      isRunning: true, // FIX: was isActive
      wsClient: ws,
      candleStorage: [],
      momentumOrders: [],
      activeMartingaleOrders: new Map(),
      activeMomentumOrders: new Map(),
      momentumStates: initialStates,
      totalExecutions: 0,
      totalWins: 0,
      totalLosses: 0,
      sessionPnL: 0, // FIX: init P&L
      processedOrderIds: new Set(),
      logs: [], // FIX: init in-memory logs
    });

    await this.updateStatus(userId, 'RUNNING');
    this.logger.log(`[${userId}] Momentum mode started`);

    this.startCandleStorageLoop(userId, config, session);

    return { message: 'Momentum mode dimulai', status: 'RUNNING' };
  }

  async stopMomentumMode(userId: string): Promise<{ message: string }> {
    const mode = this.activeModes.get(userId);
    // FIX: check isRunning
    if (!mode?.isRunning) {
      return { message: 'Momentum mode tidak berjalan' };
    }

    mode.isRunning = false; // FIX: was isActive
    if (mode.candleFetchInterval) {
      clearInterval(mode.candleFetchInterval);
    }
    mode.wsClient.disconnect();
    this.activeModes.delete(userId);

    await this.updateStatus(userId, 'STOPPED');
    this.logger.log(`[${userId}] Momentum mode stopped`);

    return { message: 'Momentum mode dihentikan' };
  }

  // FIX: return isRunning (was isActive) — matches MomentumStatus frontend interface
  async getStatus(userId: string): Promise<object> {
    const mode = this.activeModes.get(userId);
    const config = await this.getConfig(userId);

    if (mode) {
      return {
        isRunning: mode.isRunning,      // FIX: was isActive
        botState: mode.isRunning ? 'RUNNING' : 'STOPPED',
        totalExecutions: mode.totalExecutions,
        totalWins: mode.totalWins,
        totalLosses: mode.totalLosses,
        totalTrades: mode.totalExecutions,
        sessionPnL: mode.sessionPnL,    // FIX: expose P&L
        wsConnected: mode.wsClient.isConnected(),
        candleStorageCount: mode.candleStorage.length,
        activeMartingaleCount: mode.activeMartingaleOrders.size,
        lastStatus: `Candles: ${mode.candleStorage.length} | Executions: ${mode.totalExecutions}`,
        config,
      };
    }

    const statusDoc = await this.firebaseService.db.collection('momentum_status').doc(userId).get();
    return {
      isRunning: false,   // FIX: was isActive
      botState: statusDoc.exists ? (statusDoc.data()?.botState ?? 'STOPPED') : 'STOPPED',
      totalExecutions: 0,
      totalWins: 0,
      totalLosses: 0,
      totalTrades: 0,
      sessionPnL: 0,
      config,
    };
  }

  // FIX: getLogs method — mirrors FastradeService.getLogs() pattern
  async getLogs(userId: string, limit = 100): Promise<MomentumLog[]> {
    // Try in-memory first (bot is running)
    const mode = this.activeModes.get(userId);
    if (mode && mode.logs.length > 0) {
      return mode.logs.slice(-limit);
    }

    // Fallback: Firebase (bot stopped, like fastrade pattern)
    const snap = await this.firebaseService.db
      .collection('momentum_logs')
      .doc(userId)
      .collection('entries')
      .orderBy('executedAt', 'desc')
      .limit(limit)
      .get();

    return snap.docs.map((d) => {
      const data = d.data() as any;
      return {
        ...data,
        // FIX: convert Firestore Timestamp → millis (same fix as fastrade getLogs)
        executedAt: data.executedAt?.toMillis?.() ?? data.executedAt ?? 0,
      } as MomentumLog;
    });
  }

  // ==================== CANDLE STORAGE & ANALYSIS ====================

  private startCandleStorageLoop(userId: string, config: MomentumConfig, session: any) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    const runCycle = async () => {
      // FIX: check isRunning
      if (!mode.isRunning) return;

      try {
        const serverNow = Date.now();
        const nextMinuteStart = this.calculateNextMinuteStart(serverNow);
        const waitTime = nextMinuteStart - serverNow;

        if (waitTime > 0) {
          await this.sleep(waitTime);
        }

        if (!mode.isRunning) return;

        await this.sleep(FETCH_5SEC_OFFSET);

        const newCandle = await this.fetchAndAggregateOneMinuteCandle(config.asset!.ric, session);

        if (newCandle) {
          this.addCandleToStorage(userId, newCandle);

          if (mode.candleStorage.length >= 2) {
            await this.analyzeAllMomentums(userId, config, session);
          }
        }
      } catch (err) {
        this.logger.error(`[${userId}] Error in candle storage loop: ${err}`);
      }

      // FIX: check isRunning
      if (mode.isRunning) {
        setTimeout(() => runCycle(), 1000);
      }
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
        {
          headers: this.buildStockityHeaders(session),
          timeout: 5000,
        },
      );

      if (response.data?.data) {
        const candles5Sec = response.data.data
          .map((d) => this.parseCandleData(d))
          .filter((c): c is Candle => c !== null);

        const last12Candles = candles5Sec.slice(-CANDLES_5SEC_PER_MINUTE);
        return this.aggregateCandlesToOneMinute(last12Candles);
      }
      return null;
    } catch (err) {
      this.logger.error(`Error fetching candles: ${err}`);
      return null;
    }
  }

  private parseCandleData(data: any): Candle | null {
    try {
      const candle: Candle = {
        open: parseFloat(data.open),
        close: parseFloat(data.close),
        high: parseFloat(data.high),
        low: parseFloat(data.low),
        createdAt: data.created_at,
      };

      if (candle.open > 0 && candle.close > 0) {
        return candle;
      }
      return null;
    } catch {
      return null;
    }
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
    if (mode.candleStorage.length > MAX_CANDLES_STORAGE) {
      mode.candleStorage.shift();
    }

    this.logger.debug(`[${userId}] Candle added. Storage: ${mode.candleStorage.length}/${MAX_CANDLES_STORAGE}`);
  }

  // ==================== MOMENTUM ANALYSIS ====================

  private async analyzeAllMomentums(userId: string, config: MomentumConfig, session: any) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    const signals: MomentumSignal[] = [];

    if (config.enabledMomentums.candleSabit) {
      const signal = this.analyzeCandleSabit(mode.candleStorage, mode.momentumStates.candleSabit);
      if (signal) {
        signals.push(signal);
        this.logger.log(`[${userId}] Signal detected: CANDLE_SABIT (${signal.trend})`);
      }
    }

    if (config.enabledMomentums.dojiTerjepit) {
      const signal = this.analyzeDojiTerjepit(mode.candleStorage, mode.momentumStates.dojiTerjepit);
      if (signal) {
        signals.push(signal);
        this.logger.log(`[${userId}] Signal detected: DOJI_TERJEPIT (${signal.trend})`);
      }
    }

    if (config.enabledMomentums.dojiPembatalan) {
      const signal = this.analyzeDojiPembatalan(mode.candleStorage, mode.momentumStates.dojiPembatalan);
      if (signal) {
        signals.push(signal);
        this.logger.log(`[${userId}] Signal detected: DOJI_PEMBATALAN (${signal.trend})`);
      }
    }

    if (config.enabledMomentums.bbSarBreak && mode.candleStorage.length >= MIN_CANDLES_FOR_BB_SAR) {
      const signal = this.analyzeBBSARBreak(mode.candleStorage, mode.momentumStates.bbSarBreak);
      if (signal) {
        signals.push(signal);
        this.logger.log(`[${userId}] Signal detected: BB_SAR_BREAK (${signal.trend})`);
      }
    }

    for (const signal of signals) {
      await this.executeMomentumOrder(userId, config, session, signal);
    }
  }

  private analyzeCandleSabit(candles: Candle[], state: SignalState): MomentumSignal | null {
    if (candles.length < 4) return null;

    const last4 = candles.slice(-4);
    const candle4 = last4[3];

    const trend2 = this.getCandleTrend(last4[1]);
    const trend3 = this.getCandleTrend(last4[2]);
    const trend4 = this.getCandleTrend(candle4);

    if (trend2 !== trend3 || trend3 !== trend4) return null;

    const body2 = Math.abs(last4[1].close - last4[1].open);
    const body3 = Math.abs(last4[2].close - last4[2].open);
    const body4 = Math.abs(candle4.close - candle4.open);

    if (body2 < body3 && body3 < body4) {
      const signalTrend = trend2 === 'buy' ? 'call' : 'put';
      const currentPrice = candle4.close;
      const currentTime = Date.now();

      if (!this.shouldAllowSignal(state, signalTrend, currentPrice, currentTime)) {
        return null;
      }

      this.recordSignal(state, signalTrend, currentPrice, currentTime);

      return {
        momentumType: MomentumType.CANDLE_SABIT,
        trend: signalTrend,
        confidence: this.calculateConfidence(body2, body3, body4),
        details: 'Candle Sabit: 4 candles increasing body size',
      };
    }

    return null;
  }

  private analyzeDojiTerjepit(candles: Candle[], state: SignalState): MomentumSignal | null {
    if (candles.length < 4) return null;

    const last4 = candles.slice(-4);
    const candle4 = last4[3];

    const trend1 = this.getCandleTrend(last4[0]);
    const trend2 = this.getCandleTrend(last4[1]);
    const trend3 = this.getCandleTrend(last4[2]);

    if (trend1 !== trend2 || trend2 !== trend3) return null;

    const body1Pct = this.calculateBodyPercentage(last4[0]);
    const body2Pct = this.calculateBodyPercentage(last4[1]);
    const body3Pct = this.calculateBodyPercentage(last4[2]);
    const body4Pct = this.calculateBodyPercentage(candle4);

    if (body1Pct > 60 && body2Pct > 60 && body3Pct > 60 && body4Pct < 10) {
      const trend4 = this.getCandleTrend(candle4);

      let signalTrend: string;
      if (trend1 === 'buy' && trend4 === 'sell') {
        signalTrend = 'put';
      } else if (trend1 === 'sell' && trend4 === 'buy') {
        signalTrend = 'call';
      } else {
        return null;
      }

      const currentPrice = candle4.close;
      const currentTime = Date.now();

      if (!this.shouldAllowSignal(state, signalTrend, currentPrice, currentTime)) {
        return null;
      }

      this.recordSignal(state, signalTrend, currentPrice, currentTime);

      return {
        momentumType: MomentumType.DOJI_TERJEPIT,
        trend: signalTrend,
        confidence: 0.8,
        details: 'Doji Terjepit: 3 long candles + 1 doji reversal hint',
      };
    }

    return null;
  }

  private analyzeDojiPembatalan(candles: Candle[], state: SignalState): MomentumSignal | null {
    if (candles.length < 2) return null;

    const last2 = candles.slice(-2);
    const previous = last2[0];
    const current = last2[1];

    const currentBodyPct = this.calculateBodyPercentage(current);

    if (currentBodyPct < 10) {
      const prevTrend = this.getCandleTrend(previous);
      const dojiTrend = this.getCandleTrend(current);

      let signalTrend: string;
      if (prevTrend === 'sell' && dojiTrend === 'buy') {
        signalTrend = 'call';
      } else if (prevTrend === 'buy' && dojiTrend === 'sell') {
        signalTrend = 'put';
      } else {
        return null;
      }

      const currentPrice = current.close;
      const currentTime = Date.now();

      if (!this.shouldAllowSignal(state, signalTrend, currentPrice, currentTime)) {
        return null;
      }

      this.recordSignal(state, signalTrend, currentPrice, currentTime);

      return {
        momentumType: MomentumType.DOJI_PEMBATALAN,
        trend: signalTrend,
        confidence: 0.75,
        details: 'Doji Pembatalan: Reversal detected',
      };
    }

    return null;
  }

  private analyzeBBSARBreak(candles: Candle[], state: SignalState): MomentumSignal | null {
    if (candles.length < MIN_CANDLES_FOR_BB_SAR) return null;

    const lastCandle = candles[candles.length - 1];
    const closePrice = lastCandle.close;

    const bb = this.calculateBollingerBands(candles, 20, 2);
    const sar = this.calculateParabolicSAR(candles);

    if (!bb) return null;

    let currentSignal: string;
    if (closePrice > bb.upper && closePrice > sar) {
      currentSignal = 'call';
    } else if (closePrice < bb.lower && closePrice < sar) {
      currentSignal = 'put';
    } else {
      return null;
    }

    const currentTime = Date.now();

    if (!this.shouldAllowSignal(state, currentSignal, closePrice, currentTime)) {
      return null;
    }

    this.recordSignal(state, currentSignal, closePrice, currentTime);

    return {
      momentumType: MomentumType.BB_SAR_BREAK,
      trend: currentSignal,
      confidence: 0.85,
      details: 'BB/SAR Break: Strong trend with filters passed',
    };
  }

  // ==================== SIGNAL STATE MANAGEMENT ====================

  private createSignalState(): SignalState {
    return {
      lastSignal: null,
      lastSignalTime: 0,
      lastPrice: null,
      consecutiveSignals: 0,
      signalHistory: [],
      isOrderActive: false,
    };
  }

  private shouldAllowSignal(state: SignalState, currentSignal: string, currentPrice: number, currentTime: number): boolean {
    if (currentSignal === state.lastSignal) {
      if (currentTime - state.lastSignalTime < SIGNAL_COOLDOWN_MS) {
        return false;
      }

      if (state.lastPrice !== null) {
        const priceChange = Math.abs((currentPrice - state.lastPrice) / state.lastPrice);
        if (priceChange < PRICE_MOVE_THRESHOLD) {
          return false;
        }
      }
    }

    this.cleanupOldSignals(state, currentTime);
    if (state.signalHistory.length >= MAX_SIGNALS_PER_HOUR) {
      return false;
    }

    return true;
  }

  private recordSignal(state: SignalState, signal: string, price: number, time: number) {
    state.lastSignal = signal;
    state.lastSignalTime = time;
    state.lastPrice = price;
    state.consecutiveSignals++;
    state.signalHistory.push(time);
  }

  private cleanupOldSignals(state: SignalState, currentTime: number) {
    state.signalHistory = state.signalHistory.filter((t) => currentTime - t <= SIGNAL_HISTORY_CLEANUP_MS);
  }

  // ==================== TECHNICAL CALCULATIONS ====================

  private getCandleTrend(candle: Candle): string {
    return candle.close > candle.open ? 'buy' : 'sell';
  }

  private calculateBodyPercentage(candle: Candle): number {
    const range = Math.abs(candle.high - candle.low);
    if (range === 0) return 0;
    const body = Math.abs(candle.close - candle.open);
    return (body / range) * 100;
  }

  private calculateConfidence(body2: number, body3: number, body4: number): number {
    if (body2 === 0 || body3 === 0) return 0.5;
    const ratio1 = body3 / body2;
    const ratio2 = body4 / body3;
    return Math.min(0.9, 0.5 + (ratio1 + ratio2) * 0.1);
  }

  private calculateBollingerBands(candles: Candle[], period: number, stdDevMultiplier: number): BollingerBands | null {
    if (candles.length < period) return null;

    const recentCandles = candles.slice(-period);
    const closes = recentCandles.map((c) => c.close);

    const sma = closes.reduce((a, b) => a + b, 0) / period;
    const variance = closes.reduce((acc, val) => acc + Math.pow(val - sma, 2), 0) / period;
    const stdDev = Math.sqrt(variance);

    return {
      upper: sma + stdDev * stdDevMultiplier,
      middle: sma,
      lower: sma - stdDev * stdDevMultiplier,
    };
  }

  private calculateParabolicSAR(candles: Candle[]): number {
    if (candles.length < 2) return candles[candles.length - 1].close;

    const last = candles[candles.length - 1];
    const previous = candles[candles.length - 2];

    const isUptrend = last.close > previous.close;

    return isUptrend
      ? Math.min(last.low, previous.low)
      : Math.max(last.high, previous.high);
  }

  // ==================== ORDER EXECUTION ====================

  private async executeMomentumOrder(
    userId: string,
    config: MomentumConfig,
    session: any,
    signal: MomentumSignal,
  ) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    const existingActiveOrder = mode.activeMomentumOrders.get(signal.momentumType);
    if (existingActiveOrder && !existingActiveOrder.isSettled) {
      this.logger.warn(`[${userId}] Duplicate prevented: ${signal.momentumType} already has active order`);
      return;
    }

    const orderId = uuidv4();
    const currentTime = Date.now();
    const amount = config.martingale.baseAmount;

    const order: MomentumOrder = {
      id: orderId,
      assetRic: config.asset!.ric,
      assetName: config.asset!.name,
      trend: signal.trend,
      amount,
      executionTime: currentTime,
      momentumType: signal.momentumType,
      confidence: signal.confidence,
      sourceCandle: mode.candleStorage[mode.candleStorage.length - 1],
      isExecuted: true,
      isSkipped: false,
      martingaleState: {
        isActive: false,
        currentStep: 0,
        isCompleted: false,
        totalLoss: 0,
        totalRecovered: 0,
      },
    };

    mode.momentumOrders.push(order);
    mode.activeMomentumOrders.set(signal.momentumType, {
      momentumType: signal.momentumType,
      orderId,
      trend: signal.trend,
      executedTime: currentTime,
      isSettled: false,
    });
    mode.totalExecutions++;

    this.logger.log(`[${userId}] Executing ${signal.momentumType} order: ${signal.trend} amount=${amount}`);

    // FIX: save execution log entry immediately (pending result)
    const execLog: MomentumLog = {
      id: orderId,
      orderId,
      momentumType: signal.momentumType,
      trend: signal.trend,
      amount,
      martingaleStep: 0,
      executedAt: currentTime,
      note: `${signal.momentumType} signal | ${signal.details}`,
    };
    this.appendLog(userId, execLog);

    // Execute via WebSocket
    const tradeResult = await mode.wsClient.placeTrade(
      this.buildTradePayload(session, config, amount, signal.trend),
    );

    if (tradeResult?.dealId) {
      // FIX: update log with dealId
      this.updateLog(userId, orderId, { dealId: tradeResult.dealId });
    }

    this.monitorTradeResult(userId, config, session, orderId, signal.momentumType);
  }

  // FIX: handle WS deal result (called by wsClient.setOnDealResult)
  private async handleWsDealResult(userId: string, payload: any) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    // FIX 1: Hanya proses terminal status — cegah false-match pada event bo:opened (status="open")
    const statusStr = (payload.result ?? payload.status ?? '').toLowerCase();
    if (!TERMINAL_STATUSES.has(statusStr)) {
      this.logger.debug(`[${userId}] Skip non-terminal WS event status="${statusStr}"`);
      return;
    }

    // FIX 2: Dual-ID matching — log menyimpan numeric ID dari bo:opened,
    // tapi bo:closed mengirim UUID sebagai primary id.
    // Coba cocokkan keduanya: uuid, numericId, maupun raw payload.id.
    const matchedLog = mode.logs.find((l) =>
      !l.result && (
        (payload.uuid  && l.dealId === payload.uuid)     ||
        (payload.numericId && l.dealId === payload.numericId) ||
        (payload.id    && l.dealId === String(payload.id))
      ),
    );

    if (!matchedLog) return;

    const isWin  = statusStr === 'won'  || statusStr === 'win';
    const isDraw = statusStr === 'stand' || statusStr === 'draw' || statusStr === 'tie';
    const profit = isWin
      ? (payload.win ?? payload.payment ?? Math.floor(matchedLog.amount * 0.85))
      : isDraw ? 0 : -matchedLog.amount;

    mode.sessionPnL += profit;
    if (isWin)        mode.totalWins++;
    else if (!isDraw) mode.totalLosses++;

    this.updateLog(userId, matchedLog.orderId, {
      result: isWin ? 'WIN' : isDraw ? 'DRAW' : 'LOSE',
      profit,
      sessionPnL: mode.sessionPnL,
    }, matchedLog.martingaleStep);

    // Tandai active order sebagai settled agar tidak di-handle dua kali
    for (const [type, activeOrder] of mode.activeMomentumOrders.entries()) {
      if (activeOrder.orderId === matchedLog.orderId && !activeOrder.isSettled) {
        activeOrder.isSettled = true;
        if (isWin || isDraw) mode.activeMomentumOrders.delete(type);
        break;
      }
    }

    this.logger.log(
      `[${userId}] WS deal result: dealId=${payload.numericId ?? payload.uuid ?? payload.id} ` +
      `result=${isWin ? 'WIN' : isDraw ? 'DRAW' : 'LOSE'} profit=${profit}`,
    );
  }

  private async monitorTradeResult(
    userId: string,
    config: MomentumConfig,
    session: any,
    orderId: string,
    momentumType: MomentumType,
  ) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    const maxWaitTime = 90000;
    const startTime = Date.now();

    const checkInterval = setInterval(async () => {
      // FIX: check isRunning
      if (!mode.isRunning || Date.now() - startTime > maxWaitTime) {
        clearInterval(checkInterval);
        return;
      }

      try {
        const result = await this.fetchTradeResult(session, config);
        if (result) {
          clearInterval(checkInterval);
          await this.handleTradeResult(userId, config, session, orderId, momentumType, result);
        }
      } catch (err) {
        this.logger.error(`[${userId}] Error checking trade result: ${err}`);
      }
    }, 2000);
  }

  private async fetchTradeResult(session: any, config: MomentumConfig): Promise<any | null> {
    try {
      // FIX: Gunakan endpoint yang benar — sama dengan IndicatorService.fetchTradeResultById()
      // Endpoint lama /profile/trading-history mengembalikan 404.
      const response = await axios.get(
        `${BASE_URL}/bo-deals-history/v3/deals/trade?type=${config.isDemoAccount ? 'demo' : 'real'}&locale=id`,
        {
          headers: this.buildStockityHeaders(session),
          timeout: 5000,
        },
      );

      if (!response.data?.data) return null;

      const deals: any[] = response.data.data.standard_trade_deals || response.data.data.deals || [];

      // FIX: Filter terminal status saja — cegah deal OPEN dianggap LOSE
      const terminalDeals = deals.filter((t: any) =>
        TERMINAL_STATUSES.has((t.status || '').toLowerCase()),
      );

      // Kembalikan deal terminal terbaru dalam 120s
      return terminalDeals.find((t: any) => {
        const tradeTime = new Date(t.created_at).getTime();
        return tradeTime > Date.now() - 120_000;
      }) || null;
    } catch (err) {
      this.logger.error(`Error fetching trade result: ${err}`);
      return null;
    }
  }

  private async handleTradeResult(
    userId: string,
    config: MomentumConfig,
    session: any,
    orderId: string,
    momentumType: MomentumType,
    result: any,
  ) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    if (mode.processedOrderIds.has(orderId)) return;
    mode.processedOrderIds.add(orderId);

    const isWin = result.status?.toLowerCase() === 'won';
    const profit = isWin ? (result.win || result.payment || 0) : -config.martingale.baseAmount;
    const order = mode.momentumOrders.find((o) => o.id === orderId);

    if (order) {
      order.martingaleState.isCompleted = true;
      order.martingaleState.finalResult = isWin ? 'WIN' : 'LOSE';

      if (isWin) {
        order.martingaleState.totalRecovered = result.win || result.payment || 0;
        mode.totalWins++;
      } else {
        order.martingaleState.totalLoss = config.martingale.baseAmount;
        mode.totalLosses++;
      }
    }

    // FIX: only update P&L & log if WS callback hasn't already done it
    const existingLog = mode.logs.find((l) => l.orderId === orderId && l.result);
    if (!existingLog) {
      mode.sessionPnL += profit;
      this.updateLog(userId, orderId, {
        result: isWin ? 'WIN' : 'LOSE',
        profit,
        sessionPnL: mode.sessionPnL,
      });
    }

    const activeOrder = mode.activeMomentumOrders.get(momentumType);
    if (activeOrder) {
      activeOrder.isSettled = true;
    }

    this.logger.log(`[${userId}] ${momentumType} result: ${isWin ? 'WIN' : 'LOSE'} profit=${profit}`);

    if (!isWin && config.martingale.isEnabled) {
      await this.startMartingale(userId, config, session, orderId, momentumType);
    } else if (isWin) {
      mode.activeMomentumOrders.delete(momentumType);
    }
  }

  private async startMartingale(
    userId: string,
    config: MomentumConfig,
    session: any,
    parentOrderId: string,
    momentumType: MomentumType,
    step: number = 1,
  ) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    if (step > config.martingale.maxSteps) {
      this.logger.log(`[${userId}] Max martingale steps reached for ${momentumType}`);
      mode.activeMomentumOrders.delete(momentumType);
      return;
    }

    const martingaleAmount = this.calculateMartingaleAmount(config, step);
    const parentOrder = mode.momentumOrders.find((o) => o.id === parentOrderId);

    if (!parentOrder) return;

    mode.activeMartingaleOrders.set(parentOrderId, {
      originalOrderId: parentOrderId,
      momentumType,
      currentStep: step,
      maxSteps: config.martingale.maxSteps,
      totalLoss: parentOrder.amount,
      nextAmount: martingaleAmount,
      trend: parentOrder.trend,
      isActive: true,
    });

    this.logger.log(`[${userId}] ${momentumType} martingale step ${step}: amount=${martingaleAmount}`);

    // FIX: save martingale log entry
    const martingaleLogId = uuidv4();
    const martingaleLog: MomentumLog = {
      id: martingaleLogId,
      orderId: parentOrderId,
      momentumType,
      trend: parentOrder.trend,
      amount: martingaleAmount,
      martingaleStep: step,
      executedAt: Date.now(),
      note: `Martingale step ${step}/${config.martingale.maxSteps}`,
    };
    this.appendLog(userId, martingaleLog);

    const tradeResult = await mode.wsClient.placeTrade(
      this.buildTradePayload(session, config, martingaleAmount, parentOrder.trend),
    );

    if (tradeResult?.dealId) {
      this.updateLog(userId, parentOrderId, { dealId: tradeResult.dealId }, step);
    }

    this.monitorMartingaleResult(userId, config, session, parentOrderId, momentumType, step);
  }

  private calculateMartingaleAmount(config: MomentumConfig, step: number): number {
    const multiplier = config.martingale.multiplierType === 'FIXED'
      ? config.martingale.multiplierValue
      : 1 + config.martingale.multiplierValue / 100;

    return Math.floor(config.martingale.baseAmount * Math.pow(multiplier, step - 1));
  }

  private async monitorMartingaleResult(
    userId: string,
    config: MomentumConfig,
    session: any,
    parentOrderId: string,
    momentumType: MomentumType,
    step: number,
  ) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    const maxWaitTime = 90000;
    const startTime = Date.now();

    const checkInterval = setInterval(async () => {
      // FIX: check isRunning
      if (!mode.isRunning || Date.now() - startTime > maxWaitTime) {
        clearInterval(checkInterval);
        return;
      }

      try {
        const result = await this.fetchTradeResult(session, config);
        if (result) {
          clearInterval(checkInterval);

          const isWin = result.status?.toLowerCase() === 'won';
          const martingaleAmount = this.calculateMartingaleAmount(config, step);
          const profit = isWin ? (result.win || result.payment || 0) : -martingaleAmount;

          mode.sessionPnL += profit;

          // FIX: update log for this martingale step
          this.updateLog(userId, parentOrderId, {
            result: isWin ? 'WIN' : 'LOSE',
            profit,
            sessionPnL: mode.sessionPnL,
          }, step);

          if (isWin) {
            mode.totalWins++;
            mode.activeMartingaleOrders.delete(parentOrderId);
            mode.activeMomentumOrders.delete(momentumType);
            this.logger.log(`[${userId}] ${momentumType} martingale WIN at step ${step}`);
          } else {
            mode.totalLosses++;
            await this.startMartingale(userId, config, session, parentOrderId, momentumType, step + 1);
          }
        }
      } catch (err) {
        this.logger.error(`[${userId}] Error checking martingale result: ${err}`);
      }
    }, 2000);
  }

  // ==================== LOG HELPERS (FIX: new section) ====================

  /**
   * Append a new log entry to in-memory + Firebase.
   * Mirrors FastradeService.callbacks.onLog pattern.
   */
  private appendLog(userId: string, log: MomentumLog) {
    const mode = this.activeModes.get(userId);
    if (mode) {
      // Upsert by id to prevent duplicates (same fix as fastrade)
      const existingIdx = mode.logs.findIndex((l) => l.id === log.id);
      if (existingIdx !== -1) {
        mode.logs[existingIdx] = log;
      } else {
        mode.logs.push(log);
      }
      if (mode.logs.length > 500) mode.logs.splice(0, mode.logs.length - 500);
    }

    // Persist to Firebase
    this.persistLogToFirebase(userId, log).catch((err) =>
      this.logger.error(`[${userId}] Failed to persist log: ${err.message}`),
    );
  }

  /**
   * Update an existing log entry in-memory + Firebase.
   * Used to add result/profit after trade settles.
   */
  private updateLog(userId: string, orderId: string, updates: Partial<MomentumLog>, step = 0) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    // For martingale steps, find by orderId + martingaleStep
    const idx = mode.logs.findIndex(
      (l) => l.orderId === orderId && l.martingaleStep === step,
    );
    if (idx !== -1) {
      mode.logs[idx] = { ...mode.logs[idx], ...updates };
      this.persistLogToFirebase(userId, mode.logs[idx]).catch(() => {});
    }
  }

  private async persistLogToFirebase(userId: string, log: MomentumLog) {
    await this.firebaseService.db
      .collection('momentum_logs')
      .doc(userId)
      .collection('entries')
      .doc(log.id)
      .set({
        ...log,
        executedAt: this.firebaseService.Timestamp.fromMillis(log.executedAt),
      });
  }

  // ==================== HELPERS ====================

  private buildTradePayload(session: any, config: MomentumConfig, amount: number, trend: string): any {
    const nowMs = Date.now();
    const createdAtSec = Math.floor(nowMs / 1000) + 1;
    const secondsInMinute = createdAtSec % 60;
    const remaining = 60 - secondsInMinute;
    const expireAt = remaining >= 45
      ? createdAtSec + remaining
      : createdAtSec + remaining + 60;

    return {
      amount,
      createdAt: createdAtSec * 1000,
      dealType: config.isDemoAccount ? 'demo' : 'real',
      expireAt,
      iso: session.currencyIso || config.currency || 'IDR',
      optionType: 'turbo',
      ric: config.asset!.ric,
      trend,
    };
  }

  private buildStockityHeaders(session: any): Record<string, string> {
    return {
      'authorization-token': session.stockityToken,
      'device-id': session.deviceId,
      'device-type': session.deviceType || 'web',
      'user-timezone': session.userTimezone || 'Asia/Jakarta',
      'User-Agent': session.userAgent,
      'Accept': 'application/json, text/plain, */*',
      'Origin': 'https://stockity.id',
      'Referer': 'https://stockity.id/',
    };
  }

  private async updateStatus(userId: string, botState: string) {
    await this.firebaseService.db.collection('momentum_status').doc(userId).set(
      { botState, updatedAt: this.firebaseService.FieldValue.serverTimestamp() },
      { merge: true },
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}