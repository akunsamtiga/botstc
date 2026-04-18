import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';
import { AuthService } from '../auth/auth.service';
import { StockityWebSocketClient, DealResultPayload } from '../schedule/websocket-client';
import { curlGet } from '../common/http-utils';
import { v4 as uuidv4 } from 'uuid';
import {
  IndicatorSettings,
  IndicatorAnalysisResult,
  PricePrediction,
  IndicatorOrder,
  IndicatorMartingaleOrder,
  Candle,
  CandleApiResponse,
  IndicatorType,
  DEFAULT_INDICATOR_SETTINGS,
} from './types';

const BASE_URL = 'https://api.stockity.id';
const HISTORICAL_CANDLES_COUNT = 180;
const PRICE_MONITOR_INTERVAL = 3000;
const MINUTE_BOUNDARY_OFFSET_MS = 100;
const CANDLE_INTERVAL_MS = 60000;
const RESULT_TIMEOUT_MS = 90_000;
const FALLBACK_MATCH_WINDOW_MS = 120_000;
const TERMINAL_STATUSES = new Set(['won', 'win', 'lost', 'lose', 'loss', 'stand', 'draw', 'tie']);

export interface IndicatorLog {
  id: string;
  orderId: string;
  trend: string;
  amount: number;
  martingaleStep: number;
  dealId?: string;
  result?: string;
  profit?: number;
  sessionPnL?: number;
  executedAt: number;
  note?: string;
  indicatorType?: string;
  cycleNumber?: number;
  isDemoAccount?: boolean;
}

export interface IndicatorAlwaysSignalLossState {
  hasOutstandingLoss: boolean;
  currentMartingaleStep: number;
  originalOrderId: string;
  totalLoss: number;
  currentTrend: string;
}

export interface IndicatorConfig {
  asset: { ric: string; name: string } | null;
  settings: IndicatorSettings;
  martingale: {
    isEnabled: boolean;
    maxSteps: number;
    baseAmount: number;
    multiplierValue: number;
    multiplierType: 'FIXED' | 'PERCENTAGE';
    isAlwaysSignal: boolean;
  };
  isDemoAccount: boolean;
  currency: string;
}

interface ActiveMode {
  isActive: boolean;
  wsClient: StockityWebSocketClient;
  historicalCandles: Candle[];
  analysisResult: IndicatorAnalysisResult | null;
  pricePredictions: PricePrediction[];
  indicatorOrders: IndicatorOrder[];
  currentMartingaleOrder: IndicatorMartingaleOrder | null;
  isTradeExecuted: boolean;
  activeDealId: string | null;
  activeOrderId: string | null;
  activeOrderTrend: string | null;
  activeOrderAmount: number;
  activeOrderExecutedAt: number;
  currentMartingaleStep: number;
  isHandlingResult: boolean;
  resultTimeoutTimer: NodeJS.Timeout | null;
  monitoringInterval?: NodeJS.Timeout;
  consecutiveWins: number;
  consecutiveLosses: number;
  totalExecutions: number;
  totalWins: number;
  totalLosses: number;
  autoRestartEnabled: boolean;
  consecutiveRestarts: number;
  maxConsecutiveRestarts: number;
  sessionPnL: number;
  cycleNumber: number;
  logs: IndicatorLog[];
  // Always Signal state
  alwaysSignalLossState: IndicatorAlwaysSignalLossState | null;
}

@Injectable()
export class IndicatorService implements OnModuleDestroy {
  private readonly logger = new Logger(IndicatorService.name);
  private configs = new Map<string, IndicatorConfig>();
  private activeModes = new Map<string, ActiveMode>();

  constructor(
    private readonly firebaseService: FirebaseService,
    private readonly authService: AuthService,
  ) {}

  onModuleDestroy() {
    for (const [userId] of this.activeModes) {
      this.stopIndicatorMode(userId);
    }
  }

  async getConfig(userId: string): Promise<IndicatorConfig> {
    if (this.configs.has(userId)) return this.configs.get(userId)!;

    const doc = await this.firebaseService.db.collection('indicator_configs').doc(userId).get();
    if (doc.exists) {
      const d = doc.data() as any;
      const cfg: IndicatorConfig = {
        asset: d.asset || null,
        settings: d.settings || DEFAULT_INDICATOR_SETTINGS,
        martingale: d.martingale || {
          isEnabled: true,
          maxSteps: 2,
          baseAmount: 1400000,
          multiplierValue: 2.5,
          multiplierType: 'FIXED',
          isAlwaysSignal: false,
        },
        isDemoAccount: d.isDemoAccount ?? true,
        currency: d.currency || 'IDR',
      };
      this.configs.set(userId, cfg);
      return cfg;
    }

    const def: IndicatorConfig = {
      asset: null,
      settings: { ...DEFAULT_INDICATOR_SETTINGS },
      martingale: {
        isEnabled: true,
        maxSteps: 2,
        baseAmount: 1400000,
        multiplierValue: 2.5,
        multiplierType: 'FIXED',
        isAlwaysSignal: false,
      },
      isDemoAccount: true,
      currency: 'IDR',
    };
    this.configs.set(userId, def);
    return def;
  }

  async updateConfig(userId: string, dto: Partial<IndicatorConfig>): Promise<IndicatorConfig> {
    const current = await this.getConfig(userId);
    const updated = { ...current, ...dto };
    this.configs.set(userId, updated);

    const plainCfg = JSON.parse(JSON.stringify(updated));
    await this.firebaseService.db.collection('indicator_configs').doc(userId).set(
      { ...plainCfg, updatedAt: this.firebaseService.FieldValue.serverTimestamp() },
      { merge: true },
    );

    return updated;
  }

