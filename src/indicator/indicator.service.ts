import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';
import { AuthService } from '../auth/auth.service';
import { StockityWebSocketClient } from '../schedule/websocket-client';
import axios from 'axios';
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

// Exported so the controller can reference it without TS4053
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

@Injectable()
export class IndicatorService implements OnModuleDestroy {
  private readonly logger = new Logger(IndicatorService.name);
  private configs = new Map<string, IndicatorConfig>();
  private activeModes = new Map<string, {
    isActive: boolean;
    wsClient: StockityWebSocketClient;
    historicalCandles: Candle[];
    analysisResult: IndicatorAnalysisResult | null;
    pricePredictions: PricePrediction[];
    indicatorOrders: IndicatorOrder[];
    pendingTradeResults: Map<string, any>;
    currentMartingaleOrder: IndicatorMartingaleOrder | null;
    isTradeExecuted: boolean;
    activeTradeOrderId: string | null;
    consecutiveWins: number;
    consecutiveLosses: number;
    totalExecutions: number;
    totalWins: number;
    totalLosses: number;
    autoRestartEnabled: boolean;
    consecutiveRestarts: number;
    maxConsecutiveRestarts: number;
    monitoringInterval?: NodeJS.Timeout;
  }>();

  constructor(
    private readonly firebaseService: FirebaseService,
    private readonly authService: AuthService,
  ) {}

  onModuleDestroy() {
    for (const [userId] of this.activeModes) {
      this.stopIndicatorMode(userId);
    }
  }

  // ==================== CONFIG ====================

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

  // ==================== INDICATOR MODE CONTROL ====================

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

