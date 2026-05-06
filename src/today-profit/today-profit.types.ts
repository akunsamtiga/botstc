// src/today-profit/today-profit.types.ts

export interface TodayProfitSummary {
  date: string;           // YYYY-MM-DD
  totalPnL: number;
  totalTrades: number;
  totalWins: number;
  totalLosses: number;
  totalDraws: number;
  winRate: number;        // percentage, 0-100
  byMode: Record<string, ModeProfitSummary>;
  byAsset: Record<string, AssetProfitSummary>;
  /** Metadata about data sources used to build this summary */
  dataSources: DataSourceMeta;
}

export interface ModeProfitSummary {
  mode: string;
  pnl: number;
  trades: number;
  wins: number;
  losses: number;
  draws: number;
}

export interface AssetProfitSummary {
  ric: string;
  name: string;
  pnl: number;
  trades: number;
}

export interface DataSourceMeta {
  /** Trades pulled from Supabase mode logs (schedule, fastrade, etc.) */
  supabaseTrades: number;
  /** Trades pulled directly from Stockity API not present in Supabase */
  stockityOnlyTrades: number;
  /** Whether Stockity API fetch had errors (partial data) */
  stockityApiError: boolean;
  /** Whether Stockity credentials were available */
  stockityCredentialsFound: boolean;
}

export interface TodayProfitQuery {
  date?: string;  // YYYY-MM-DD, defaults to today
  userId: string;
  /**
   * When true, also fetch directly from Stockity API and merge.
   * Trades already tracked in Supabase are deduplicated via UUID.
   * Default: true
   */
  includeStockityApi?: boolean;
  /**
   * Which account type to fetch from Stockity API.
   * Default: 'real'
   */
  accountType?: 'real' | 'demo' | 'both';
}

export interface TodayProfitResponse {
  success: boolean;
  data?: TodayProfitSummary;
  error?: string;
}

/** Stockity credentials stored per user in Supabase */
export interface UserStockityCredentials {
  authToken: string;
  deviceId: string;
  deviceType: string;
  timezone?: string;
}