  async startIndicatorMode(userId: string): Promise<{ message: string; status: string }> {
    const existing = this.activeModes.get(userId);
    if (existing?.isActive) {
      return { message: 'Indicator mode sudah berjalan', status: 'RUNNING' };
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

    try {
      await ws.connect();
    } catch (err: any) {
      ws.disconnect();
      throw new Error(`Gagal koneksi WebSocket: ${err.message}`);
    }

    const mode: ActiveMode = {
      isActive: true,
      wsClient: ws,
      historicalCandles: [],
      analysisResult: null,
      pricePredictions: [],
      indicatorOrders: [],
      currentMartingaleOrder: null,
      isTradeExecuted: false,
      activeDealId: null,
      activeOrderId: null,
      activeOrderTrend: null,
      activeOrderAmount: 0,
      activeOrderExecutedAt: 0,
      currentMartingaleStep: 0,
      isHandlingResult: false,
      resultTimeoutTimer: null,
      consecutiveWins: 0,
      consecutiveLosses: 0,
      totalExecutions: 0,
      totalWins: 0,
      totalLosses: 0,
      autoRestartEnabled: true,
      consecutiveRestarts: 0,
      maxConsecutiveRestarts: 50,
      sessionPnL: 0,
      cycleNumber: 0,
      logs: [],
      alwaysSignalLossState: null,
    };

    this.activeModes.set(userId, mode);

    ws.setOnDealResult((payload) => this.handleWsDealResult(userId, payload));

    await this.updateStatus(userId, 'RUNNING');
    this.logger.log(`[${userId}] Indicator mode started`);

    this.executeIndicatorCycle(userId, config, session);

    return { message: 'Indicator mode dimulai', status: 'RUNNING' };
  }

  async stopIndicatorMode(userId: string): Promise<{ message: string }> {
    const mode = this.activeModes.get(userId);
    if (!mode?.isActive) {
      return { message: 'Indicator mode tidak berjalan' };
    }

    mode.isActive = false;
    this.clearResultTimeout(mode);
    if (mode.monitoringInterval) {
      clearInterval(mode.monitoringInterval);
      mode.monitoringInterval = undefined;
    }
    mode.wsClient.disconnect();
    this.activeModes.delete(userId);

    await this.updateStatus(userId, 'STOPPED');
    this.logger.log(`[${userId}] Indicator mode stopped`);

    return { message: 'Indicator mode dihentikan' };
  }

  async getStatus(userId: string): Promise<object> {
    const mode = this.activeModes.get(userId);
    const config = await this.getConfig(userId);

    if (mode) {
      return {
        isActive: mode.isActive,
        isRunning: mode.isActive,
        botState: 'RUNNING',
        totalTrades: mode.totalExecutions,
        totalExecutions: mode.totalExecutions,
        totalWins: mode.totalWins,
        totalLosses: mode.totalLosses,
        consecutiveWins: mode.consecutiveWins,
        consecutiveLosses: mode.consecutiveLosses,
        currentIndicatorValue: mode.analysisResult?.finalIndicatorValue ?? null,
        lastTrend: mode.analysisResult?.trend ?? null,
        lastSignalTime: mode.indicatorOrders.length > 0
          ? mode.indicatorOrders[mode.indicatorOrders.length - 1].executionTime
          : null,
        indicatorType: mode.analysisResult?.indicatorType ?? null,
        wsConnected: mode.wsClient.isConnected(),
        indicatorOrders: mode.indicatorOrders,
        pricePredictions: mode.pricePredictions,
        analysisResult: mode.analysisResult,
        sessionPnL: mode.sessionPnL,
        cycleNumber: mode.cycleNumber,
        alwaysSignalStatus: this.getAlwaysSignalStatus(mode, config),
        config,
      };
    }

    const statusDoc = await this.firebaseService.db.collection('indicator_status').doc(userId).get();
    return {
      isActive: false,
      isRunning: false,
      botState: statusDoc.exists ? (statusDoc.data()?.botState ?? 'STOPPED') : 'STOPPED',
      totalTrades: 0,
      totalWins: 0,
      totalLosses: 0,
      consecutiveWins: 0,
      consecutiveLosses: 0,
      currentIndicatorValue: null,
      lastTrend: null,
      lastSignalTime: null,
      indicatorType: null,
      wsConnected: false,
      indicatorOrders: [],
      pricePredictions: [],
      analysisResult: null,
      config,
    };
  }

  private getAlwaysSignalStatus(mode: ActiveMode, config: IndicatorConfig): object {
    if (!config.martingale.isAlwaysSignal || !mode.alwaysSignalLossState) {
      return { isActive: false, status: 'No outstanding loss' };
    }

    const lossState = mode.alwaysSignalLossState;
    if (!lossState.hasOutstandingLoss) {
      return { isActive: false, status: 'No outstanding loss' };
    }

    return {
      isActive: true,
      currentStep: lossState.currentMartingaleStep,
      maxSteps: config.martingale.maxSteps,
      totalLoss: lossState.totalLoss,
      status: `Waiting for next signal (Step ${lossState.currentMartingaleStep}/${config.martingale.maxSteps})`,
    };
  }

  private async executeIndicatorCycle(userId: string, config: IndicatorConfig, session: any) {
    const mode = this.activeModes.get(userId);
    if (!mode || !mode.isActive) return;

    // Check Always Signal - jika ada loss yang belum tertutupi, eksekusi martingale
    if (config.martingale.isAlwaysSignal && mode.alwaysSignalLossState?.hasOutstandingLoss) {
      this.logger.log(
        `[${userId}] 🔄 Indicator: Always Signal active - executing martingale step ` +
        `${mode.alwaysSignalLossState.currentMartingaleStep}`
      );
      await this.executeAlwaysSignalMartingale(userId, config, session);
      return;
    }

    try {
      mode.cycleNumber++;
      this.logger.log(`[${userId}] === PHASE 1: Waiting for minute boundary ===`);
      await this.waitForMinuteBoundary();

      if (!mode.isActive) return;

      this.logger.log(`[${userId}] === PHASE 2: Collecting candle data ===`);
      const candles = await this.collectAndAggregateCandles(config.asset!.ric, session);
      if (!candles || candles.length === 0) {
        throw new Error('Failed to collect candle data');
      }
      mode.historicalCandles = candles;

      this.logger.log(`[${userId}] === PHASE 3: Analyzing data with ${config.settings.type} ===`);
      const analysis = this.analyzeData(candles, config.settings);
      mode.analysisResult = analysis;

      this.logger.log(`[${userId}] Analysis Result: ${analysis.trend} (Strength: ${analysis.strength})`);

      this.logger.log(`[${userId}] === PHASE 4: Generating price predictions ===`);
      const predictions = this.generatePricePredictions(analysis, config.settings, candles);
      mode.pricePredictions = predictions;

      this.logger.log(`[${userId}] Generated ${predictions.length} predictions`);

      this.logger.log(`[${userId}] === PHASE 5: Starting price monitoring ===`);
      this.startPriceMonitoring(userId, config, session);

    } catch (error: any) {
      this.logger.error(`[${userId}] Error in indicator cycle: ${error.message}`);
      await this.handleCycleCompletion(userId, 'ERROR', error.message);
    }
  }

  private async executeAlwaysSignalMartingale(userId: string, config: IndicatorConfig, session: any) {
    const mode = this.activeModes.get(userId);
    if (!mode || !mode.alwaysSignalLossState) return;

    const lossState = mode.alwaysSignalLossState;
    const step = lossState.currentMartingaleStep;

    if (step > config.martingale.maxSteps) {
      this.logger.log(`[${userId}] Always Signal: Max steps reached - RESET`);
      mode.alwaysSignalLossState = null;
      await this.handleCycleCompletion(userId, 'MARTINGALE_FAILED', 'Max steps reached');
      return;
    }

    const amount = this.calculateMartingaleAmount(config, step);
    const trend = lossState.currentTrend;

    mode.isTradeExecuted = true;
    mode.currentMartingaleStep = step;
    mode.isHandlingResult = false;

    const orderId = uuidv4();
    mode.activeOrderId = orderId;
    mode.activeOrderTrend = trend;
    mode.activeOrderAmount = amount;
    mode.activeOrderExecutedAt = Date.now();
    mode.totalExecutions++;

    this.writeLog(userId, {
      id: `${orderId}_s${step}`,
      orderId,
      trend,
      amount,
      martingaleStep: step,
      executedAt: Date.now(),
      indicatorType: mode.analysisResult?.indicatorType ?? 'UNKNOWN',
      cycleNumber: mode.cycleNumber,
      note: `Always Signal Martingale step ${step}/${config.martingale.maxSteps}`,
    });

    this.logger.log(`[${userId}] Always Signal: Executing step ${step}/${config.martingale.maxSteps}`);

    const tradeResult = await mode.wsClient.placeTrade(
      this.buildTradePayload(session, config, amount, trend),
    );

    if (!tradeResult?.dealId) {
      this.logger.error(`[${userId}] Always Signal trade failed: ${tradeResult?.error}`);
      mode.alwaysSignalLossState = null;
      await this.handleCycleCompletion(userId, 'MARTINGALE_FAILED', 'Trade placement error');
      return;
    }

    mode.activeDealId = tradeResult.dealId;
    this.logger.log(`[${userId}] Always Signal trade placed: step=${step} dealId=${tradeResult.dealId}`);

    this.startResultTimeout(userId, orderId, session, config, step);
  }

  private async waitForMinuteBoundary(): Promise<void> {
    const now = Date.now();
    const seconds = Math.floor((now / 1000) % 60);
    const millis = now % 1000;
    const waitTime = (60 - seconds) * 1000 - millis;

    if (waitTime > 0) {
      await this.sleep(waitTime + MINUTE_BOUNDARY_OFFSET_MS);
    }
  }

  private async collectAndAggregateCandles(symbol: string, session: any): Promise<Candle[]> {
    const fiveSecondCandles: Candle[] = [];
    const encodedSymbol = symbol.replace('/', '%2F');
    const utcNow = new Date();

    for (let hoursBack = 0; hoursBack <= 5; hoursBack++) {
      const targetTime = new Date(utcNow.getTime() - hoursBack * 60 * 60 * 1000);
      const dateForApi = targetTime.toISOString().slice(0, 13) + ':00:00';

      try {
        const headers = this.buildStockityHeaders(session);
        const response = await curlGet(
          `${BASE_URL}/candles/v1/${encodedSymbol}/${dateForApi}/5`,
          headers,
          5000,
        );

        if (response?.data?.data) {
          const parsed = response.data.data
            .map((d: any) => this.parseCandleData(d))
            .filter((c): c is Candle => c !== null);
          fiveSecondCandles.push(...parsed);
        }

        if (fiveSecondCandles.length >= 8000) break;
      } catch (err) {
        this.logger.warn(`Error fetching candles for hour ${hoursBack}: ${err}`);
      }

      await this.sleep(200);
    }

    if (fiveSecondCandles.length < 2160) {
      throw new Error(`Insufficient 5-second data: ${fiveSecondCandles.length} < 2160`);
    }

    return this.aggregateToOneMinuteCandles(fiveSecondCandles);
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

      if (
        candle.open > 0 &&
        candle.close > 0 &&
        candle.high >= Math.max(candle.open, candle.close) &&
        candle.low <= Math.min(candle.open, candle.close)
      ) {
        return candle;
      }
      return null;
    } catch {
      return null;
    }
  }

