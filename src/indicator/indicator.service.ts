import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
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

// currentTrend dihapus: trend martingale mengikuti sinyal indicator baru,
// bukan disimpan dari order yang LOSE.
export interface IndicatorAlwaysSignalLossState {
  hasOutstandingLoss: boolean;
  currentMartingaleStep: number;
  originalOrderId: string;
  totalLoss: number;
}

export interface IndicatorConfig {
  asset: { ric: string; name: string; profitRate?: number } | null;
  settings: IndicatorSettings;
  martingale: {
    isEnabled: boolean;
    maxSteps: number;
    baseAmount: number;
    multiplierValue: number;
    multiplierType: 'FIXED' | 'PERCENTAGE';
    isAlwaysSignal: boolean;
    /**
     * Stop Loss: bot otomatis berhenti jika total kerugian sesi
     * mencapai atau melebihi nilai ini. 0 = nonaktif.
     */
    stopLoss?: number;
    /**
     * Stop Profit: bot otomatis berhenti jika total keuntungan sesi
     * mencapai atau melebihi nilai ini. 0 = nonaktif.
     */
    stopProfit?: number;
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
    private readonly supabaseService: SupabaseService,
    private readonly authService: AuthService,
  ) {}

  async onModuleDestroy() {
    // Parallel stop: tunggu semua updateStatus selesai sebelum proses mati.
    // Old: fire-and-forget loop → Supabase botState tetap RUNNING setelah restart.
    await Promise.all([...this.activeModes.keys()].map(id => this.stopIndicatorMode(id)));
  }

