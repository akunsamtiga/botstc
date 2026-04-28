// src/today-profit/today-profit.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';
import { AuthService } from '../auth/auth.service';
import {
  TodayProfitSummary,
  ModeProfitSummary,
  AssetProfitSummary,
  DataSourceMeta,
  UserStockityCredentials,
} from './today-profit.types';
import { StockityHistoryService, StockityDeal, StockityCredentials } from './stockity-history.service';

// ─── Internal types ───────────────────────────────────────────────────────────

interface LogEntry {
  id: string;
  /** Stockity UUID (from bo:closed WebSocket event) — used for deduplication */
  dealId?: string;
  /** Stockity numeric ID (from bo:opened) — secondary dedup key */
  numericDealId?: string;
  result?: string;
  profit?: number;
  sessionPnL?: number;
  executedAt: number | { toMillis: () => number };
  trend?: string;
  amount?: number;
  isDemoAccount?: boolean;
  ric?: string;
  assetRic?: string;
  assetName?: string;
  mode?: string;
  martingaleStep?: number;
}

interface MergedTrade {
  source: 'firebase' | 'stockity';
  result: 'WIN' | 'LOSE' | 'DRAW';
  profit: number;
  ric: string;
  assetName: string;
  mode: string;
  /** Stockity UUID, used as canonical dedup key */
  dealUuid?: string;
  /** Stockity numeric ID */
  dealNumericId?: string;
}

// ─── Service ──────────────────────────────────────────────────────────────────

/** Cached Stockity API result per user */
interface StockityCache {
  deals: StockityDeal[];
  hadErrors: boolean;
  fetchedAt: number;
  accountType: string;
  dateStr: string;
}

@Injectable()
export class TodayProfitService {
  private readonly logger = new Logger(TodayProfitService.name);

  /**
   * In-memory per-user cache for Stockity API results.
   * TTL: 25s — avoids hammering Stockity on every /realtime poll.
   * Cache invalidated when day changes or accountType changes.
   */
  private readonly stockityCache = new Map<string, StockityCache>();
  private readonly STOCKITY_CACHE_TTL_MS = 25_000;

  /**
   * Trading modes tracked via Firebase mode logs.
   * Each mode writes to `{mode}_logs/{userId}/entries`.
   */
  private readonly MODES = ['schedule', 'fastrade', 'indicator', 'momentum', 'aisignal'];

  /**
   * Firestore path where user sessions/credentials are stored.
   * Login (auth.service.ts) saves to `sessions/{userId}` with field `stockityToken`.
   */
  private readonly CREDENTIALS_COLLECTION = 'sessions';

  constructor(
    private readonly firebaseService: FirebaseService,
    private readonly authService: AuthService,
    private readonly stockityHistoryService: StockityHistoryService,
  ) {}

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Get today's profit summary for a user.
   *
   * Strategy:
   *  1. Pull all Firebase mode logs for the day → build a Set of known deal UUIDs.
   *  2. Pull Stockity API history for the day (real + demo as configured).
   *  3. Any Stockity deal whose UUID is NOT in the Firebase set → add as extra.
   *  4. Aggregate everything into a single unified summary.
   */
  async getTodayProfit(
    userId: string,
    dateStr?: string,
    accountType: 'real' | 'demo' | 'both' = 'real',
  ): Promise<TodayProfitSummary> {
    const targetDate = dateStr || this.getTodayDateString();
    const { startOfDay, endOfDay } = this.getDayBoundaries(targetDate);

    this.logger.log(`[${userId}] Calculating profit for ${targetDate}`);

    // ── Step 1: collect Firebase log trades ──────────────────────────────────
    const { firebaseTrades, knownUuids, knownNumericIds } =
      await this.collectFirebaseTrades(userId, startOfDay, endOfDay);

    // ── Step 2: collect Stockity API trades (skip already-known deals) ───────
    const { stockityTrades, meta } = await this.collectStockityTrades(
      userId,
      accountType,
      startOfDay,
      endOfDay,
      knownUuids,
      knownNumericIds,
    );

    // ── Step 3: merge & aggregate ─────────────────────────────────────────────
    const allTrades: MergedTrade[] = [...firebaseTrades, ...stockityTrades];

    return this.buildSummary(targetDate, allTrades, {
      ...meta,
      firebaseTrades: firebaseTrades.length,
      stockityOnlyTrades: stockityTrades.length,
    });
  }