  private aggregateToOneMinuteCandles(fiveSecondCandles: Candle[]): Candle[] {
    const grouped = new Map<number, Candle[]>();

    for (const candle of fiveSecondCandles) {
      const timeMs = new Date(candle.createdAt).getTime();
      const minuteMs = Math.floor(timeMs / CANDLE_INTERVAL_MS) * CANDLE_INTERVAL_MS;

      if (!grouped.has(minuteMs)) {
        grouped.set(minuteMs, []);
      }
      grouped.get(minuteMs)!.push(candle);
    }

    const oneMinuteCandles: Candle[] = [];
    const sortedMinutes = Array.from(grouped.keys()).sort((a, b) => a - b);

    for (const minuteMs of sortedMinutes) {
      const candles = grouped.get(minuteMs)!;
      if (candles.length >= 3) {
        oneMinuteCandles.push({
          open: candles[0].open,
          close: candles[candles.length - 1].close,
          high: Math.max(...candles.map((c) => c.high)),
          low: Math.min(...candles.map((c) => c.low)),
          createdAt: new Date(minuteMs).toISOString(),
        });
      }
    }

    return oneMinuteCandles.slice(-HISTORICAL_CANDLES_COUNT);
  }

  private analyzeData(candles: Candle[], settings: IndicatorSettings): IndicatorAnalysisResult {
    switch (settings.type) {
      case IndicatorType.SMA:
        return this.calculateSMA(candles, settings.period);
      case IndicatorType.EMA:
        return this.calculateEMA(candles, settings.period);
      case IndicatorType.RSI:
        return this.calculateRSI(candles, settings.period, settings.rsiOverbought, settings.rsiOversold);
      default:
        return this.calculateSMA(candles, settings.period);
    }
  }

