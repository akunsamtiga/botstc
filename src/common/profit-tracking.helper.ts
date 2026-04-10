// src/common/profit-tracking.helper.ts
/**
 * Helper untuk standardisasi profit tracking across all modes
 */
export class ProfitTrackingHelper {
  /**
   * Standard log entry structure
   */
  static createLogEntry(params: {
    orderId: string;
    mode: string;
    trend: string;
    amount: number;
    martingaleStep?: number;
    result?: 'WIN' | 'LOSE' | 'DRAW' | 'FAILED';
    profit?: number;
    sessionPnL?: number;
    executedAt?: number;
    ric?: string;
    assetName?: string;
    isDemoAccount?: boolean;
    note?: string;
  }): Record<string, any> {
    return {
      ...params,
      executedAt: params.executedAt || Date.now(),
      // Ensure consistent field naming
      assetRic: params.ric,
      // Add metadata for easier querying
      _mode: params.mode,
      _hasResult: !!params.result,
      _isWin: params.result === 'WIN',
      _isLoss: params.result === 'LOSE',
    };
  }

  /**
   * Calculate profit from result
   */
  static calculateProfit(
    result: 'WIN' | 'LOSE' | 'DRAW',
    amount: number,
    profitRate: number = 0.85,
  ): number {
    if (result === 'WIN') return Math.floor(amount * profitRate);
    if (result === 'LOSE') return -amount;
    return 0;
  }
}