  async getConfig(userId: string): Promise<IndicatorConfig> {
    if (this.configs.has(userId)) return this.configs.get(userId)!;

    const { data: doc, error } = await this.supabaseService.client.from('indicator_configs').select('*').eq('user_id', userId).single();
    if (doc && !error) {
      const cfg: IndicatorConfig = {
        asset: doc.asset || null,
        settings: doc.settings || DEFAULT_INDICATOR_SETTINGS,
        martingale: doc.martingale || {
          isEnabled: true,
          maxSteps: 2,
          baseAmount: 1400000,
          multiplierValue: 2.5,
          multiplierType: 'FIXED',
          isAlwaysSignal: false,
          stopLoss: 0,
          stopProfit: 0,
        },
        isDemoAccount: doc.is_demo_account ?? true,
        currency: doc.currency || 'IDR',
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
        stopLoss: 0,
        stopProfit: 0,
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

    // Petakan ke nama kolom Supabase secara eksplisit (snake_case).
    // Old: spread plainCfg → kolom 'isDemoAccount' tidak cocok dengan 'is_demo_account'
    //      → isDemoAccount tidak pernah tersimpan, selalu revert ke default true setelah restart.
    await this.supabaseService.client.from('indicator_configs').upsert({
      user_id:         userId,
      asset:           updated.asset,
      settings:        updated.settings,
      martingale:      updated.martingale,
      is_demo_account: updated.isDemoAccount,
      currency:        updated.currency,
      updated_at:      this.supabaseService.now(),
    });

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
      session.stockity_token,
      session.device_id,
      session.device_type || 'web',
      session.user_agent,
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

    // ✅ FIX: Supabase maybeSingle() → null jika row tidak ada (bukan crash)
    // Firestore pattern lama: statusDoc.exists / statusDoc.data() → CRASH di Supabase
    const { data: statusDoc } = await this.supabaseService.client
      .from('indicator_status')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    return {
      isActive: false,
      isRunning: false,
      botState: statusDoc?.bot_state ?? 'STOPPED',
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

    // Always Signal: TIDAK lagi bypass analisis candle.
    // Siklus berjalan normal (fetch candle → analisis → eksekusi).
    // executeTrade() akan otomatis menggunakan step & amount dari alwaysSignalLossState.

    try {
      mode.cycleNumber++;

      // ── FASE 1-3: Lakukan SEBELUM batas menit ──────────────────────────────
      // Fetch candle + analisis dikerjakan selagi candle SEKARANG masih berjalan,
      // sehingga saat batas menit tiba kita bisa langsung entry tanpa delay.

      this.logger.log(`[${userId}] === PHASE 1: Collecting candle data (pre-boundary) ===`);
      const candles = await this.collectAndAggregateCandles(config.asset!.ric, session);
      if (!candles || candles.length === 0) {
        throw new Error('Failed to collect candle data');
      }
      mode.historicalCandles = candles;

      if (!mode.isActive) return;

      this.logger.log(`[${userId}] === PHASE 2: Analyzing data with ${config.settings.type} ===`);
      const analysis = this.analyzeData(candles, config.settings);
      mode.analysisResult = analysis;
      this.logger.log(`[${userId}] Analysis Result: ${analysis.trend} (Strength: ${analysis.strength})`);

      this.logger.log(`[${userId}] === PHASE 3: Generating price predictions ===`);
      const predictions = this.generatePricePredictions(analysis, config.settings, candles);
      mode.pricePredictions = predictions;
      this.logger.log(`[${userId}] Generated ${predictions.length} predictions`);

      if (!mode.isActive) return;

      // ── FASE 4: Tunggu TEPAT di batas menit ────────────────────────────────
      this.logger.log(`[${userId}] === PHASE 4: Waiting for minute boundary ===`);
      await this.waitForMinuteBoundary();

      if (!mode.isActive) return;

      // ── FASE 5: Eksekusi LANGSUNG saat perpindahan candle ──────────────────
      // Tidak lagi memakai price monitoring / polling harga — entry dilakukan
      // persis di candle boundary menggunakan prediction dengan confidence tertinggi.
      this.logger.log(`[${userId}] === PHASE 5: Executing trade at candle boundary ===`);

      const bestPrediction = predictions[0]; // sudah diurutkan descending by confidence
      if (!bestPrediction) {
        throw new Error('No predictions available');
      }

      bestPrediction.isTriggered = true;
      bestPrediction.triggeredAt = Date.now();

      await this.executeTrade(userId, config, session, bestPrediction);

    } catch (error: any) {
      this.logger.error(`[${userId}] Error in indicator cycle: ${error.message}`);
      await this.handleCycleCompletion(userId, 'ERROR', error.message);
    }
  }

  // executeAlwaysSignalMartingale() dihapus.
  // Logika always signal sekarang di-handle langsung di executeTrade():
  // jika alwaysSignalLossState aktif, step & amount di-override otomatis,
  // sedangkan trend tetap dari sinyal indicator baru (bukan dari loss state).

  private async waitForMinuteBoundary(): Promise<void> {
    const now = Date.now();
    const ms = now % 60000; // milidetik dalam menit ini (0–59999)

    // Jika sudah sangat dekat dengan batas menit (<= 500ms sisanya), tunggu
    // offset kecil saja agar tidak lompat ke menit berikutnya.
    // Jika baru saja melewati batas (< 1000ms setelah batas), langsung lanjut.
    if (ms < 1000) {
      // Sudah berada dalam 1 detik pertama candle baru — tidak perlu tunggu
      return;
    }

    const waitTime = 60000 - ms; // ms hingga batas menit berikutnya
    await this.sleep(waitTime + MINUTE_BOUNDARY_OFFSET_MS);
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

        // Break lebih awal: 2500 5-second candles ≈ 208 menit ≥ 180 candle 1m yang dibutuhkan.
        // Old: break di 8000 → fetch data 3× lebih banyak dari yang diperlukan.
        if (fiveSecondCandles.length >= 2500) break;
      } catch (err) {
        this.logger.warn(`Error fetching candles for hour ${hoursBack}: ${err}`);
      }

      // Delay minimal hanya untuk menghindari rate-limit — old 200ms tidak perlu.
      await this.sleep(50);
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
      // Date.parse() lebih cepat daripada new Date(str).getTime() di tight loop (2500+ iter).
      const timeMs = Date.parse(candle.createdAt);
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
          // Math.max/min dengan spread operator bisa stack-overflow pada array besar.
          // reduce: O(n) tanpa alokasi tambahan.
          high: candles.reduce((max, c) => c.high > max ? c.high : max, candles[0].high),
          low:  candles.reduce((min, c) => c.low  < min ? c.low  : min, candles[0].low),
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

    // O(n) sliding window: initialise first sum in O(period), then slide in O(1) per step.
    // Old approach: candles.slice().reduce() inside loop → O(n × period) — up to ~2,300 ops
    // for 180 candles / period-14. New: ~180 ops total.
    let windowSum = 0;
    for (let i = 0; i < period; i++) windowSum += candles[i].close;
    values.push(windowSum / period);

    for (let i = period; i < candles.length; i++) {
      windowSum += candles[i].close - candles[i - period].close;
      values.push(windowSum / period);
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
    // Guard: fall back to SMA jika data kurang
    if (candles.length < period) return this.calculateSMA(candles, period);

    const values: number[] = [];
    const multiplier = 2 / (period + 1);

    // Standard EMA initialisation: seed = SMA of first N candles.
    // Old: seed = candles[0].close → EMA "dingin" butuh puluhan candle untuk konvergen.
    // New: SMA seed → konvergen langsung dari candle pertama setelah periode awal.
    let ema = candles.slice(0, period).reduce((sum, c) => sum + c.close, 0) / period;
    values.push(ema);

    for (let i = period; i < candles.length; i++) {
      ema = candles[i].close * multiplier + ema * (1 - multiplier);
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

    // Push RSI untuk candles[period] yang sebelumnya tidak ada —
    // seeding memakai candles[1..period] tapi tidak menghasilkan satu pun nilai.
    const initRs = avgLoss > 0 ? avgGain / avgLoss : 100;
    values.push(100 - 100 / (1 + initRs));

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
      // SMA/EMA: trend-following — satu prediksi sesuai arah analysis.
      // BULLISH (harga > MA) → CALL; BEARISH (harga < MA) → PUT.
      // Old: dua prediksi (put + call) dengan confidence identik → sort non-deterministik
      // → arah trade random 50% dari waktu (bug kritis untuk semua user SMA/EMA!).
      const trendDir: 'call' | 'put' = analysis.trend === 'BULLISH' ? 'call' : 'put';
      const targetPrice = trendDir === 'call'
        ? currentPrice + baseMovement
        : currentPrice - baseMovement;
      predictions.push({
        id: uuidv4(),
        targetPrice,
        predictionType: trendDir === 'call' ? 'SUPPORT_TARGET_1' : 'RESISTANCE_TARGET_1',
        recommendedTrend: trendDir,
        confidence: finalConfidence,
        isTriggered: false,
        triggeredAt: 0,
        createdAt: Date.now(),
        isDisabled: false,
      });
    }

    return predictions.sort((a, b) => b.confidence - a.confidence);
  }

  private async executeTrade(
    userId: string,
    config: IndicatorConfig,
    session: any,
    prediction: PricePrediction,
  ) {
    const mode = this.activeModes.get(userId);
    if (!mode || mode.isTradeExecuted) return;

    // Always Signal: jika ada outstanding loss, override step & amount.
    // Trend tetap dari prediction (hasil analisis indicator baru) — bukan trend lama.
    const alwaysSignalActive =
      config.martingale.isEnabled &&
      config.martingale.isAlwaysSignal &&
      mode.alwaysSignalLossState?.hasOutstandingLoss;

    const effectiveStep = alwaysSignalActive
      ? mode.alwaysSignalLossState!.currentMartingaleStep
      : 0;

    const amount = alwaysSignalActive
      ? this.calculateMartingaleAmount(config, effectiveStep)
      : config.settings.amount;

    if (alwaysSignalActive) {
      this.logger.log(
        `[${userId}] 🔄 Always Signal override: step=${effectiveStep}/${config.martingale.maxSteps} ` +
        `amount=${amount} trend=${prediction.recommendedTrend} (dari sinyal indicator baru)`
      );
    }

    mode.isTradeExecuted = true;
    mode.currentMartingaleStep = effectiveStep;
    mode.isHandlingResult = false;

    const orderId = uuidv4();

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
    // Cap ukuran indicatorOrders agar getStatus tidak return ribuan entry.
    if (mode.indicatorOrders.length > 100) mode.indicatorOrders.splice(0, mode.indicatorOrders.length - 100);

    mode.activeOrderId = orderId;
    mode.activeOrderTrend = prediction.recommendedTrend;
    mode.activeOrderAmount = amount;
    mode.activeOrderExecutedAt = Date.now();
    mode.totalExecutions++;

    this.logger.log(`[${userId}] Executing trade: ${prediction.recommendedTrend} at ${prediction.targetPrice}`);

    const tradeResult = await mode.wsClient.placeTrade(
      this.buildTradePayload(session, config, amount, prediction.recommendedTrend),
    );

    // Guard: bot bisa di-stop saat menunggu konfirmasi placeTrade (~5s).
    if (!mode.isActive) return;

    if (!tradeResult?.dealId) {
      this.logger.error(`[${userId}] Trade placement failed: ${tradeResult?.error}`);
      // Catat kegagalan agar log tidak kosong untuk trade ini.
      this.writeLog(userId, {
        id: `${orderId}_s0`,
        orderId,
        trend: prediction.recommendedTrend,
        amount,
        martingaleStep: 0,
        executedAt: Date.now(),
        result: 'FAILED',
        indicatorType: mode.analysisResult?.indicatorType ?? 'UNKNOWN',
        cycleNumber: mode.cycleNumber,
        note: `Trade placement failed: ${tradeResult?.error ?? 'unknown'}`,
        isDemoAccount: config.isDemoAccount,
      });
      mode.isTradeExecuted = false;
      mode.activeOrderId = null;
      mode.activeDealId = null;
      return;
    }

    mode.activeDealId = tradeResult.dealId;
    this.logger.log(`[${userId}] Trade placed: orderId=${orderId} dealId=${tradeResult.dealId}`);

    // Log ditulis SETELAH konfirmasi dealId — tidak ada orphan log jika placeTrade gagal.
    // Old: writeLog sebelum placeTrade → log tanpa result tersimpan permanen jika trade gagal.
    this.writeLog(userId, {
      id: `${orderId}_s0`,
      orderId,
      trend: prediction.recommendedTrend,
      amount,
      martingaleStep: 0,
      dealId: tradeResult.dealId,
      executedAt: Date.now(),
      indicatorType: mode.analysisResult?.indicatorType ?? 'UNKNOWN',
      cycleNumber: mode.cycleNumber,
      note: `${prediction.predictionType} triggered`,
      isDemoAccount: config.isDemoAccount,
    });

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
    // Re-check setelah await — stopIndicatorMode mungkin dipanggil saat getConfig/getSession berjalan.
    // Old: tanpa guard ini, martingale/log bisa dieksekusi di atas bot yang sudah di-stop.
    if (!session || !mode.isActive) return;

    const result = isWin ? 'WIN' : isDraw ? 'DRAW' : 'LOSE';
    this.logger.log(`[${userId}] Trade result: ${result} (step=${step})`);

    // Gunakan profitRate dari config asset (konsisten dengan schedule-executor.ts).
    // Old: hardcoded 0.85 → salah jika profitRate asset berbeda (e.g. 0.84, 0.92).
    const profitRate = (config.asset?.profitRate ?? 85) / 100;
    let tradePnL = 0;
    if (isWin) tradePnL = Math.floor(mode.activeOrderAmount * profitRate);
    else if (!isDraw) tradePnL = -mode.activeOrderAmount;
    mode.sessionPnL += tradePnL;

    // ── Stop Loss / Stop Profit check ─────────────────────────────────────
    if (await this.checkStopConditions(userId, mode, config)) return;

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
        // Reset restart counter on WIN agar bot tidak berhenti setelah 50 siklus campuran.
        // Old: consecutiveRestarts tidak pernah di-reset → bot pasti berhenti setelah 50 siklus.
        mode.consecutiveRestarts = 0;
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
          // Always Signal mode: catat loss, tunggu sinyal indicator berikutnya.
          // executeTrade() pada siklus berikutnya akan override step & amount secara otomatis.
          // currentTrend TIDAK disimpan — trend mengikuti sinyal indicator baru.
          const currentStep = step;
          const nextStep = currentStep + 1;
          const prevTotalLoss = mode.alwaysSignalLossState?.totalLoss ?? 0;
          const newTotalLoss = prevTotalLoss + mode.activeOrderAmount;

          if (nextStep <= config.martingale.maxSteps) {
            mode.alwaysSignalLossState = {
              hasOutstandingLoss: true,
              currentMartingaleStep: nextStep,
              originalOrderId: mode.activeOrderId!,
              totalLoss: newTotalLoss,
            };
            this.logger.log(
              `[${userId}] 📊 Always Signal: Loss recorded step=${currentStep}→${nextStep}/${config.martingale.maxSteps} ` +
              `lossAmount=${mode.activeOrderAmount} totalLoss=${newTotalLoss}`
            );
          } else {
            // Max step tercapai — reset, siklus selesai dengan LOSE
            this.logger.log(
              `[${userId}] 📊 Always Signal: Max steps (${config.martingale.maxSteps}) reached — loss state di-reset`
            );
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
    // Gunakan martingale.baseAmount (bukan settings.amount) sebagai base kalkulasi.
    // settings.amount adalah amount untuk trade normal (step 0),
    // martingale.baseAmount adalah base yang dikonfigurasi user khusus untuk martingale.
    const base = config.martingale.baseAmount;
    if (step === 0) return base;

    const multiplier = config.martingale.multiplierType === 'FIXED'
      ? config.martingale.multiplierValue
      : 1 + config.martingale.multiplierValue / 100;

    return Math.floor(base * Math.pow(multiplier, step));
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
        'authorization-token': session.stockity_token,
        'device-id': session.device_id,
        'device-type': session.device_type || 'web',
        'user-timezone': session.user_timezone || 'Asia/Jakarta',
        'User-Agent': session.user_agent,
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
      // Guard setelah await — stopIndicatorMode bisa dipanggil saat getConfig berjalan.
      if (!mode.isActive) return;

      const session = await this.authService.getSession(userId);
      if (!mode.isActive) return;

      if (session) {
        await this.sleep(500);
        if (!mode.isActive) return;
        await this.executeIndicatorCycle(userId, config, session);
      } else {
        // Old: session null → bot diam (tanpa log/stop) → status Supabase tetap RUNNING selamanya.
        this.logger.error(`[${userId}] Session expired atau tidak ditemukan — bot dihentikan otomatis`);
        await this.stopIndicatorMode(userId);
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
      const { data, error: logsError } = await this.supabaseService.client
        .from('mode_logs')
        .select('data, executed_at')
        .eq('user_id', userId)
        .eq('mode', 'INDICATOR')
        .order('executed_at', { ascending: false })
        .limit(limit);

      if (logsError || !data) return [];

      return data.map((row) => ({
        ...(row.data as IndicatorLog),
        executedAt: new Date(row.executed_at).getTime(),
      }));
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

    this.appendLogToSupabase(userId, log).catch((err) =>
      this.logger.error(`[${userId}] appendLogToSupabase error: ${err}`),
    );
  }

  private async appendLogToSupabase(userId: string, log: IndicatorLog) {
    await this.supabaseService.client
      .from('mode_logs')
      .upsert({
        id: log.id,
        user_id: userId,
        mode: 'INDICATOR',
        data: log,
        executed_at: this.supabaseService.timestampFromMillis(log.executedAt),
      }, { onConflict: 'id' });
  }

  private buildTradePayload(session: any, config: IndicatorConfig, amount: number, trend: string): any {
    const nowMs = Date.now();
    const createdAtSec = Math.floor(nowMs / 1000);

    // Hitung detik yang tersisa hingga batas menit berikutnya
    const secondsInMinute = createdAtSec % 60;
    const remainingToNextMinute = 60 - secondsInMinute;

    // Expiry SELALU di batas menit berikutnya (1 candle penuh).
    // Jika sisa < 5 detik (terlalu mepet), skip ke menit setelahnya.
    const expireAt = remainingToNextMinute >= 5
      ? createdAtSec + remainingToNextMinute
      : createdAtSec + remainingToNextMinute + 60;

    return {
      amount,
      createdAt: (createdAtSec + 1) * 1000,  // +1 detik agar tidak reject oleh server
      dealType: config.isDemoAccount ? 'demo' : 'real',
      expireAt,
      iso: session.currency_iso || config.currency || 'IDR',
      optionType: 'turbo',
      ric: config.asset!.ric,
      trend,
    };
  }

  private buildStockityHeaders(session: any): Record<string, string> {
    return {
      'authorization-token': session.stockity_token,
      'device-id': session.device_id,
      'device-type': session.device_type || 'web',
      'user-timezone': session.user_timezone || 'Asia/Jakarta',
      'User-Agent': session.user_agent,
      'Accept': 'application/json, text/plain, */*',
      'Origin': 'https://stockity.id',
      'Referer': 'https://stockity.id/',
    };
  }

  private async updateStatus(userId: string, botState: string) {
    await this.supabaseService.client.from('indicator_status').upsert(
      { user_id: userId, bot_state: botState, updated_at: this.supabaseService.now() },
    );
  }

  /**
   * Cek apakah Stop Loss atau Stop Profit telah tercapai.
   * Menghentikan bot secara otomatis jika ya.
   * @returns true jika bot dihentikan, false jika tidak
   */
  private async checkStopConditions(userId: string, mode: ActiveMode, config: IndicatorConfig): Promise<boolean> {
    const { stopLoss, stopProfit } = config.martingale;

    if (stopLoss && stopLoss > 0 && mode.sessionPnL <= -stopLoss) {
      this.logger.log(
        `[${userId}] 🛑 Stop Loss tercapai: sessionPnL=${mode.sessionPnL} ≤ -${stopLoss}. Bot dihentikan.`,
      );
      this.writeLog(userId, {
        id: `stoploss_${Date.now()}`,
        orderId: mode.activeOrderId ?? 'system',
        trend: mode.activeOrderTrend ?? '-',
        amount: 0,
        martingaleStep: mode.currentMartingaleStep,
        executedAt: Date.now(),
        note: `⛔ Stop Loss triggered: sessionPnL=${mode.sessionPnL} ≤ -${stopLoss}`,
        isDemoAccount: config.isDemoAccount,
      });
      await this.stopIndicatorMode(userId); // await agar updateStatus selesai
      return true;
    }

    if (stopProfit && stopProfit > 0 && mode.sessionPnL >= stopProfit) {
      this.logger.log(
        `[${userId}] ✅ Stop Profit tercapai: sessionPnL=${mode.sessionPnL} ≥ ${stopProfit}. Bot dihentikan.`,
      );
      this.writeLog(userId, {
        id: `stopprofit_${Date.now()}`,
        orderId: mode.activeOrderId ?? 'system',
        trend: mode.activeOrderTrend ?? '-',
        amount: 0,
        martingaleStep: mode.currentMartingaleStep,
        executedAt: Date.now(),
        note: `🎯 Stop Profit triggered: sessionPnL=${mode.sessionPnL} ≥ ${stopProfit}`,
        isDemoAccount: config.isDemoAccount,
      });
      await this.stopIndicatorMode(userId); // await agar updateStatus selesai
      return true;
    }

    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}