  private calculateSMA(candles: Candle[], period: number): IndicatorAnalysisResult {
    const values: number[] = [];

    for (let i = period - 1; i < candles.length; i++) {
      const sum = candles.slice(i - period + 1, i + 1).reduce((acc, c) => acc + c.close, 0);
      values.push(sum / period);
    }

    const finalValue = values[values.length - 1];
    const currentPrice = candles[candles.length - 1].close;
    const trend = currentPrice > finalValue ? 'BULLISH' : 'BEARISH';
    const strength = this.calculateTrendStrength(values);

    return {
      indicatorType: IndicatorType.SMA,
      calculatedValues: values,
      finalIndicatorValue: finalValue,
      trend,
      strength,
      analysisTime: Date.now(),
    };
  }

  private calculateEMA(candles: Candle[], period: number): IndicatorAnalysisResult {
    const values: number[] = [];
    const multiplier = 2 / (period + 1);
    let ema = candles[0].close;

    for (const candle of candles) {
      ema = candle.close * multiplier + ema * (1 - multiplier);
      values.push(ema);
    }

    const finalValue = values[values.length - 1];
    const currentPrice = candles[candles.length - 1].close;
    const trend = currentPrice > finalValue ? 'BULLISH' : 'BEARISH';
    const strength = this.calculateTrendStrength(values);

    return {
      indicatorType: IndicatorType.EMA,
      calculatedValues: values,
      finalIndicatorValue: finalValue,
      trend,
      strength,
      analysisTime: Date.now(),
    };
  }