    this.activeModes.set(userId, {
      isActive: true,
      wsClient: ws,
      historicalCandles: [],
      analysisResult: null,
      pricePredictions: [],
      indicatorOrders: [],
      pendingTradeResults: new Map(),
      currentMartingaleOrder: null,
      isTradeExecuted: false,
      activeTradeOrderId: null,
      consecutiveWins: 0,
      consecutiveLosses: 0,
      totalExecutions: 0,
      totalWins: 0,
      totalLosses: 0,
      autoRestartEnabled: true,
      consecutiveRestarts: 0,
      maxConsecutiveRestarts: 50,
    });

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
    if (mode.monitoringInterval) {
      clearInterval(mode.monitoringInterval);
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
        botState: 'RUNNING',
        totalExecutions: mode.totalExecutions,
        totalWins: mode.totalWins,
        totalLosses: mode.totalLosses,
        consecutiveWins: mode.consecutiveWins,
        consecutiveLosses: mode.consecutiveLosses,
        wsConnected: mode.wsClient.isConnected(),
        indicatorOrders: mode.indicatorOrders,
        pricePredictions: mode.pricePredictions,
        analysisResult: mode.analysisResult,
        config,
      };
    }

    const statusDoc = await this.firebaseService.db.collection('indicator_status').doc(userId).get();
    return {
      isActive: false,
      botState: statusDoc.exists ? (statusDoc.data()?.botState ?? 'STOPPED') : 'STOPPED',
      config,
    };
  }

  // ==================== CORE INDICATOR LOGIC ====================

  private async executeIndicatorCycle(userId: string, config: IndicatorConfig, session: any) {
    const mode = this.activeModes.get(userId);
    if (!mode || !mode.isActive) return;

    try {
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
        const response = await axios.get<CandleApiResponse>(
          `${BASE_URL}/candles/v1/${encodedSymbol}/${dateForApi}/5`,
          {
            headers: this.buildStockityHeaders(session),
            timeout: 5000,
          },
        );

        if (response.data?.data) {
          const parsed = response.data.data
            .map((d) => this.parseCandleData(d))
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

      if (candle.open > 0 && candle.close > 0 && candle.high >= Math.max(candle.open, candle.close) && candle.low <= Math.min(candle.open, candle.close)) {
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

  private calculateRSI(candles: Candle[], period: number, overbought: number, oversold: number): IndicatorAnalysisResult {
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

    mode.monitoringInterval = setInterval(async () => {
      if (!mode.isActive) {
        clearInterval(mode.monitoringInterval!);
        return;
      }

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

      const response = await axios.get<CandleApiResponse>(
        `${BASE_URL}/candles/v1/${encodedSymbol}/${dateForApi}/5`,
        {
          headers: this.buildStockityHeaders(session),
          timeout: 5000,
        },
      );

      if (response.data?.data?.length > 0) {
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
    const orderId = uuidv4();

    const order: IndicatorOrder = {
      id: orderId,
      assetRic: config.asset!.ric,
      assetName: config.asset!.name,
      trend: prediction.recommendedTrend,
      amount: config.settings.amount,
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
    mode.activeTradeOrderId = orderId;
    mode.totalExecutions++;

    this.logger.log(`[${userId}] Executing trade: ${prediction.recommendedTrend} at ${prediction.targetPrice}`);

    // Execute via WebSocket
    void mode.wsClient.placeTrade(
      this.buildTradePayload(session, config, config.settings.amount, prediction.recommendedTrend),
    );

    this.monitorTradeResult(userId, config, session, orderId);
  }

  private async monitorTradeResult(userId: string, config: IndicatorConfig, session: any, orderId: string) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    const maxWaitTime = 90000;
    const startTime = Date.now();

    const checkInterval = setInterval(async () => {
      if (!mode.isActive || Date.now() - startTime > maxWaitTime) {
        clearInterval(checkInterval);
        await this.handleTradeTimeout(userId, orderId);
        return;
      }

      try {
        const result = await this.fetchTradeResult(session, config);
        if (result) {
          clearInterval(checkInterval);
          await this.handleTradeResult(userId, config, session, orderId, result);
        }
      } catch (err) {
        this.logger.error(`[${userId}] Error checking trade result: ${err}`);
      }
    }, 2000);
  }

  private async fetchTradeResult(session: any, config: IndicatorConfig): Promise<any | null> {
    try {
      const response = await axios.get(
        `${BASE_URL}/profile/trading-history?type=${config.isDemoAccount ? 'demo' : 'real'}`,
        {
          headers: this.buildStockityHeaders(session),
          timeout: 5000,
        },
      );

      if (response.data?.data) {
        const trades = response.data.data;
        const recentTrade = trades.find((t: any) => {
          const tradeTime = new Date(t.created_at).getTime();
          return tradeTime > Date.now() - 120000;
        });
        return recentTrade || null;
      }
      return null;
    } catch (err) {
      this.logger.error(`Error fetching trade result: ${err}`);
      return null;
    }
  }

  private async handleTradeResult(
    userId: string,
    config: IndicatorConfig,
    session: any,
    orderId: string,
    result: any,
  ) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    const isWin = result.status?.toLowerCase() === 'won';
    const order = mode.indicatorOrders.find((o) => o.id === orderId);

    if (order) {
      order.martingaleState.isCompleted = true;
      order.martingaleState.finalResult = isWin ? 'WIN' : 'LOSE';

      if (isWin) {
        order.martingaleState.totalRecovered = result.win || result.payment || 0;
        mode.consecutiveWins++;
        mode.consecutiveLosses = 0;
        mode.totalWins++;
      } else {
        order.martingaleState.totalLoss = config.settings.amount;
        mode.consecutiveLosses++;
        mode.consecutiveWins = 0;
        mode.totalLosses++;
      }
    }

    this.logger.log(`[${userId}] Trade result: ${isWin ? 'WIN' : 'LOSE'}`);

    if (!isWin && config.martingale.isEnabled) {
      await this.startMartingale(userId, config, session, orderId);
    } else {
      await this.handleCycleCompletion(userId, isWin ? 'INDICATOR_WIN' : 'SINGLE_LOSS', '');
    }
  }

  private async startMartingale(
    userId: string,
    config: IndicatorConfig,
    session: any,
    parentOrderId: string,
    step: number = 1,
  ) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    if (step > config.martingale.maxSteps) {
      this.logger.log(`[${userId}] Max martingale steps reached`);
      await this.handleCycleCompletion(userId, 'MARTINGALE_FAILED', 'Max steps reached');
      return;
    }

    const martingaleAmount = this.calculateMartingaleAmount(config, step);

    mode.currentMartingaleOrder = {
      originalOrderId: parentOrderId,
      currentStep: step,
      maxSteps: config.martingale.maxSteps,
      totalLoss: config.settings.amount,
      nextAmount: martingaleAmount,
      isActive: true,
      indicatorType: mode.analysisResult?.indicatorType || 'UNKNOWN',
      lastTriggerLevel: 0,
    };

    this.logger.log(`[${userId}] Martingale step ${step}: ${martingaleAmount}`);

    const parentOrder = mode.indicatorOrders.find((o) => o.id === parentOrderId);
    if (parentOrder) {
      void mode.wsClient.placeTrade(
        this.buildTradePayload(session, config, martingaleAmount, parentOrder.trend),
      );

      this.monitorMartingaleResult(userId, config, session, parentOrderId, step);
    }
  }

  private calculateMartingaleAmount(config: IndicatorConfig, step: number): number {
    const multiplier = config.martingale.multiplierType === 'FIXED'
      ? config.martingale.multiplierValue
      : 1 + config.martingale.multiplierValue / 100;

    return Math.floor(config.settings.amount * Math.pow(multiplier, step - 1));
  }

  private async monitorMartingaleResult(
    userId: string,
    config: IndicatorConfig,
    session: any,
    parentOrderId: string,
    step: number,
  ) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    const maxWaitTime = 90000;
    const startTime = Date.now();

    const checkInterval = setInterval(async () => {
      if (!mode.isActive || Date.now() - startTime > maxWaitTime) {
        clearInterval(checkInterval);
        return;
      }

      try {
        const result = await this.fetchTradeResult(session, config);
        if (result) {
          clearInterval(checkInterval);

          const isWin = result.status?.toLowerCase() === 'won';

          if (isWin) {
            await this.handleCycleCompletion(userId, 'MARTINGALE_WIN', `Step ${step}`);
          } else {
            await this.startMartingale(userId, config, session, parentOrderId, step + 1);
          }
        }
      } catch (err) {
        this.logger.error(`[${userId}] Error checking martingale result: ${err}`);
      }
    }, 2000);
  }

  private async handleTradeTimeout(userId: string, orderId: string) {
    this.logger.warn(`[${userId}] Trade result timeout for order ${orderId}`);
    await this.handleCycleCompletion(userId, 'TIMEOUT', 'Trade result timeout');
  }

  private async handleCycleCompletion(userId: string, reason: string, message: string) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    if (mode.monitoringInterval) {
      clearInterval(mode.monitoringInterval);
    }

    this.logger.log(`[${userId}] Cycle completed: ${reason} - ${message}`);

    if (mode.autoRestartEnabled && mode.consecutiveRestarts < mode.maxConsecutiveRestarts) {
      mode.consecutiveRestarts++;
      this.logger.log(`[${userId}] Auto-restarting cycle #${mode.consecutiveRestarts}`);

      mode.isTradeExecuted = false;
      mode.activeTradeOrderId = null;
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

  // ==================== HELPERS ====================

  /**
   * Builds a trade payload compatible with StockityWebSocketClient.placeTrade().
   */
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