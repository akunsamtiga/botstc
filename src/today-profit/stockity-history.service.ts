// src/today-profit/stockity-history.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { curlGet } from '../common/http-utils';

// ─── Stockity API response shapes ────────────────────────────────────────────

export interface StockityDeal {
  id: number;                     // Numeric deal ID (bo:opened)
  uuid: string;                   // UUID deal ID   (bo:closed)
  status: 'won' | 'lost' | 'equal'; // 'equal' = draw
  amount: number;                 // Trade amount (IDR, no decimals)
  win: number;                    // Payout amount (0 if lost)
  payment_rate: number;           // Profit rate percentage (e.g. 84)
  deal_type: 'real' | 'demo';
  trade_type: string;             // 'turbo', 'standard', etc.
  trend: 'call' | 'put';
  asset_id: number;
  asset_name: string;
  asset_ric: string;
  created_at: string;             // ISO-8601, UTC
  finished_at: string;            // ISO-8601, UTC — use this for day bucketing
  open_rate: number;
  close_rate: number;
}

export interface StockityFetchResult {
  deals: StockityDeal[];
  /** True if any page-fetch failed; partial results are still returned */
  hadErrors: boolean;
}

// ─── Credentials needed to call Stockity API ─────────────────────────────────

export interface StockityCredentials {
  authToken: string;
  deviceId: string;
  deviceType: string;   // 'web' | 'android' | 'ios'
  timezone?: string;    // default 'Asia/Jakarta'
}

const BASE_URL = 'https://api.stockity.id';
const MAX_PAGES = 20; // Safety cap — 20 pages × 30 deals = 600 trades/day max

@Injectable()
export class StockityHistoryService {
  private readonly logger = new Logger(StockityHistoryService.name);

  /**
   * Fetch ALL completed trades for a given calendar day.
   *
   * Stockity returns newest-first with cursor-based pagination.
   * We keep fetching until:
   *   (a) batch_key is null → no more pages, or
   *   (b) the oldest deal on the current page has finished_at BEFORE startOfDay
   *       → older pages can't contain today's trades.
   *
   * @param creds      User's Stockity credentials
   * @param accountType 'real' | 'demo'
   * @param startOfDay  Day start timestamp in ms (local midnight)
   * @param endOfDay    Day end timestamp in ms  (local 23:59:59.999)
   */
  async fetchDayTrades(
    creds: StockityCredentials,
    accountType: 'real' | 'demo',
    startOfDay: number,
    endOfDay: number,
  ): Promise<StockityFetchResult> {
    const allDeals: StockityDeal[] = [];
    let batchKey: string | null = null;
    let page = 0;
    let hadErrors = false;

    const headers = this.buildHeaders(creds);

    while (page < MAX_PAGES) {
      page++;
      const url = this.buildUrl(accountType, batchKey);

      try {
        const { status, data } = await curlGet(url, headers, 20);

        if (status !== 200 || !data?.data) {
          this.logger.warn(`[Stockity] Unexpected response page=${page} status=${status}`);
          hadErrors = true;
          break;
        }

        const deals: StockityDeal[] = data.data.standard_trade_deals ?? [];
        const nextBatchKey: string | null = data.data.batch_key ?? null;

        if (deals.length === 0) break;

        // Filter deals that fall within our day window
        const dayDeals = deals.filter(d => {
          const ts = new Date(d.finished_at).getTime();
          return ts >= startOfDay && ts <= endOfDay;
        });

        allDeals.push(...dayDeals);

        // Stop conditions
        const oldestDealTs = new Date(deals[deals.length - 1].finished_at).getTime();
        const noMorePages = !nextBatchKey;
        const pastOurDay = oldestDealTs < startOfDay;

        if (noMorePages || pastOurDay) break;

        batchKey = nextBatchKey;

      } catch (err: any) {
        this.logger.warn(`[Stockity] Fetch error page=${page}: ${err.message}`);
        hadErrors = true;
        break;
      }
    }

    this.logger.log(
      `[Stockity] Fetched ${allDeals.length} ${accountType} deals in ${page} page(s)` +
      (hadErrors ? ' [with errors]' : ''),
    );

    return { deals: allDeals, hadErrors };
  }

  /**
   * Calculate net profit from a Stockity deal.
   * - won  → payout (win) minus stake (amount)
   * - lost → negative stake
   * - equal (draw) → 0
   */
  static netProfit(deal: StockityDeal): number {
    if (deal.status === 'won')  return deal.win - deal.amount;
    if (deal.status === 'lost') return -deal.amount;
    return 0; // draw/equal
  }

  /**
   * Map Stockity status → internal result string
   */
  static mapStatus(deal: StockityDeal): 'WIN' | 'LOSE' | 'DRAW' {
    if (deal.status === 'won')  return 'WIN';
    if (deal.status === 'lost') return 'LOSE';
    return 'DRAW';
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private buildHeaders(creds: StockityCredentials): Record<string, string> {
    return {
      'authorization-token': creds.authToken,
      'device-id':           creds.deviceId,
      'device-type':         creds.deviceType,
      'user-timezone':       creds.timezone ?? 'Asia/Jakarta',
      'cache-control':       'no-cache, no-store, must-revalidate',
      'accept':              'application/json, text/plain, */*',
      'origin':              'https://stockity.id',
      'referer':             'https://stockity.id/',
      'user-agent':          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    };
  }

  private buildUrl(accountType: 'real' | 'demo', batchKey: string | null): string {
    const params = new URLSearchParams({ type: accountType, locale: 'id' });
    if (batchKey) params.set('batch_key', batchKey);
    return `${BASE_URL}/bo-deals-history/v3/deals/trade?${params.toString()}`;
  }
}