  private calculateRSI(
    candles: Candle[],
    period: number,
    overbought: number,
    oversold: number,
  ): IndicatorAnalysisResult {
    const values: number[] = [];
    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {
      const change = candles[i].close - candles[i - 1].close;
      if (change > 0) gains += change;
      else losses += Math.abs(change);
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    for (let i = period + 1; i < candles.length; i++) {
      const change = candles[i].close - candles[i - 1].close;
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? Math.abs(change) : 0;

      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;

      const rs = avgLoss > 0 ? avgGain / avgLoss : 100;
      const rsi = 100 - 100 / (1 + rs);
      values.push(rsi);
    }

    const finalValue = values[values.length - 1];

    let trend: string;
    if (finalValue > overbought) trend = 'BEARISH';
    else if (finalValue < oversold) trend = 'BULLISH';
    else trend = 'NEUTRAL';

    let strength: string;
    if (finalValue > overbought || finalValue < oversold) strength = 'STRONG';
    else if (finalValue > 60 || finalValue < 40) strength = 'MODERATE';
    else strength = 'WEAK';

    return {
      indicatorType: IndicatorType.RSI,
      calculatedValues: values,
      finalIndicatorValue: finalValue,
      trend,
      strength,
      analysisTime: Date.now(),
    };
  }

  private calculateTrendStrength(values: number[]): string {
    if (values.length < 5) return 'WEAK';

    const recent = values.slice(-5);
    const isUpTrend = recent.every((v, i) => i === 0 || v >= recent[i - 1]);
    const isDownTrend = recent.every((v, i) => i === 0 || v <= recent[i - 1]);

    if (isUpTrend || isDownTrend) return 'STRONG';
    if (recent[0] !== recent[recent.length - 1]) return 'MODERATE';
    return 'WEAK';
  }

  private generatePricePredictions(
    analysis: IndicatorAnalysisResult,
    settings: IndicatorSettings,
    candles: Candle[],
  ): PricePrediction[] {
    const currentPrice = candles[candles.length - 1].close;
    const predictions: PricePrediction[] = [];

    const movements = candles.slice(-20).map((c) => Math.abs(c.high - c.low));
    const avgMovement = movements.reduce((a, b) => a + b, 0) / movements.length;
    const baseMovement = avgMovement * settings.sensitivity;

    let baseConfidence = 0.6;
    if (analysis.strength === 'STRONG') baseConfidence = 0.8;
    else if (analysis.strength === 'MODERATE') baseConfidence = 0.7;

    let sensitivityBonus = 0;
    if (settings.sensitivity <= 0.1) sensitivityBonus = -0.05;
    else if (settings.sensitivity >= 5) sensitivityBonus = 0.05;

    const finalConfidence = Math.min(1, baseConfidence + sensitivityBonus);

    if (analysis.indicatorType === IndicatorType.RSI) {
      const rsiValue = analysis.finalIndicatorValue;

      if (rsiValue >= settings.rsiOverbought) {
        predictions.push({
          id: uuidv4(),
          targetPrice: currentPrice + baseMovement * 0.5,
          predictionType: 'RESISTANCE_TARGET_1',
          recommendedTrend: 'put',
          confidence: finalConfidence * 0.9,
          isTriggered: false,
          triggeredAt: 0,
          createdAt: Date.now(),
          isDisabled: false,
        });
        predictions.push({
          id: uuidv4(),
          targetPrice: currentPrice - baseMovement,
          predictionType: 'SUPPORT_TARGET_1',
          recommendedTrend: 'put',
          confidence: finalConfidence,
          isTriggered: false,
          triggeredAt: 0,
          createdAt: Date.now(),
          isDisabled: false,
        });
      } else if (rsiValue <= settings.rsiOversold) {
        predictions.push({
          id: uuidv4(),
          targetPrice: currentPrice + baseMovement,
          predictionType: 'RESISTANCE_TARGET_1',
          recommendedTrend: 'call',
          confidence: finalConfidence,
          isTriggered: false,
          triggeredAt: 0,
          createdAt: Date.now(),
          isDisabled: false,
        });
        predictions.push({
          id: uuidv4(),
          targetPrice: currentPrice - baseMovement * 0.5,
          predictionType: 'SUPPORT_TARGET_1',
          recommendedTrend: 'call',
          confidence: finalConfidence * 0.9,
          isTriggered: false,
          triggeredAt: 0,
          createdAt: Date.now(),
          isDisabled: false,
        });
      } else {
        const neutralMovement = baseMovement * 0.7;
        predictions.push({
          id: uuidv4(),
          targetPrice: currentPrice + neutralMovement,
          predictionType: 'RESISTANCE_TARGET_1',
          recommendedTrend: 'put',
          confidence: finalConfidence * 0.8,
          isTriggered: false,
          triggeredAt: 0,
          createdAt: Date.now(),
          isDisabled: false,
        });
        predictions.push({
          id: uuidv4(),
          targetPrice: currentPrice - neutralMovement,
          predictionType: 'SUPPORT_TARGET_1',
          recommendedTrend: 'call',
          confidence: finalConfidence * 0.8,
          isTriggered: false,
          triggeredAt: 0,
          createdAt: Date.now(),
          isDisabled: false,
        });
      }
    } else {
      predictions.push({
        id: uuidv4(),
        targetPrice: currentPrice + baseMovement,
        predictionType: 'RESISTANCE_TARGET_1',
        recommendedTrend: 'put',
        confidence: finalConfidence,
        isTriggered: false,
        triggeredAt: 0,
        createdAt: Date.now(),
        isDisabled: false,
      });
      predictions.push({
        id: uuidv4(),
        targetPrice: currentPrice - baseMovement,
        predictionType: 'SUPPORT_TARGET_1',
        recommendedTrend: 'call',
        confidence: finalConfidence,
        isTriggered: false,
        triggeredAt: 0,
        createdAt: Date.now(),
        isDisabled: false,
      });
    }

    return predictions.sort((a, b) => b.confidence - a.confidence);
  }

  private startPriceMonitoring(userId: string, config: IndicatorConfig, session: any) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    if (mode.monitoringInterval) {
      clearInterval(mode.monitoringInterval);
    }

    mode.monitoringInterval = setInterval(async () => {
      if (!mode.isActive) {
        clearInterval(mode.monitoringInterval!);
        return;
      }

      if (mode.isTradeExecuted) return;

      try {
        const currentPrice = await this.getCurrentPrice(config.asset!.ric, session);
        if (!currentPrice) return;

        for (const prediction of mode.pricePredictions) {
          if (prediction.isTriggered || prediction.isDisabled) continue;

          const shouldTrigger = prediction.predictionType.includes('RESISTANCE')
            ? currentPrice >= prediction.targetPrice
            : currentPrice <= prediction.targetPrice;

          if (shouldTrigger) {
            prediction.isTriggered = true;
            prediction.triggeredAt = Date.now();

            this.logger.log(`[${userId}] Prediction triggered: ${prediction.predictionType} at ${currentPrice}`);

            await this.executeTrade(userId, config, session, prediction);
            break;
          }
        }
      } catch (err) {
        this.logger.error(`[${userId}] Error in price monitoring: ${err}`);
      }
    }, PRICE_MONITOR_INTERVAL);
  }

  private async getCurrentPrice(symbol: string, session: any): Promise<number | null> {
    try {
      const encodedSymbol = symbol.replace('/', '%2F');
      const now = new Date();
      const dateForApi = now.toISOString().slice(0, 13) + ':00:00';

      const headers = this.buildStockityHeaders(session);
      const response = await curlGet(
        `${BASE_URL}/candles/v1/${encodedSymbol}/${dateForApi}/5`,
        headers,
        5000,
      );

      if (response?.data?.data?.length > 0) {
        const lastCandle = response.data.data[response.data.data.length - 1];
        return parseFloat(lastCandle.close);
      }
      return null;
    } catch (err) {
      this.logger.error(`Error getting current price: ${err}`);
      return null;
    }
  }