  /** Get profit history for a date range (day by day). */
  async getProfitHistory(
    userId: string,
    startDate: string,
    endDate: string,
  ): Promise<TodayProfitSummary[]> {
    const results: TodayProfitSummary[] = [];
    // FIX: Parse dates as WIB (+07:00) agar iterasi hari sesuai tanggal lokal WIB
    const start = new Date(`${startDate}T00:00:00.000+07:00`);
    const end   = new Date(`${endDate}T00:00:00.000+07:00`);

    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      // Format YYYY-MM-DD dari UTC date (d sudah diset ke WIB midnight dalam UTC)
      const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(d);
      const daily = await this.getTodayProfit(userId, dateStr);
      if (daily.totalTrades > 0) results.push(daily);
    }
    return results;
  }

  /**
   * Realtime proxy — uses CACHED Stockity data + fresh Firebase data.
   * This is fast (~200ms) because it skips the slow Stockity API fetch.
   * Cache is populated/refreshed by getTodayProfit() every 25s or on demand.
   */
  async getRealtimeProfit(userId: string): Promise<Partial<TodayProfitSummary>> {
    const targetDate = this.getTodayDateString();
    const { startOfDay, endOfDay } = this.getDayBoundaries(targetDate);

    const { firebaseTrades, knownUuids, knownNumericIds } =
      await this.collectFirebaseTrades(userId, startOfDay, endOfDay);

    // Use cached Stockity data if available — skip live API call
    const cached = this.stockityCache.get(userId);
    const cacheValid = cached &&
      cached.dateStr === targetDate &&
      (Date.now() - cached.fetchedAt) < this.STOCKITY_CACHE_TTL_MS;

    let stockityTrades: MergedTrade[] = [];
    if (cacheValid && cached) {
      this.logger.debug(`[${userId}] /realtime using cached Stockity data (age=${Math.round((Date.now()-cached.fetchedAt)/1000)}s)`);
      for (const deal of cached.deals) {
        if (knownUuids.has(deal.uuid) || knownNumericIds.has(String(deal.id))) continue;
        knownUuids.add(deal.uuid);
        knownNumericIds.add(String(deal.id));
        stockityTrades.push({
          source: 'stockity',
          result: StockityHistoryService.mapStatus(deal),
          profit: StockityHistoryService.netProfit(deal),
          ric: deal.asset_ric,
          assetName: deal.asset_name,
          mode: `stockity_real`,
          dealUuid: deal.uuid,
          dealNumericId: String(deal.id),
        });
      }
    }

    const allTrades: MergedTrade[] = [...firebaseTrades, ...stockityTrades];
    return this.buildSummary(targetDate, allTrades, {
      firebaseTrades: firebaseTrades.length,
      stockityOnlyTrades: stockityTrades.length,
      stockityCredentialsFound: !!cached,
      stockityApiError: cached?.hadErrors ?? false,
    });
  }

  // ── Firebase collection ─────────────────────────────────────────────────────

  /**
   * Pull all mode logs from Firebase for the given day,
   * returning normalized MergedTrade entries plus dedup key sets.
   */
  private async collectFirebaseTrades(
    userId: string,
    startOfDay: number,
    endOfDay: number,
  ): Promise<{
    firebaseTrades: MergedTrade[];
    knownUuids: Set<string>;
    knownNumericIds: Set<string>;
  }> {
    const firebaseTrades: MergedTrade[] = [];
    const knownUuids = new Set<string>();
    const knownNumericIds = new Set<string>();

    for (const mode of this.MODES) {
      const logs = await this.fetchLogsFromFirebase(userId, mode, startOfDay, endOfDay);
      const processedKeys = new Set<string>();

      for (const log of logs) {
        const executedAt = this.getTimestampMillis(log.executedAt);
        if (executedAt < startOfDay || executedAt > endOfDay) continue;

        // ── Martingale dedup: only count final step ─────────────────────────
        if (log.martingaleStep !== undefined && log.martingaleStep > 0) {
          const orderId = this.extractOrderId(log);
          const isFinal = !logs.some(
            l =>
              this.extractOrderId(l) === orderId &&
              (l.martingaleStep || 0) > (log.martingaleStep || 0),
          );
          if (!isFinal) continue;
        }

        const uniqueKey = `${this.extractOrderId(log)}_${log.martingaleStep || 0}`;
        if (processedKeys.has(uniqueKey)) continue;
        processedKeys.add(uniqueKey);

        // Register Stockity deal IDs for later dedup
        if (log.dealId)        knownUuids.add(log.dealId);
        if (log.numericDealId) knownNumericIds.add(log.numericDealId);

        // Only count completed trades
        if (log.result !== 'WIN' && log.result !== 'LOSE' && log.result !== 'DRAW') continue;

        const profit =
          log.profit ??
          (log.result === 'WIN'
            ? 0
            : log.result === 'LOSE'
            ? -(log.amount || 0)
            : 0);

        firebaseTrades.push({
          source: 'firebase',
          result: log.result as 'WIN' | 'LOSE' | 'DRAW',
          profit,
          ric: log.ric || log.assetRic || 'unknown',
          assetName: log.assetName || log.ric || log.assetRic || 'unknown',
          mode,
          dealUuid: log.dealId,
          dealNumericId: log.numericDealId,
        });
      }
    }

    return { firebaseTrades, knownUuids, knownNumericIds };
  }

  // ── Stockity API collection ─────────────────────────────────────────────────

  /**
   * Fetch trades directly from Stockity API and filter out those already
   * tracked in Firebase (identified by UUID match).
   *
   * Remaining trades are "orphan" trades — executed via the app/browser
   * directly or not yet synced to Firebase mode logs.
   */
  private async collectStockityTrades(
    userId: string,
    accountType: 'real' | 'demo' | 'both',
    startOfDay: number,
    endOfDay: number,
    knownUuids: Set<string>,
    knownNumericIds: Set<string>,
  ): Promise<{ stockityTrades: MergedTrade[]; meta: Omit<DataSourceMeta, 'firebaseTrades' | 'stockityOnlyTrades'> }> {
    const defaultMeta: Omit<DataSourceMeta, 'firebaseTrades' | 'stockityOnlyTrades'> = {
      stockityCredentialsFound: false,
      stockityApiError: false,
    };

    // Load user credentials from Firestore
    const creds = await this.loadStockityCredentials(userId);
    if (!creds) {
      this.logger.warn(`[${userId}] No Stockity credentials found — skipping API fetch`);
      return { stockityTrades: [], meta: defaultMeta };
    }

    defaultMeta.stockityCredentialsFound = true;

    // Determine which account types to fetch
    const types: Array<'real' | 'demo'> =
      accountType === 'both' ? ['real', 'demo'] : [accountType];

    const stockityTrades: MergedTrade[] = [];
    const rawDealsForCache: StockityDeal[] = [];
    let hadErrors = false;

    for (const type of types) {
      const result = await this.stockityHistoryService.fetchDayTrades(
        creds as StockityCredentials,
        type,
        startOfDay,
        endOfDay,
      );

      if (result.hadErrors) hadErrors = true;

      // ── Save raw deals to cache (all deals, before dedup filter) ───────────
      rawDealsForCache.push(...result.deals);

      for (const deal of result.deals) {
        // ── Deduplication ───────────────────────────────────────────────────
        // A deal is "known" if its UUID or numeric ID was logged by any mode bot.
        if (knownUuids.has(deal.uuid))            continue;
        if (knownNumericIds.has(String(deal.id))) continue;

        // Register so sibling account types don't double-count either
        knownUuids.add(deal.uuid);
        knownNumericIds.add(String(deal.id));

        const result2 = StockityHistoryService.mapStatus(deal);
        const profit  = StockityHistoryService.netProfit(deal);

        stockityTrades.push({
          source: 'stockity',
          result: result2,
          profit,
          ric: deal.asset_ric,
          assetName: deal.asset_name,
          // Label as 'stockity_direct' so callers can distinguish in byMode
          mode: `stockity_${type}`,
          dealUuid: deal.uuid,
          dealNumericId: String(deal.id),
        });
      }
    }

    // ── Update per-user cache with fresh Stockity data ─────────────────────
    // FIX: Gunakan WIB timezone untuk cache key agar match dengan targetDate dari getTodayDateString()
    const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date(startOfDay));
    this.stockityCache.set(userId, {
      deals: rawDealsForCache,
      hadErrors,
      fetchedAt: Date.now(),
      accountType,
      dateStr,
    });
    this.logger.debug(`[${userId}] Stockity cache updated: ${rawDealsForCache.length} deals, date=${dateStr}`);

    return {
      stockityTrades,
      meta: { ...defaultMeta, stockityApiError: hadErrors },
    };
  }

  // ── Aggregation ─────────────────────────────────────────────────────────────

  private buildSummary(
    date: string,
    trades: MergedTrade[],
    dataSources: DataSourceMeta,
  ): TodayProfitSummary {
    const byMode: Record<string, ModeProfitSummary>   = {};
    const byAsset: Record<string, AssetProfitSummary> = {};

    let totalPnL = 0;
    let totalWins = 0;
    let totalLosses = 0;
    let totalDraws = 0;

    for (const trade of trades) {
      totalPnL += trade.profit;
      if (trade.result === 'WIN')  totalWins++;
      if (trade.result === 'LOSE') totalLosses++;
      if (trade.result === 'DRAW') totalDraws++;

      // ── byMode ────────────────────────────────────────────────────────────
      if (!byMode[trade.mode]) {
        byMode[trade.mode] = { mode: trade.mode, pnl: 0, trades: 0, wins: 0, losses: 0, draws: 0 };
      }
      const m = byMode[trade.mode];
      m.trades++;
      m.pnl += trade.profit;
      if (trade.result === 'WIN')  m.wins++;
      if (trade.result === 'LOSE') m.losses++;
      if (trade.result === 'DRAW') m.draws++;

      // ── byAsset ───────────────────────────────────────────────────────────
      if (!byAsset[trade.ric]) {
        byAsset[trade.ric] = { ric: trade.ric, name: trade.assetName, pnl: 0, trades: 0 };
      }
      const a = byAsset[trade.ric];
      a.trades++;
      a.pnl += trade.profit;
    }

    const totalTrades = trades.length;
    const winRate = totalTrades > 0 ? Math.round((totalWins / totalTrades) * 10000) / 100 : 0;

    return {
      date,
      totalPnL,
      totalTrades,
      totalWins,
      totalLosses,
      totalDraws,
      winRate,
      byMode,
      byAsset,
      dataSources,
    };
  }

  // ── Firebase helpers ────────────────────────────────────────────────────────

  private async fetchLogsFromFirebase(
    userId: string,
    mode: string,
    startTime: number,
    endTime: number,
  ): Promise<LogEntry[]> {
    try {
      const startTs = this.firebaseService.Timestamp.fromMillis(startTime);
      const endTs   = this.firebaseService.Timestamp.fromMillis(endTime);

      const snapshot = await this.firebaseService.db
        .collection(`${mode}_logs`)
        .doc(userId)
        .collection('entries')
        .where('executedAt', '>=', startTs)
        .where('executedAt', '<=', endTs)
        .orderBy('executedAt', 'desc')
        .limit(1000)
        .get();

      return snapshot.docs.map(doc => ({ ...(doc.data() as LogEntry), mode }));
    } catch (err: any) {
      this.logger.warn(`[${userId}] Failed to fetch ${mode} logs: ${err.message}`);
      return [];
    }
  }

  /**
   * Load Stockity credentials from Firestore.
   *
   * Expected document: `user_credentials/{userId}`
   * Fields: authToken, deviceId, deviceType, timezone?
   *
   * The bot should write these when the user configures their Stockity account.
   * Adjust the collection path if your schema differs.
   */
  private async loadStockityCredentials(
    userId: string,
  ): Promise<UserStockityCredentials | null> {
    try {
      const doc = await this.firebaseService.db
        .collection(this.CREDENTIALS_COLLECTION)
        .doc(userId)
        .get();

      if (!doc.exists) return null;

      const data = doc.data() as Partial<UserStockityCredentials>;
      if (!data.authToken || !data.deviceId || !data.deviceType) {
        this.logger.warn(`[${userId}] Incomplete Stockity credentials in Firestore`);
        return null;
      }

      return {
        authToken:  data.authToken,
        deviceId:   data.deviceId,
        deviceType: data.deviceType,
        timezone:   data.timezone || 'Asia/Jakarta',
      };
    } catch (err: any) {
      this.logger.warn(`[${userId}] Error loading Stockity credentials: ${err.message}`);
      return null;
    }
  }

  // ── Utility helpers ─────────────────────────────────────────────────────────

  private extractOrderId(log: LogEntry): string {
    return log.id ? log.id.replace(/_s\d+$/, '') : 'unknown';
  }

  private getTimestampMillis(ts: any): number {
    if (typeof ts === 'number')                        return ts;
    if (typeof ts === 'object' && ts?.toMillis)        return ts.toMillis();
    if (ts instanceof Date)                            return ts.getTime();
    return Date.now();
  }

  private getTodayDateString(): string {
    // FIX: Gunakan timezone WIB (Asia/Jakarta, UTC+7), BUKAN UTC.
    // toISOString() mengembalikan UTC date -- di WIB midnight (00:00 WIB = 17:00 UTC)
    // toISOString() masih return tanggal kemarin, reset baru terjadi jam 07:00 WIB.
    // en-CA locale -> format YYYY-MM-DD yang dibutuhkan.
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());
  }

  private getDayBoundaries(dateStr: string): { startOfDay: number; endOfDay: number } {
    // FIX: Parse tanggal sebagai WIB dengan explicit offset +07:00.
    // new Date('YYYY-MM-DD') tanpa offset -> di-parse sebagai UTC midnight (ECMAScript spec),
    // bukan WIB midnight. Batas hari geser 7 jam sehingga reset terjadi jam 07:00 WIB.
    // Dengan suffix '+07:00', JavaScript menginterpretasi sebagai WIB midnight yang benar.
    const startOfDay = new Date(`${dateStr}T00:00:00.000+07:00`).getTime();
    const endOfDay   = new Date(`${dateStr}T23:59:59.999+07:00`).getTime();
    return { startOfDay, endOfDay };
  }
}