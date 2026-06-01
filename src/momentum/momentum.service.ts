import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { AuthService } from '../auth/auth.service';
import { StockityWebSocketClient } from '../schedule/websocket-client';
import { curlGet } from '../common/http-utils';
import { v4 as uuidv4 } from 'uuid';
import {
  MomentumType,
  MomentumSignal,
  MomentumOrder,
  MomentumMartingaleOrder,
  Candle,
  BollingerBands,
  SignalState,
  MomentumStates,
  MomentumAlwaysSignalLossState,
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

// FIX #prev-8: 'equal' was missing (StockityHistoryService uses it for draws).
const TERMINAL_STATUSES = new Set([
  'won', 'win',
  'lost', 'lose', 'loss',
  'stand', 'draw', 'tie', 'equal',
]);

// Keep processedOrderIds entries for 2 h, then auto-evict.  FIX #prev-5
const PROCESSED_IDS_MAX_AGE_MS = 2 * 60 * 60 * 1_000;

// Fallback WS match window: same 120 s as Kotlin isWebSocketTradeMatch().  FIX #new-2
const FALLBACK_MATCH_WINDOW_MS = 120_000;

// ─── Interfaces ──────────────────────────────────────────────────────────────

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
    isAlwaysSignal: boolean;
    stopLoss?: number;
    stopProfit?: number;
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

/**
 * Metadata for every live deal, keyed by the numeric dealId returned by
 * bo:opened (via placeTrade).  Used by handleWsDealResult to match
 * bo:closed events (which carry a UUID) via fallback matching.
 *
 * FIX #new-2: mirrors ScheduleExecutor's ExecutionInfo.
 */
interface DealContext {
  orderId: string;
  step: number;
  momentumType: MomentumType;
  isAlwaysSignal: boolean;
  amount: number;
  trend: string;
  placedAt: number; // ms — for the 120-s fallback window
}

interface ActiveModeState {
  isRunning: boolean;
  wsClient: StockityWebSocketClient;
  /** Stored at start so the WS path can trigger martingale continuation.  FIX #prev-10 */
  session: any;
  candleStorage: Candle[];
  /** O(1) lookup by orderId.  FIX #prev-4 (was array with linear find) */
  momentumOrders: Map<string, MomentumOrder>;
  activeMartingaleOrders: Map<string, MomentumMartingaleOrder>;
  activeMomentumOrders: Map<string, {
    momentumType: MomentumType;
    orderId: string;
    trend: string;
    executedTime: number;
  }>;
  momentumStates: MomentumStates;
  totalExecutions: number;
  totalWins: number;
  totalLosses: number;
  sessionPnL: number;
  candleFetchInterval?: NodeJS.Timeout;
  /** Map<processKey, insertTimestamp> — auto-evicted after 2 h.  FIX #prev-5 */
  processedOrderIds: Map<string, number>;
  logs: MomentumLog[];
  alwaysSignalLossState: MomentumAlwaysSignalLossState | null;
  /**
   * Live deals keyed by numeric dealId (from bo:opened).
   * Enables O(1) exact match + amount/trend/time fallback in handleWsDealResult.
   * FIX #new-2
   */
  activeDeals: Map<string, DealContext>;
  /**
   * Per-type execution guard.  Prevents concurrent execution of the same
   * momentum type when analyzeAllMomentums fires while a trade is still async.
   * FIX #new-1
   */
  executingOrderTypes: Set<string>;
  /**
   * Prevents overlapping analyzeAllMomentums calls when a candle fetch is
   * slow and the recursive setTimeout fires before analysis finishes.
   * FIX #new-7
   */
  analysisInProgress: boolean;
}

@Injectable()
export class MomentumService implements OnModuleDestroy {
  private readonly logger = new Logger(MomentumService.name);
  private configs = new Map<string, MomentumConfig>();
  private activeModes = new Map<string, ActiveModeState>();

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly authService: AuthService,
  ) {}

  onModuleDestroy() {
    for (const [userId] of this.activeModes) {
      this.stopMomentumMode(userId);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CONFIG
  // ─────────────────────────────────────────────────────────────────────────

  async getConfig(userId: string): Promise<MomentumConfig> {
    if (this.configs.has(userId)) return this.configs.get(userId)!;

    const { data, error } = await this.supabaseService.client
      .from('momentum_configs')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (!error && data) {
      const cfg: MomentumConfig = {
        asset: data.asset || null,
        enabledMomentums: data.enabled_momentums || {
          candleSabit: true, dojiTerjepit: true, dojiPembatalan: true, bbSarBreak: true,
        },
        martingale: data.martingale || {
          isEnabled: true, maxSteps: 2, baseAmount: 1400000,
          multiplierValue: 2.5, multiplierType: 'FIXED',
          isAlwaysSignal: false, stopLoss: 0, stopProfit: 0,
        },
        isDemoAccount: data.is_demo_account ?? true,
        currency: data.currency || 'IDR',
      };
      this.configs.set(userId, cfg);
      return cfg;
    }

    const def: MomentumConfig = {
      asset: null,
      enabledMomentums: {
        candleSabit: true, dojiTerjepit: true, dojiPembatalan: true, bbSarBreak: true,
      },
      martingale: {
        isEnabled: true, maxSteps: 2, baseAmount: 1400000,
        multiplierValue: 2.5, multiplierType: 'FIXED',
        isAlwaysSignal: false, stopLoss: 0, stopProfit: 0,
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

    const { error } = await this.supabaseService.client
      .from('momentum_configs')
      .upsert({
        user_id: userId,
        asset: updated.asset,
        enabled_momentums: updated.enabledMomentums,
        martingale: updated.martingale,
        is_demo_account: updated.isDemoAccount,
        currency: updated.currency,
        updated_at: this.supabaseService.now(),
      });

    if (error) this.logger.error(`[${userId}] updateConfig error: ${error.message}`);
    return updated;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // START / STOP
  // ─────────────────────────────────────────────────────────────────────────

  async startMomentumMode(userId: string): Promise<{ message: string; status: string }> {
    const existing = this.activeModes.get(userId);
    if (existing?.isRunning) {
      return { message: 'Momentum mode sudah berjalan', status: 'RUNNING' };
    }

    const session = await this.authService.getSession(userId);
    if (!session) throw new Error('Session tidak ditemukan');

    const config = await this.getConfig(userId);
    if (!config.asset?.ric) throw new Error('Asset belum dikonfigurasi');

    const ws = new StockityWebSocketClient(
      userId,
      session.stockity_token,
      session.device_id,
      session.device_type || 'web',
      session.user_agent,
    );

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
      candleSabit:    this.createSignalState(),
      dojiTerjepit:   this.createSignalState(),
      dojiPembatalan: this.createSignalState(),
      bbSarBreak:     this.createSignalState(),
    };

    this.activeModes.set(userId, {
      isRunning: true,
      wsClient: ws,
      session,                       // FIX #prev-10
      candleStorage: [],
      momentumOrders: new Map(),     // FIX #prev-4
      activeMartingaleOrders: new Map(),
      activeMomentumOrders: new Map(),
      momentumStates: initialStates,
      totalExecutions: 0,
      totalWins: 0,
      totalLosses: 0,
      sessionPnL: 0,
      processedOrderIds: new Map(),  // FIX #prev-5
      logs: [],
      alwaysSignalLossState: null,
      activeDeals: new Map(),        // FIX #new-2
      executingOrderTypes: new Set(), // FIX #new-1
      analysisInProgress: false,     // FIX #new-7
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
    if (mode.candleFetchInterval) clearInterval(mode.candleFetchInterval);
    mode.wsClient.disconnect();
    this.activeModes.delete(userId);

    await this.updateStatus(userId, 'STOPPED');
    this.logger.log(`[${userId}] Momentum mode stopped`);
    return { message: 'Momentum mode dihentikan' };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STATUS
  // ─────────────────────────────────────────────────────────────────────────

  async getStatus(userId: string): Promise<object> {
    const mode   = this.activeModes.get(userId);
    const config = await this.getConfig(userId);

    if (mode) {
      return {
        isRunning: mode.isRunning,
        botState: mode.isRunning ? 'RUNNING' : 'STOPPED',
        totalExecutions: mode.totalExecutions,
        totalWins: mode.totalWins,
        totalLosses: mode.totalLosses,
        totalTrades: mode.totalExecutions,
        sessionPnL: mode.sessionPnL,
        wsConnected: mode.wsClient.isConnected(),
        candleStorageCount: mode.candleStorage.length,
        activeMartingaleCount: mode.activeMartingaleOrders.size,
        activeLiveDeals: mode.activeDeals.size,
        alwaysSignalStatus: this.getAlwaysSignalStatus(mode, config),
        lastStatus: `Candles: ${mode.candleStorage.length} | Executions: ${mode.totalExecutions}`,
        config,
      };
    }

    const { data } = await this.supabaseService.client
      .from('momentum_status')
      .select('bot_state')
      .eq('user_id', userId)
      .single();

    return {
      isRunning: false,
      botState: data?.bot_state ?? 'STOPPED',
      totalExecutions: 0, totalWins: 0, totalLosses: 0, totalTrades: 0,
      sessionPnL: 0,
      config,
    };
  }

  private getAlwaysSignalStatus(mode: ActiveModeState, config: MomentumConfig): object {
    const lossState = mode.alwaysSignalLossState;
    if (!config.martingale.isAlwaysSignal || !lossState?.hasOutstandingLoss) {
      return { isActive: false, status: 'No outstanding loss' };
    }
    return {
      isActive: true,
      currentStep: lossState.currentMartingaleStep,
      maxSteps: config.martingale.maxSteps,
      totalLoss: lossState.totalLoss,
      momentumType: lossState.momentumType,
      status: `Waiting for next signal (Step ${lossState.currentMartingaleStep}/${config.martingale.maxSteps})`,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LOGS
  // ─────────────────────────────────────────────────────────────────────────

  async getLogs(userId: string, limit = 100): Promise<MomentumLog[]> {
    const mode = this.activeModes.get(userId);
    if (mode && mode.logs.length > 0) return mode.logs.slice(-limit);

    try {
      const { data, error } = await this.supabaseService.client
        .from('mode_logs')
        .select('*')
        .eq('user_id', userId)
        .eq('mode', 'momentum')
        .order('executed_at', { ascending: false })
        .limit(limit);

      if (error) throw error;
      return (data ?? []).map((row) => ({
        ...(row.data as object),
        id: row.id,
        executedAt: row.executed_at ? new Date(row.executed_at).getTime() : 0,
      })) as MomentumLog[];
    } catch (err: any) {
      this.logger.error(`[${userId}] getLogs error: ${err.message}`);
      return [];
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CANDLE STORAGE LOOP
  // ─────────────────────────────────────────────────────────────────────────

  private startCandleStorageLoop(userId: string, config: MomentumConfig, session: any) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    const runCycle = async () => {
      if (!mode.isRunning) return;

      try {
        const now = Date.now();
        const waitTime = this.calculateNextMinuteStart(now) - now;
        if (waitTime > 0) await this.sleep(waitTime);
        if (!mode.isRunning) return;

        await this.sleep(FETCH_5SEC_OFFSET);

        const newCandle = await this.fetchAndAggregateOneMinuteCandle(config.asset!.ric, session);

        if (newCandle) {
          this.addCandleToStorage(userId, newCandle);

          // FIX #new-7: skip analysis if a previous cycle is still running
          if (mode.candleStorage.length >= 2 && !mode.analysisInProgress) {
            mode.analysisInProgress = true;
            try {
              await this.analyzeAllMomentums(userId, config, session);
            } finally {
              mode.analysisInProgress = false;
            }
          } else if (mode.analysisInProgress) {
            this.logger.warn(`[${userId}] Analysis skipped — previous cycle still running`);
          }
        }

        // FIX #prev-5: periodic cleanup of stale processedOrderIds
        this.evictExpiredProcessedIds(mode);
        // FIX #new-2: periodic cleanup of stale activeDeals (> 3 min)
        this.evictExpiredActiveDeals(mode);
      } catch (err) {
        this.logger.error(`[${userId}] Error in candle storage loop: ${err}`);
      }

      if (mode.isRunning) setTimeout(() => runCycle(), 1_000);
    };

    runCycle();
  }

  private evictExpiredProcessedIds(mode: ActiveModeState): void {
    const cutoff = Date.now() - PROCESSED_IDS_MAX_AGE_MS;
    for (const [key, ts] of mode.processedOrderIds) {
      if (ts < cutoff) mode.processedOrderIds.delete(key);
    }
  }

  /** FIX #new-2: evict stale activeDeals after 3 × FALLBACK_MATCH_WINDOW_MS. */
  private evictExpiredActiveDeals(mode: ActiveModeState): void {
    const cutoff = Date.now() - FALLBACK_MATCH_WINDOW_MS * 3;
    for (const [dealId, ctx] of mode.activeDeals) {
      if (ctx.placedAt < cutoff) {
        this.logger.warn(`[mode] Evicting stale activeDeals entry: ${ctx.momentumType} step=${ctx.step} orderId=${ctx.orderId}`);
        mode.activeDeals.delete(dealId);
      }
    }
  }

  /** FIX #prev-10 (minor): simplified to one modulo expression. */
  private calculateNextMinuteStart(serverTime: number): number {
    return serverTime - (serverTime % 60_000) + 60_000;
  }

  private async fetchAndAggregateOneMinuteCandle(symbol: string, session: any): Promise<Candle | null> {
    try {
      const encodedSymbol = symbol.replace('/', '%2F');
      const dateForApi = new Date().toISOString().slice(0, 13) + ':00:00';

      const response = await curlGet(
        `${BASE_URL}/candles/v1/${encodedSymbol}/${dateForApi}/5`,
        this.buildStockityHeaders(session),
        5,
      );

      if (response.data?.data) {
        const candles5Sec = response.data.data
          .map((d: any) => this.parseCandleData(d))
          .filter((c: Candle | null): c is Candle => c !== null);

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
      const candle: Candle = {
        open: parseFloat(data.open),
        close: parseFloat(data.close),
        high: parseFloat(data.high),
        low: parseFloat(data.low),
        createdAt: data.created_at,
      };
      return (candle.open > 0 && candle.close > 0) ? candle : null;
    } catch {
      return null;
    }
  }

  /** FIX #prev-9: loop instead of spread-based Math.max/min. */
  private aggregateCandlesToOneMinute(candles5Sec: Candle[]): Candle | null {
    if (candles5Sec.length === 0) return null;

    let high = candles5Sec[0].high;
    let low  = candles5Sec[0].low;
    for (let i = 1; i < candles5Sec.length; i++) {
      if (candles5Sec[i].high > high) high = candles5Sec[i].high;
      if (candles5Sec[i].low  < low)  low  = candles5Sec[i].low;
    }

    return {
      open:      candles5Sec[0].open,
      close:     candles5Sec[candles5Sec.length - 1].close,
      high,
      low,
      createdAt: candles5Sec[candles5Sec.length - 1].createdAt,
    };
  }

  /** FIX #prev-8: skip if the last stored candle has the same createdAt. */
  private addCandleToStorage(userId: string, candle: Candle) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    const last = mode.candleStorage[mode.candleStorage.length - 1];
    if (last?.createdAt === candle.createdAt) {
      this.logger.debug(`[${userId}] Duplicate candle skipped (createdAt=${candle.createdAt})`);
      return;
    }

    mode.candleStorage.push(candle);
    if (mode.candleStorage.length > MAX_CANDLES_STORAGE) mode.candleStorage.shift();
    this.logger.debug(`[${userId}] Candle added. Storage: ${mode.candleStorage.length}/${MAX_CANDLES_STORAGE}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MOMENTUM ANALYSIS
  // ─────────────────────────────────────────────────────────────────────────

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

    for (const signal of signals) {
      await this.executeMomentumOrder(userId, config, session, signal);
    }
  }

  private analyzeCandleSabit(candles: Candle[], state: SignalState): MomentumSignal | null {
    if (candles.length < 4) return null;
    const last4  = candles.slice(-4);
    const trend2 = this.getCandleTrend(last4[1]);
    const trend3 = this.getCandleTrend(last4[2]);
    const trend4 = this.getCandleTrend(last4[3]);
    if (trend2 !== trend3 || trend3 !== trend4) return null;

    const body2 = Math.abs(last4[1].close - last4[1].open);
    const body3 = Math.abs(last4[2].close - last4[2].open);
    const body4 = Math.abs(last4[3].close - last4[3].open);
    if (!(body2 < body3 && body3 < body4)) return null;

    const signalTrend  = trend2 === 'buy' ? 'call' : 'put';
    const currentPrice = last4[3].close;
    const currentTime  = Date.now();
    if (!this.shouldAllowSignal(state, signalTrend, currentPrice, currentTime)) return null;
    this.recordSignal(state, signalTrend, currentPrice, currentTime);

    return {
      momentumType: MomentumType.CANDLE_SABIT,
      trend: signalTrend,
      confidence: this.calculateConfidence(body2, body3, body4),
      details: 'Candle Sabit: 4 candles increasing body size',
    };
  }

  private analyzeDojiTerjepit(candles: Candle[], state: SignalState): MomentumSignal | null {
    if (candles.length < 4) return null;
    const last4  = candles.slice(-4);
    const trend1 = this.getCandleTrend(last4[0]);
    const trend2 = this.getCandleTrend(last4[1]);
    const trend3 = this.getCandleTrend(last4[2]);
    if (trend1 !== trend2 || trend2 !== trend3) return null;

    const b1 = this.calculateBodyPercentage(last4[0]);
    const b2 = this.calculateBodyPercentage(last4[1]);
    const b3 = this.calculateBodyPercentage(last4[2]);
    const b4 = this.calculateBodyPercentage(last4[3]);
    if (!(b1 > 60 && b2 > 60 && b3 > 60 && b4 < 10)) return null;

    const trend4 = this.getCandleTrend(last4[3]);
    let signalTrend: string;
    if (trend1 === 'buy' && trend4 === 'sell')       signalTrend = 'put';
    else if (trend1 === 'sell' && trend4 === 'buy')  signalTrend = 'call';
    else                                             return null;

    const currentPrice = last4[3].close;
    const currentTime  = Date.now();
    if (!this.shouldAllowSignal(state, signalTrend, currentPrice, currentTime)) return null;
    this.recordSignal(state, signalTrend, currentPrice, currentTime);

    return {
      momentumType: MomentumType.DOJI_TERJEPIT,
      trend: signalTrend,
      confidence: 0.8,
      details: 'Doji Terjepit: 3 long candles + 1 doji reversal hint',
    };
  }

  private analyzeDojiPembatalan(candles: Candle[], state: SignalState): MomentumSignal | null {
    if (candles.length < 2) return null;
    const last2    = candles.slice(-2);
    const previous = last2[0];
    const current  = last2[1];
    if (this.calculateBodyPercentage(current) >= 10) return null;

    const prevTrend = this.getCandleTrend(previous);
    const dojiTrend = this.getCandleTrend(current);
    let signalTrend: string;
    if (prevTrend === 'sell' && dojiTrend === 'buy')      signalTrend = 'call';
    else if (prevTrend === 'buy' && dojiTrend === 'sell') signalTrend = 'put';
    else                                                  return null;

    const currentPrice = current.close;
    const currentTime  = Date.now();
    if (!this.shouldAllowSignal(state, signalTrend, currentPrice, currentTime)) return null;
    this.recordSignal(state, signalTrend, currentPrice, currentTime);

    return {
      momentumType: MomentumType.DOJI_PEMBATALAN,
      trend: signalTrend,
      confidence: 0.75,
      details: 'Doji Pembatalan: Reversal detected',
    };
  }

  private analyzeBBSARBreak(candles: Candle[], state: SignalState): MomentumSignal | null {
    if (candles.length < MIN_CANDLES_FOR_BB_SAR) return null;
    const lastCandle = candles[candles.length - 1];
    const closePrice = lastCandle.close;
    const bb  = this.calculateBollingerBands(candles, 20, 2);
    const sar = this.calculateParabolicSAR(candles);
    if (!bb) return null;

    let currentSignal: string;
    if      (closePrice > bb.upper && closePrice > sar) currentSignal = 'call';
    else if (closePrice < bb.lower && closePrice < sar) currentSignal = 'put';
    else                                                return null;

    const currentTime = Date.now();
    if (!this.shouldAllowSignal(state, currentSignal, closePrice, currentTime)) return null;
    this.recordSignal(state, currentSignal, closePrice, currentTime);

    return {
      momentumType: MomentumType.BB_SAR_BREAK,
      trend: currentSignal,
      confidence: 0.85,
      details: 'BB/SAR Break: Strong trend with filters passed',
    };
  }

  // ─── Signal helpers ───────────────────────────────────────────────────────

  private createSignalState(): SignalState {
    return { lastSignal: null, lastSignalTime: 0, lastPrice: null, consecutiveSignals: 0, signalHistory: [], isOrderActive: false };
  }

  private shouldAllowSignal(state: SignalState, currentSignal: string, currentPrice: number, currentTime: number): boolean {
    if (currentSignal === state.lastSignal) {
      if (currentTime - state.lastSignalTime < SIGNAL_COOLDOWN_MS) return false;
      if (state.lastPrice !== null) {
        const priceChange = Math.abs((currentPrice - state.lastPrice) / state.lastPrice);
        if (priceChange < PRICE_MOVE_THRESHOLD) return false;
      }
    }
    this.cleanupOldSignals(state, currentTime);
    return state.signalHistory.length < MAX_SIGNALS_PER_HOUR;
  }

  private recordSignal(state: SignalState, signal: string, price: number, time: number) {
    state.lastSignal = signal; state.lastSignalTime = time;
    state.lastPrice  = price;  state.consecutiveSignals++;
    state.signalHistory.push(time);
  }

  private cleanupOldSignals(state: SignalState, currentTime: number) {
    state.signalHistory = state.signalHistory.filter((t) => currentTime - t <= SIGNAL_HISTORY_CLEANUP_MS);
  }

  private getCandleTrend(candle: Candle): string {
    return candle.close > candle.open ? 'buy' : 'sell';
  }

  private calculateBodyPercentage(candle: Candle): number {
    const range = Math.abs(candle.high - candle.low);
    if (range === 0) return 0;
    return (Math.abs(candle.close - candle.open) / range) * 100;
  }

  private calculateConfidence(body2: number, body3: number, body4: number): number {
    if (body2 === 0 || body3 === 0) return 0.5;
    return Math.min(0.9, 0.5 + (body3 / body2 + body4 / body3) * 0.1);
  }

  private calculateBollingerBands(candles: Candle[], period: number, stdDevMultiplier: number): BollingerBands | null {
    if (candles.length < period) return null;
    const closes = candles.slice(-period).map((c) => c.close);
    const sma      = closes.reduce((a, b) => a + b, 0) / period;
    const variance = closes.reduce((acc, val) => acc + Math.pow(val - sma, 2), 0) / period;
    const stdDev   = Math.sqrt(variance);
    return { upper: sma + stdDev * stdDevMultiplier, middle: sma, lower: sma - stdDev * stdDevMultiplier };
  }

  /**
   * FIX #prev-7 — Proper iterative Parabolic SAR (Wilder's algorithm).
   * The original was a 2-candle heuristic with no AF/EP — produced incorrect signals.
   * AF_start=0.02, AF_step=0.02, AF_max=0.20.
   */
  private calculateParabolicSAR(candles: Candle[]): number {
    if (candles.length < 5) return candles[candles.length - 1].close;

    const AF_START = 0.02, AF_STEP = 0.02, AF_MAX = 0.20;
    let isUptrend = candles[1].close > candles[0].close;
    let sar = isUptrend ? candles[0].low  : candles[0].high;
    let ep  = isUptrend ? candles[0].high : candles[0].low;
    let af  = AF_START;

    for (let i = 1; i < candles.length; i++) {
      const prev            = candles[i - 1];
      const curr            = candles[i];
      const twoAgoLow       = i >= 2 ? candles[i - 2].low  : prev.low;
      const twoAgoHigh      = i >= 2 ? candles[i - 2].high : prev.high;

      if (isUptrend) {
        const newSar = Math.min(sar + af * (ep - sar), prev.low, twoAgoLow);
        if (curr.low < newSar) { isUptrend = false; sar = ep; ep = curr.low; af = AF_START; }
        else { sar = newSar; if (curr.high > ep) { ep = curr.high; af = Math.min(af + AF_STEP, AF_MAX); } }
      } else {
        const newSar = Math.max(sar + af * (ep - sar), prev.high, twoAgoHigh);
        if (curr.high > newSar) { isUptrend = true; sar = ep; ep = curr.high; af = AF_START; }
        else { sar = newSar; if (curr.low < ep) { ep = curr.low; af = Math.min(af + AF_STEP, AF_MAX); } }
      }
    }
    return sar;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ORDER EXECUTION
  // ─────────────────────────────────────────────────────────────────────────

  private async executeMomentumOrder(
    userId: string,
    config: MomentumConfig,
    session: any,
    signal: MomentumSignal,
  ) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    if (config.martingale.isAlwaysSignal && mode.alwaysSignalLossState?.hasOutstandingLoss) {
      await this.executeAlwaysSignalMartingale(userId, config, session, signal);
      return;
    }

    if (mode.activeMartingaleOrders.size > 0 && !config.martingale.isAlwaysSignal) {
      this.logger.log(`[${userId}] Signal skipped — Standard Martingale active`);
      return;
    }

    if (mode.activeMomentumOrders.has(signal.momentumType)) {
      this.logger.warn(`[${userId}] Duplicate prevented: ${signal.momentumType} already active`);
      return;
    }

    // FIX #new-1: re-entrant guard — prevents concurrent execution of the same type
    if (mode.executingOrderTypes.has(signal.momentumType)) {
      this.logger.warn(`[${userId}] Re-entrant blocked: ${signal.momentumType} still executing`);
      return;
    }
    mode.executingOrderTypes.add(signal.momentumType);

    try {
      const orderId     = uuidv4();
      const currentTime = Date.now();
      const amount      = config.martingale.baseAmount;

      const order: MomentumOrder = {
        id: orderId,
        assetRic:      config.asset!.ric,
        assetName:     config.asset!.name,
        trend:         signal.trend,
        amount,
        executionTime: currentTime,
        momentumType:  signal.momentumType,
        confidence:    signal.confidence,
        sourceCandle:  mode.candleStorage[mode.candleStorage.length - 1],
        isExecuted:    true,
        isSkipped:     false,
        martingaleState: { isActive: false, currentStep: 0, isCompleted: false, totalLoss: 0, totalRecovered: 0 },
      };

      mode.momentumOrders.set(orderId, order);   // FIX #prev-4
      mode.activeMomentumOrders.set(signal.momentumType, {
        momentumType:  signal.momentumType,
        orderId,
        trend:         signal.trend,
        executedTime:  currentTime,
      });
      mode.totalExecutions++;

      this.logger.log(`[${userId}] Executing ${signal.momentumType}: ${signal.trend} amount=${amount}`);

      const execLog: MomentumLog = {
        id: orderId, orderId,
        momentumType: signal.momentumType,
        trend: signal.trend, amount,
        martingaleStep: 0,
        executedAt: currentTime,
        note: `${signal.momentumType} signal | ${signal.details}`,
      };
      this.appendLog(userId, execLog);

      const tradeResult = await mode.wsClient.placeTrade(
        this.buildTradePayload(session, config, amount, signal.trend),
      );

      // FIX #new-3: stop the bot immediately on amount_min (same as ScheduleExecutor)
      if (tradeResult.error === 'amount_min') {
        this.logger.error(`[${userId}] ❌ Amount di bawah minimum Stockity — bot dihentikan`);
        this.updateLog(userId, orderId, { result: 'FAILED', note: 'Amount di bawah minimum Stockity' });
        mode.activeMomentumOrders.delete(signal.momentumType);
        mode.momentumOrders.delete(orderId);
        this.stopMomentumMode(userId);
        return;
      }

      if (tradeResult?.dealId) {
        this.updateLog(userId, orderId, { dealId: tradeResult.dealId });
        // FIX #new-2: register deal for WS matching
        mode.activeDeals.set(tradeResult.dealId, {
          orderId, step: 0,
          momentumType: signal.momentumType,
          isAlwaysSignal: false,
          amount, trend: signal.trend,
          placedAt: Date.now(),
        });
      }

      // Polling fallback — WS is the primary result path
      this.monitorResult(userId, config, session, orderId, 0, signal.momentumType, false);

    } finally {
      mode.executingOrderTypes.delete(signal.momentumType); // FIX #new-1
    }
  }

  private async executeAlwaysSignalMartingale(
    userId: string,
    config: MomentumConfig,
    session: any,
    signal: MomentumSignal,
  ) {
    const mode = this.activeModes.get(userId);
    if (!mode || !mode.alwaysSignalLossState) return;

    const lossState = mode.alwaysSignalLossState;
    const step      = lossState.currentMartingaleStep;

    if (step > config.martingale.maxSteps) {
      this.logger.log(`[${userId}] 📊 AlwaysSignal: max steps reached — loss state reset`);
      mode.alwaysSignalLossState = null;
      return;
    }

    // FIX #new-1: re-entrant guard for always-signal type
    const lockKey = `as_${lossState.momentumType}`;
    if (mode.executingOrderTypes.has(lockKey)) {
      this.logger.warn(`[${userId}] AlwaysSignal re-entrant blocked`);
      return;
    }
    mode.executingOrderTypes.add(lockKey);

    try {
      const amount = this.calculateMartingaleAmount(config, step);
      const trend  = signal.trend; // follow NEW signal direction

      this.logger.log(
        `[${userId}] 🔄 AlwaysSignal step ${step}/${config.martingale.maxSteps} ` +
        `trend=${trend} signal=${signal.momentumType} amount=${amount}`,
      );

      const orderId     = uuidv4();
      const currentTime = Date.now();

      const execLog: MomentumLog = {
        id: orderId, orderId,
        momentumType: lossState.momentumType,
        trend, amount, martingaleStep: step,
        executedAt: currentTime,
        note: `Always Signal Martingale step ${step}/${config.martingale.maxSteps} | signal=${signal.momentumType}`,
      };
      this.appendLog(userId, execLog);

      const tradeResult = await mode.wsClient.placeTrade(
        this.buildTradePayload(session, config, amount, trend),
      );

      // FIX #new-3: amount_min on always-signal step
      if (tradeResult.error === 'amount_min') {
        this.logger.error(`[${userId}] ❌ AlwaysSignal amount_min — bot dihentikan`);
        this.updateLog(userId, orderId, { result: 'FAILED', note: 'Amount di bawah minimum Stockity' }, step);
        mode.alwaysSignalLossState = null;
        this.stopMomentumMode(userId);
        return;
      }

      if (tradeResult?.dealId) {
        this.updateLog(userId, orderId, { dealId: tradeResult.dealId }, step);
        mode.activeDeals.set(tradeResult.dealId, {
          orderId, step,
          momentumType: lossState.momentumType,
          isAlwaysSignal: true,
          amount, trend,
          placedAt: Date.now(),
        });
      }

      this.monitorResult(userId, config, session, orderId, step, lossState.momentumType, true);

    } finally {
      mode.executingOrderTypes.delete(lockKey);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // UNIFIED RESULT MONITOR  — FIX #prev-6: replaces 3 duplicate functions
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Polling fallback — fires only when WS hasn't resolved the order yet.
   * Interval raised to 3 s (was 2 s) since WS handles the fast path.
   * FIX #new-5: on timeout, marks order as FAILED instead of silently dropping.
   */
  private monitorResult(
    userId: string,
    config: MomentumConfig,
    session: any,
    orderId: string,
    step: number,
    momentumType: MomentumType,
    isAlwaysSignal: boolean,
  ): void {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    const maxWaitMs  = 90_000;
    const startTime  = Date.now();
    const processKey = `${orderId}_s${step}`; // unified key — same as resolveOrderResult

    const checkInterval = setInterval(async () => {
      if (!mode.isRunning) { clearInterval(checkInterval); return; }

      // FIX #new-5: explicit stuck detection with FAILED logging
      if (Date.now() - startTime > maxWaitMs) {
        clearInterval(checkInterval);
        if (mode.processedOrderIds.has(processKey)) return; // WS already resolved
        this.logger.error(`[${userId}] ⏰ Monitor timeout: ${momentumType} step=${step} orderId=${orderId}`);
        this.updateLog(userId, orderId, { result: 'FAILED', note: 'Monitor timeout (90 s) — no result received' }, step);
        mode.activeMomentumOrders.delete(momentumType);
        mode.activeMartingaleOrders.delete(orderId);
        // clean up activeDeals for this order
        for (const [dealId, ctx] of mode.activeDeals) {
          if (ctx.orderId === orderId && ctx.step === step) { mode.activeDeals.delete(dealId); break; }
        }
        return;
      }

      if (mode.processedOrderIds.has(processKey)) { clearInterval(checkInterval); return; }

      try {
        const result = await this.fetchTradeResult(session, config);
        if (result) {
          clearInterval(checkInterval);
          await this.resolveOrderResult(userId, config, orderId, step, momentumType, isAlwaysSignal, result);
        }
      } catch (err) {
        this.logger.error(`[${userId}] monitorResult error step=${step}: ${err}`);
      }
    }, 3_000);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // WS DEAL RESULT HANDLER — FIX #prev-2 + FIX #new-2
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Handles bo:closed / deal_result / close_deal_batch from WebSocket.
   *
   * 3-layer matching (mirrors ScheduleExecutor):
   *   1. Exact numeric dealId (stored at placeTrade → bo:opened)
   *   2. Fallback: amount + trend + 120 s time window  ← FIX #new-2
   *      (needed because Stockity uses numeric ID for bo:opened but UUID for bo:closed)
   *
   * FIX #prev-2: now calls resolveOrderResult() for full processing,
   * including martingale continuation.
   */
  private async handleWsDealResult(userId: string, payload: any) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    const status = (payload.status || payload.result || '').toLowerCase();
    if (!TERMINAL_STATUSES.has(status)) return;

    const incomingId = String(payload.id ?? '');
    if (!incomingId) return;

    const config = this.configs.get(userId);
    if (!config) return;

    // ── Layer 1: exact numeric dealId ────────────────────────────────────
    let context   = mode.activeDeals.get(incomingId);
    let matchedId = incomingId;

    // ── Layer 2: amount + trend + 120 s time window ───────────────────────
    if (!context) {
      const now = Date.now();
      for (const [dealId, ctx] of mode.activeDeals) {
        if (now - ctx.placedAt > FALLBACK_MATCH_WINDOW_MS) continue;
        if (payload.amount !== undefined && ctx.amount !== payload.amount) continue;
        if (payload.trend  && ctx.trend  !== payload.trend)               continue;
        context   = ctx;
        matchedId = dealId;
        this.logger.warn(
          `[${userId}] WS fallback match: ${ctx.momentumType} step=${ctx.step} ` +
          `by amount=${payload.amount} trend=${payload.trend} (incomingId=${incomingId})`,
        );
        break;
      }
    }

    if (!context) {
      this.logger.debug(`[${userId}] WS result unmatched: id=${incomingId} amount=${payload.amount} trend=${payload.trend}`);
      return;
    }

    mode.activeDeals.delete(matchedId);

    await this.resolveOrderResult(
      userId, config,
      context.orderId, context.step, context.momentumType, context.isAlwaysSignal,
      { status, win: payload.win, payment: payload.payment },
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // UNIFIED RESULT RESOLVER — FIX #prev-1 #prev-2 #prev-3
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Single source of truth for processing any completed trade.
   * Called by both handleWsDealResult() and monitorResult().
   * Idempotent via processedOrderIds Map.
   *
   * FIX #prev-3: DRAW → profit = 0, no martingale trigger.
   * FIX #prev-10: uses mode.session for martingale from WS path.
   */
  private async resolveOrderResult(
    userId: string,
    config: MomentumConfig,
    orderId: string,
    step: number,
    momentumType: MomentumType,
    isAlwaysSignal: boolean,
    rawResult: { status: string; win?: number; payment?: number },
  ): Promise<void> {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    const processKey = `${orderId}_s${step}`;
    if (mode.processedOrderIds.has(processKey)) return;
    mode.processedOrderIds.set(processKey, Date.now());

    // Also clean up any still-live activeDeals entry for this order+step
    for (const [dealId, ctx] of mode.activeDeals) {
      if (ctx.orderId === orderId && ctx.step === step) { mode.activeDeals.delete(dealId); break; }
    }

    const statusLower = rawResult.status.toLowerCase();
    const isWin  = statusLower === 'won'  || statusLower === 'win';
    // FIX #prev-3 + #prev-8 (equal)
    const isDraw = statusLower === 'stand' || statusLower === 'draw' ||
                   statusLower === 'equal' || statusLower === 'tie';

    const amount = step === 0
      ? config.martingale.baseAmount
      : this.calculateMartingaleAmount(config, step);

    const profit = isWin  ? (rawResult.win ?? rawResult.payment ?? 0)
                 : isDraw ? 0        // FIX #prev-3: stake returned on DRAW
                 :          -amount;

    mode.sessionPnL += profit;

    const resultStr = isWin ? 'WIN' : isDraw ? 'DRAW' : 'LOSE';
    this.updateLog(userId, orderId, { result: resultStr, profit, sessionPnL: mode.sessionPnL }, step);

    this.logger.log(
      `[${userId}] ${momentumType} step=${step} ${resultStr} profit=${profit} ` +
      `sessionPnL=${mode.sessionPnL}${isAlwaysSignal ? ' [AlwaysSignal]' : ''}`,
    );

    if (this.checkStopConditions(userId, mode, config)) return;

    // ── WIN or DRAW ───────────────────────────────────────────────────────
    if (isWin || isDraw) {
      if (isWin) mode.totalWins++;
      if (isAlwaysSignal) {
        mode.alwaysSignalLossState = null;
      } else {
        mode.activeMomentumOrders.delete(momentumType);
        mode.activeMartingaleOrders.delete(orderId);
      }
      return;
    }

    // ── LOSE ─────────────────────────────────────────────────────────────

    if (isAlwaysSignal) {
      const prev        = mode.alwaysSignalLossState;
      const newTotalLoss = (prev?.totalLoss ?? 0) + amount;
      if (step >= config.martingale.maxSteps) {
        mode.totalLosses++;
        mode.alwaysSignalLossState = null;
        this.logger.log(`[${userId}] 📊 AlwaysSignal: max steps reached — loss state reset`);
      } else {
        mode.alwaysSignalLossState = {
          hasOutstandingLoss: true,
          currentMartingaleStep: step + 1,
          originalOrderId: prev?.originalOrderId ?? orderId,
          totalLoss: newTotalLoss,
          momentumType,
        };
        this.logger.log(`[${userId}] 📊 AlwaysSignal LOSE step ${step}→${step + 1}/${config.martingale.maxSteps} totalLoss=${newTotalLoss}`);
      }
      mode.activeMomentumOrders.delete(momentumType);
      return;
    }

    if (step === 0) {
      if (config.martingale.isEnabled) {
        // FIX #prev-10: mode.session ensures martingale works from WS path too
        await this.startMartingale(userId, config, mode.session, orderId, momentumType, 1);
      } else {
        mode.totalLosses++;
        mode.activeMomentumOrders.delete(momentumType);
      }
    } else {
      if (step >= config.martingale.maxSteps) {
        mode.totalLosses++;
        mode.activeMartingaleOrders.delete(orderId);
        mode.activeMomentumOrders.delete(momentumType);
      } else {
        await this.startMartingale(userId, config, mode.session, orderId, momentumType, step + 1);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MARTINGALE
  // ─────────────────────────────────────────────────────────────────────────

  private async startMartingale(
    userId: string,
    config: MomentumConfig,
    session: any,
    parentOrderId: string,
    momentumType: MomentumType,
    step: number,
  ) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    if (step > config.martingale.maxSteps) {
      this.logger.log(`[${userId}] Max martingale steps reached for ${momentumType}`);
      mode.activeMartingaleOrders.delete(parentOrderId);
      mode.activeMomentumOrders.delete(momentumType);
      return;
    }

    const martingaleAmount = this.calculateMartingaleAmount(config, step);
    const parentOrder      = mode.momentumOrders.get(parentOrderId); // FIX #prev-4: O(1)
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

    const martingaleLog: MomentumLog = {
      id: uuidv4(), orderId: parentOrderId,
      momentumType, trend: parentOrder.trend,
      amount: martingaleAmount, martingaleStep: step,
      executedAt: Date.now(),
      note: `Martingale step ${step}/${config.martingale.maxSteps}`,
    };
    this.appendLog(userId, martingaleLog);

    const tradeResult = await mode.wsClient.placeTrade(
      this.buildTradePayload(session, config, martingaleAmount, parentOrder.trend),
    );

    // FIX #new-3: amount_min on martingale step
    if (tradeResult.error === 'amount_min') {
      this.logger.error(`[${userId}] ❌ Martingale step ${step} amount_min — bot dihentikan`);
      this.updateLog(userId, parentOrderId, { result: 'FAILED', note: `Martingale step ${step}: amount di bawah minimum` }, step);
      mode.activeMartingaleOrders.delete(parentOrderId);
      mode.activeMomentumOrders.delete(momentumType);
      this.stopMomentumMode(userId);
      return;
    }

    if (tradeResult?.dealId) {
      this.updateLog(userId, parentOrderId, { dealId: tradeResult.dealId }, step);
      // FIX #new-2: register martingale deal for WS matching
      mode.activeDeals.set(tradeResult.dealId, {
        orderId: parentOrderId, step,
        momentumType, isAlwaysSignal: false,
        amount: martingaleAmount, trend: parentOrder.trend,
        placedAt: Date.now(),
      });
    }

    this.monitorResult(userId, config, session, parentOrderId, step, momentumType, false);
  }

  private calculateMartingaleAmount(config: MomentumConfig, step: number): number {
    const multiplier = config.martingale.multiplierType === 'FIXED'
      ? config.martingale.multiplierValue
      : 1 + config.martingale.multiplierValue / 100;
    return Math.floor(config.martingale.baseAmount * Math.pow(multiplier, step));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LOG PERSISTENCE (Supabase)
  // ─────────────────────────────────────────────────────────────────────────

  private appendLog(userId: string, log: MomentumLog) {
    const mode = this.activeModes.get(userId);
    if (mode) {
      const existingIdx = mode.logs.findIndex((l) => l.id === log.id);
      if (existingIdx !== -1) { mode.logs[existingIdx] = log; }
      else { mode.logs.push(log); }
      if (mode.logs.length > 500) mode.logs.splice(0, mode.logs.length - 500);
    }
    this.persistLogToSupabase(userId, log).catch((err) =>
      this.logger.error(`[${userId}] Failed to persist log: ${err.message}`),
    );
  }

  private updateLog(userId: string, orderId: string, updates: Partial<MomentumLog>, step = 0) {
    const mode = this.activeModes.get(userId);
    if (mode) {
      const idx = mode.logs.findIndex((l) => l.orderId === orderId && l.martingaleStep === step);
      if (idx !== -1) {
        mode.logs[idx] = { ...mode.logs[idx], ...updates };
        this.persistLogToSupabase(userId, mode.logs[idx]).catch(() => {});
      }
    } else {
      Promise.resolve(
        this.supabaseService.client
          .from('mode_logs').select('id, data')
          .eq('user_id', userId).eq('mode', 'momentum')
          .contains('data', { orderId, martingaleStep: step }).limit(1),
      ).then(({ data: rows }) => {
        if (rows?.length > 0) {
          const row    = rows[0];
          const merged = { ...(row.data as object), ...updates };
          Promise.resolve(
            this.supabaseService.client.from('mode_logs').update({ data: merged }).eq('id', row.id),
          ).catch(() => {});
        }
      }).catch(() => {});
    }
  }

  private async persistLogToSupabase(userId: string, log: MomentumLog) {
    const { error } = await this.supabaseService.client.from('mode_logs').upsert({
      id: log.id,
      user_id: userId,
      mode: 'momentum',
      data: log,
      executed_at: this.supabaseService.timestampFromMillis(log.executedAt),
      created_at:  this.supabaseService.now(),
    });
    if (error) this.logger.error(`[${userId}] persistLogToSupabase error: ${error.message}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STATUS PERSISTENCE
  // ─────────────────────────────────────────────────────────────────────────

  private async updateStatus(userId: string, botState: string) {
    const { error } = await this.supabaseService.client.from('momentum_status').upsert({
      user_id: userId,
      bot_state: botState,
      updated_at: this.supabaseService.now(),
    });
    if (error) this.logger.error(`[${userId}] updateStatus error: ${error.message}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TRADE HELPERS
  // ─────────────────────────────────────────────────────────────────────────

  private async fetchTradeResult(session: any, config: MomentumConfig): Promise<any | null> {
    try {
      const dealType = config.isDemoAccount ? 'demo' : 'real';
      const response = await curlGet(
        `${BASE_URL}/binary-options/trades/last?deal_type=${dealType}`,
        this.buildStockityHeaders(session),
        5,
      );
      if (response.data?.data) {
        const trade = response.data.data;
        if (trade.status && TERMINAL_STATUSES.has(trade.status.toLowerCase())) return trade;
      }
      return null;
    } catch { return null; }
  }

  private buildTradePayload(session: any, config: MomentumConfig, amount: number, trend: string): any {
    const nowMs        = Date.now();
    const createdAtSec = Math.floor(nowMs / 1_000);
    const remaining    = 60 - (createdAtSec % 60);
    const expireAt     = remaining >= 5 ? createdAtSec + remaining : createdAtSec + remaining + 60;

    return {
      amount,
      createdAt: (createdAtSec + 1) * 1_000,
      dealType:   config.isDemoAccount ? 'demo' : 'real',
      expireAt,
      iso:        session.currency_iso || config.currency || 'IDR',
      optionType: 'turbo',
      ric:        config.asset!.ric,
      trend,
    };
  }

  private buildStockityHeaders(session: any): Record<string, string> {
    return {
      'authorization-token': session.stockity_token,
      'device-id':           session.device_id,
      'device-type':         session.device_type || 'web',
      'user-timezone':       session.user_timezone || 'Asia/Jakarta',
      'User-Agent':          session.user_agent,
      'Accept':              'application/json, text/plain, */*',
      'Origin':              'https://stockity.id',
      'Referer':             'https://stockity.id/',
    };
  }

  private checkStopConditions(userId: string, mode: ActiveModeState, config: MomentumConfig): boolean {
    const { stopLoss, stopProfit } = config.martingale;

    if (stopLoss && stopLoss > 0 && mode.sessionPnL <= -stopLoss) {
      this.logger.log(`[${userId}] 🛑 Stop Loss: sessionPnL=${mode.sessionPnL} ≤ -${stopLoss}`);
      this.appendLog(userId, {
        id: `stoploss_${Date.now()}`, orderId: 'system',
        momentumType: MomentumType.CANDLE_SABIT, trend: '-',
        amount: 0, martingaleStep: 0, executedAt: Date.now(),
        note: `⛔ Stop Loss triggered: sessionPnL=${mode.sessionPnL} ≤ -${stopLoss}`,
      });
      this.stopMomentumMode(userId);
      return true;
    }

    if (stopProfit && stopProfit > 0 && mode.sessionPnL >= stopProfit) {
      this.logger.log(`[${userId}] ✅ Stop Profit: sessionPnL=${mode.sessionPnL} ≥ ${stopProfit}`);
      this.appendLog(userId, {
        id: `stopprofit_${Date.now()}`, orderId: 'system',
        momentumType: MomentumType.CANDLE_SABIT, trend: '-',
        amount: 0, martingaleStep: 0, executedAt: Date.now(),
        note: `🎯 Stop Profit triggered: sessionPnL=${mode.sessionPnL} ≥ ${stopProfit}`,
      });
      this.stopMomentumMode(userId);
      return true;
    }

    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}