  private async executeTrade(
    userId: string,
    config: IndicatorConfig,
    session: any,
    prediction: PricePrediction,
  ) {
    const mode = this.activeModes.get(userId);
    if (!mode || mode.isTradeExecuted) return;

    mode.isTradeExecuted = true;
    mode.currentMartingaleStep = 0;
    mode.isHandlingResult = false;

    const orderId = uuidv4();
    const amount = config.settings.amount;

    const order: IndicatorOrder = {
      id: orderId,
      assetRic: config.asset!.ric,
      assetName: config.asset!.name,
      trend: prediction.recommendedTrend,
      amount,
      executionTime: Date.now(),
      triggerLevel: prediction.targetPrice,
      triggerType: prediction.predictionType,
      indicatorType: mode.analysisResult?.indicatorType || 'UNKNOWN',
      indicatorValue: mode.analysisResult?.finalIndicatorValue || 0,
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

    mode.indicatorOrders.push(order);
    mode.activeOrderId = orderId;
    mode.activeOrderTrend = prediction.recommendedTrend;
    mode.activeOrderAmount = amount;
    mode.activeOrderExecutedAt = Date.now();
    mode.totalExecutions++;

    this.writeLog(userId, {
      id: `${orderId}_s0`,
      orderId,
      trend: prediction.recommendedTrend,
      amount,
      martingaleStep: 0,
      executedAt: Date.now(),
      indicatorType: mode.analysisResult?.indicatorType ?? 'UNKNOWN',
      cycleNumber: mode.cycleNumber,
      note: `${prediction.predictionType} triggered`,
    });

    this.logger.log(`[${userId}] Executing trade: ${prediction.recommendedTrend} at ${prediction.targetPrice}`);

    const tradeResult = await mode.wsClient.placeTrade(
      this.buildTradePayload(session, config, amount, prediction.recommendedTrend),
    );

    if (!tradeResult?.dealId) {
      this.logger.error(`[${userId}] Trade placement failed: ${tradeResult?.error}`);
      mode.isTradeExecuted = false;
      mode.activeOrderId = null;
      mode.activeDealId = null;
      return;
    }

    mode.activeDealId = tradeResult.dealId;
    this.logger.log(`[${userId}] Trade placed: orderId=${orderId} dealId=${tradeResult.dealId}`);

    this.startResultTimeout(userId, orderId, session, config, 0);
  }

  private handleWsDealResult(userId: string, payload: DealResultPayload) {
    const mode = this.activeModes.get(userId);
    if (!mode || !mode.isActive || !mode.isTradeExecuted) return;

    const statusStr = (payload.status || payload.result || '').toLowerCase();
    if (!TERMINAL_STATUSES.has(statusStr)) {
      this.logger.debug(`[${userId}] Skip non-terminal WS event status="${statusStr}"`);
      return;
    }

    if (mode.isHandlingResult) {
      this.logger.debug(`[${userId}] Skip WS result — already handling`);
      return;
    }

    const dealId = String(payload.id ?? '');

    let isMatch = mode.activeDealId !== null && mode.activeDealId === dealId;

    if (!isMatch && payload.uuid && mode.activeDealId) {
      isMatch = mode.activeDealId === payload.uuid;
      if (isMatch) this.logger.debug(`[${userId}] Match via UUID cross-ref`);
    }

    if (!isMatch) {
      isMatch = this.isFallbackMatch(mode, payload);
      if (isMatch) {
        this.logger.warn(
          `[${userId}] ⚠️ Fallback match: trend=${mode.activeOrderTrend} amount=${mode.activeOrderAmount} ` +
          `elapsed=${Date.now() - mode.activeOrderExecutedAt}ms`,
        );
      }
    }

    if (!isMatch) return;

    mode.isHandlingResult = true;
    this.clearResultTimeout(mode);

    const isWin  = statusStr === 'won'  || statusStr === 'win';
    const isDraw = statusStr === 'stand' || statusStr === 'draw' || statusStr === 'tie';

    this.processTradeOutcome(userId, isWin, isDraw, mode.currentMartingaleStep);
  }

  private isFallbackMatch(mode: ActiveMode, payload: DealResultPayload): boolean {
    if (!mode.activeOrderExecutedAt) return false;
    const elapsed = Date.now() - mode.activeOrderExecutedAt;
    if (elapsed > FALLBACK_MATCH_WINDOW_MS) return false;
    if (payload.amount !== undefined && payload.amount !== mode.activeOrderAmount) return false;
    if (payload.trend && payload.trend !== mode.activeOrderTrend) return false;
    return true;
  }

  private async processTradeOutcome(
    userId: string,
    isWin: boolean,
    isDraw: boolean,
    step: number,
  ) {
    const mode = this.activeModes.get(userId);
    if (!mode || !mode.isActive) return;

    const config = await this.getConfig(userId);
    const session = await this.authService.getSession(userId);
    if (!session) return;

    const result = isWin ? 'WIN' : isDraw ? 'DRAW' : 'LOSE';
    this.logger.log(`[${userId}] Trade result: ${result} (step=${step})`);

    const profitRate = 0.85;
    let tradePnL = 0;
    if (isWin) tradePnL = Math.floor(mode.activeOrderAmount * profitRate);
    else if (!isDraw) tradePnL = -mode.activeOrderAmount;
    mode.sessionPnL += tradePnL;

    const resultLogId = `${mode.activeOrderId}_s${step}`;
    this.writeLog(userId, {
      id: resultLogId,
      orderId: mode.activeOrderId!,
      trend: mode.activeOrderTrend!,
      amount: mode.activeOrderAmount,
      martingaleStep: step,
      dealId: mode.activeDealId ?? undefined,
      result,
      profit: tradePnL,
      sessionPnL: mode.sessionPnL,
      executedAt: Date.now(),
      indicatorType: mode.analysisResult?.indicatorType ?? 'UNKNOWN',
      cycleNumber: mode.cycleNumber,
    });

    const order = mode.indicatorOrders.find((o) => o.id === mode.activeOrderId);
    if (order) {
      order.martingaleState.isCompleted = true;
      order.martingaleState.finalResult = result;
    }

    if (isWin || isDraw) {
      if (isWin) {
        mode.consecutiveWins++;
        mode.consecutiveLosses = 0;
        mode.totalWins++;
        // Clear Always Signal loss on WIN
        if (mode.alwaysSignalLossState) {
          this.logger.log(`[${userId}] ✅ Always Signal: Loss cleared (WIN)`);
          mode.alwaysSignalLossState = null;
        }
      }
      await this.handleCycleCompletion(userId, isWin ? 'INDICATOR_WIN' : 'DRAW', '');
    } else {
      mode.consecutiveLosses++;
      mode.consecutiveWins = 0;
      // Martingale-aware stats: count loss only at sequence end.
      //   - Mid-sequence LOSE (step < maxSteps) → skip (sequence continues)
      //   - Final step LOSE (step >= maxSteps)  → totalLosses+1
      //   - No martingale                       → totalLosses+1 (same as before)
      const _iM = config.martingale;
      const _iMEnabled = _iM.isEnabled && _iM.maxSteps > 0;
      if (!_iMEnabled || step >= _iM.maxSteps) {
        mode.totalLosses++;
      }

      if (config.martingale.isEnabled) {
        if (config.martingale.isAlwaysSignal) {
          // Always Signal mode - record loss and wait for next signal
          const nextStep = step + 1;
          if (nextStep <= config.martingale.maxSteps) {
            mode.alwaysSignalLossState = {
              hasOutstandingLoss: true,
              currentMartingaleStep: nextStep,
              originalOrderId: mode.activeOrderId!,
              totalLoss: mode.activeOrderAmount,
              currentTrend: mode.activeOrderTrend!,
            };
            this.logger.log(
              `[${userId}] 📊 Always Signal: Loss recorded, step ${nextStep}/${config.martingale.maxSteps}`
            );
          } else {
            this.logger.log(`[${userId}] Always Signal: Max steps reached`);
            mode.alwaysSignalLossState = null;
          }
          await this.handleCycleCompletion(userId, 'ALWAYS_SIGNAL_WAITING', 'Waiting for next signal');
        } else if (step < config.martingale.maxSteps) {
          await this.executeMartingaleStep(userId, config, session, step + 1);
        } else {
          if (step >= config.martingale.maxSteps) {
            this.logger.log(`[${userId}] Max martingale steps reached`);
            await this.handleCycleCompletion(userId, 'MARTINGALE_FAILED', 'Max steps reached');
          } else {
            await this.handleCycleCompletion(userId, 'SINGLE_LOSS', '');
          }
        }
      } else {
        await this.handleCycleCompletion(userId, 'SINGLE_LOSS', '');
      }
    }
  }

  private async executeMartingaleStep(
    userId: string,
    config: IndicatorConfig,
    session: any,
    step: number,
  ) {
    const mode = this.activeModes.get(userId);
    if (!mode || !mode.isActive) return;

    if (step > config.martingale.maxSteps) {
      this.logger.log(`[${userId}] Max martingale steps reached`);
      await this.handleCycleCompletion(userId, 'MARTINGALE_FAILED', 'Max steps reached');
      return;
    }

    const martingaleAmount = this.calculateMartingaleAmount(config, step);
    const trend = mode.activeOrderTrend!;

    mode.currentMartingaleStep = step;
    mode.activeOrderAmount = martingaleAmount;
    mode.activeOrderExecutedAt = Date.now();
    mode.isHandlingResult = false;

    this.logger.log(`[${userId}] Martingale step ${step}: ${martingaleAmount}`);

    this.writeLog(userId, {
      id: `${mode.activeOrderId}_s${step}`,
      orderId: mode.activeOrderId!,
      trend,
      amount: martingaleAmount,
      martingaleStep: step,
      executedAt: Date.now(),
      indicatorType: mode.analysisResult?.indicatorType ?? 'UNKNOWN',
      cycleNumber: mode.cycleNumber,
      note: `Martingale step ${step}`,
    });

    const tradeResult = await mode.wsClient.placeTrade(
      this.buildTradePayload(session, config, martingaleAmount, trend),
    );

    if (!tradeResult?.dealId) {
      this.logger.error(`[${userId}] Martingale trade placement failed: ${tradeResult?.error}`);
      await this.handleCycleCompletion(userId, 'MARTINGALE_FAILED', 'Trade placement error');
      return;
    }

    mode.activeDealId = tradeResult.dealId;
    this.logger.log(`[${userId}] Martingale trade placed: step=${step} dealId=${tradeResult.dealId}`);

    this.startResultTimeout(userId, mode.activeOrderId!, session, config, step);
  }

  private calculateMartingaleAmount(config: IndicatorConfig, step: number): number {
    const multiplier = config.martingale.multiplierType === 'FIXED'
      ? config.martingale.multiplierValue
      : 1 + config.martingale.multiplierValue / 100;

    return Math.floor(config.settings.amount * Math.pow(multiplier, step));
  }

  private startResultTimeout(
    userId: string,
    orderId: string,
    session: any,
    config: IndicatorConfig,
    step: number,
  ) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    this.clearResultTimeout(mode);

    mode.resultTimeoutTimer = setTimeout(async () => {
      const m = this.activeModes.get(userId);
      if (!m || !m.isActive || m.isHandlingResult) return;
      if (m.activeOrderId !== orderId && m.currentMartingaleStep !== step) return;

      this.logger.warn(`[${userId}] Result timeout — falling back to HTTP API (step=${step})`);

      try {
        const result = await this.fetchTradeResultById(session, config, m.activeDealId);
        if (result) {
          if (m.isHandlingResult) return;
          m.isHandlingResult = true;
          const isWin = result.status?.toLowerCase() === 'won';
          const isDraw = ['stand', 'draw', 'tie'].includes(result.status?.toLowerCase() || '');
          await this.processTradeOutcome(userId, isWin, isDraw, step);
        } else {
          this.logger.warn(`[${userId}] Fallback API tidak menemukan result — anggap LOSE`);
          m.isHandlingResult = true;
          await this.processTradeOutcome(userId, false, false, step);
        }
      } catch (err) {
        this.logger.error(`[${userId}] Fallback HTTP error: ${err}`);
        if (!m.isHandlingResult) {
          m.isHandlingResult = true;
          await this.processTradeOutcome(userId, false, false, step);
        }
      }
    }, RESULT_TIMEOUT_MS);
  }

