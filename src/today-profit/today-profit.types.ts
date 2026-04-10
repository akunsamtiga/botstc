// src/today-profit/today-profit.types.ts
export interface TodayProfitSummary {
  date: string; // YYYY-MM-DD
  totalPnL: number;
  totalTrades: number;
  totalWins: number;
  totalLosses: number;
  winRate: number;
  byMode: Record<string, ModeProfitSummary>;
  byAsset: Record<string, AssetProfitSummary>;
}

export interface ModeProfitSummary {
  mode: string;
  pnl: number;
  trades: number;
  wins: number;
  losses: number;
}

export interface AssetProfitSummary {
  ric: string;
  name: string;
  pnl: number;
  trades: number;
}

export interface TodayProfitQuery {
  date?: string; // YYYY-MM-DD, default today
  userId: string;
}

export interface TodayProfitResponse {
  success: boolean;
  data?: TodayProfitSummary;
  error?: string;
}