  private clearResultTimeout(mode: ActiveMode) {
    if (mode.resultTimeoutTimer) {
      clearTimeout(mode.resultTimeoutTimer);
      mode.resultTimeoutTimer = null;
    }
  }

  private async fetchTradeResultById(
    session: any,
    config: IndicatorConfig,
    dealId: string | null,
  ): Promise<any | null> {
    try {
      const headers = {
        'authorization-token': session.stockityToken,
        'device-id': session.deviceId,
        'device-type': session.deviceType || 'web',
        'user-timezone': session.userTimezone || 'Asia/Jakarta',
        'User-Agent': session.userAgent,
        'Accept': 'application/json, text/plain, */*',
        'Origin': 'https://stockity.id',
        'Referer': 'https://stockity.id/',
      };

      const response = await curlGet(
        `${BASE_URL}/bo-deals-history/v3/deals/trade?type=${config.isDemoAccount ? 'demo' : 'real'}&locale=id`,
        headers,
        5000,
      );

      if (!response?.data?.data) return null;

      const deals: any[] = response.data.data.standard_trade_deals || response.data.data.deals || [];

      const terminalDeals = deals.filter((t: any) => {
        const status = (t.status || '').toLowerCase();
        return TERMINAL_STATUSES.has(status);
      });

      if (dealId) {
        const byId = terminalDeals.find(
          (t: any) => String(t.id) === dealId || t.uuid === dealId,
        );
        if (byId) return byId;
      }

      const recentTerminal = terminalDeals.find((t: any) => {
        const tradeTime = new Date(t.created_at).getTime();
        return tradeTime > Date.now() - FALLBACK_MATCH_WINDOW_MS;
      });

      return recentTerminal || null;
    } catch (err) {
      this.logger.error(`Error fetching trade result: ${err}`);
      return null;
    }
  }

  private async handleCycleCompletion(userId: string, reason: string, message: string) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    this.clearResultTimeout(mode);
    if (mode.monitoringInterval) {
      clearInterval(mode.monitoringInterval);
      mode.monitoringInterval = undefined;
    }

    this.logger.log(`[${userId}] Cycle completed: ${reason} - ${message}`);

    if (mode.autoRestartEnabled && mode.consecutiveRestarts < mode.maxConsecutiveRestarts) {
      mode.consecutiveRestarts++;
      this.logger.log(`[${userId}] Auto-restarting cycle #${mode.consecutiveRestarts}`);

      mode.isTradeExecuted = false;
      mode.activeOrderId = null;
      mode.activeDealId = null;
      mode.activeOrderTrend = null;
      mode.activeOrderAmount = 0;
      mode.activeOrderExecutedAt = 0;
      mode.currentMartingaleStep = 0;
      mode.isHandlingResult = false;
      mode.currentMartingaleOrder = null;
      mode.historicalCandles = [];
      mode.analysisResult = null;
      mode.pricePredictions = [];

      const config = await this.getConfig(userId);
      const session = await this.authService.getSession(userId);

      if (session) {
        await this.sleep(500);
        await this.executeIndicatorCycle(userId, config, session);
      }
    } else {
      await this.stopIndicatorMode(userId);
    }
  }

  async getLogs(userId: string, limit = 100): Promise<IndicatorLog[]> {
    const mode = this.activeModes.get(userId);
    if (mode && mode.logs.length > 0) {
      return mode.logs.slice(-limit);
    }

    try {
      const snap = await this.firebaseService.db
        .collection('indicator_logs')
        .doc(userId)
        .collection('entries')
        .orderBy('executedAt', 'desc')
        .limit(limit)
        .get();

      return snap.docs.map((d) => {
        const data = d.data() as any;
        return {
          ...data,
          executedAt: data.executedAt?.toMillis?.() ?? data.executedAt ?? 0,
        } as IndicatorLog;
      });
    } catch (err) {
      this.logger.error(`[${userId}] getLogs error: ${err}`);
      return [];
    }
  }

  private writeLog(userId: string, log: IndicatorLog) {
    const mode = this.activeModes.get(userId);
    if (mode) {
      const existingIdx = mode.logs.findIndex((l) => l.id === log.id);
      if (existingIdx !== -1) {
        mode.logs[existingIdx] = log;
      } else {
        mode.logs.push(log);
      }
      if (mode.logs.length > 500) mode.logs.splice(0, mode.logs.length - 500);
    }

    this.appendLogToFirebase(userId, log).catch((err) =>
      this.logger.error(`[${userId}] appendLogToFirebase error: ${err}`),
    );
  }

  private async appendLogToFirebase(userId: string, log: IndicatorLog) {
    await this.firebaseService.db
      .collection('indicator_logs')
      .doc(userId)
      .collection('entries')
      .doc(log.id)
      .set({
        ...log,
        executedAt: this.firebaseService.Timestamp.fromMillis(log.executedAt),
      });
  }

  private buildTradePayload(session: any, config: IndicatorConfig, amount: number, trend: string): any {
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
    await this.firebaseService.db.collection('indicator_status').doc(userId).set(
      { botState, updatedAt: this.firebaseService.FieldValue.serverTimestamp() },
      { merge: true },
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}