// src/today-profit/today-profit.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';
import { AuthService } from '../auth/auth.service';
import { TodayProfitSummary, ModeProfitSummary, AssetProfitSummary } from './today-profit.types';

interface LogEntry {
  id: string;
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

@Injectable()
export class TodayProfitService {
  private readonly logger = new Logger(TodayProfitService.name);
  private readonly MODES = ['schedule', 'fastrade', 'indicator', 'momentum', 'aisignal'];

  constructor(
    private readonly firebaseService: FirebaseService,
    private readonly authService: AuthService,
  ) {}

  /**
   * Get today's profit summary for a user
   * Aggregates data from all trading modes
   */
  async getTodayProfit(userId: string, dateStr?: string): Promise<TodayProfitSummary> {
    const targetDate = dateStr || this.getTodayDateString();
    const { startOfDay, endOfDay } = this.getDayBoundaries(targetDate);

    this.logger.log(`[${userId}] Calculating profit for ${targetDate}`);

    const byMode: Record<string, ModeProfitSummary> = {};
    const byAsset: Record<string, AssetProfitSummary> = {};
    let totalPnL = 0;
    let totalTrades = 0;
    let totalWins = 0;
    let totalLosses = 0;

    // Aggregate from all modes
    for (const mode of this.MODES) {
      const modeData = await this.getModeProfit(userId, mode, startOfDay, endOfDay);
      
      if (modeData.trades > 0) {
        byMode[mode] = modeData;
        totalPnL += modeData.pnl;
        totalTrades += modeData.trades;
        totalWins += modeData.wins;
        totalLosses += modeData.losses;

        // Aggregate by asset
        const assetData = await this.getModeAssetBreakdown(userId, mode, startOfDay, endOfDay);
        for (const asset of assetData) {
          if (!byAsset[asset.ric]) {
            byAsset[asset.ric] = { ric: asset.ric, name: asset.name, pnl: 0, trades: 0 };
          }
          byAsset[asset.ric].pnl += asset.pnl;
          byAsset[asset.ric].trades += asset.trades;
        }
      }
    }

    const winRate = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;

    return {
      date: targetDate,
      totalPnL,
      totalTrades,
      totalWins,
      totalLosses,
      winRate: Math.round(winRate * 100) / 100,
      byMode,
      byAsset,
    };
  }

  /**
   * Get profit data for a specific trading mode
   */
  private async getModeProfit(
    userId: string,
    mode: string,
    startTime: number,
    endTime: number,
  ): Promise<ModeProfitSummary> {
    const logs = await this.fetchLogsFromFirebase(userId, mode, startTime, endTime);
    
    let pnl = 0;
    let trades = 0;
    let wins = 0;
    let losses = 0;

    // Track processed order IDs to avoid duplicates (martingale steps vs final results)
    const processedOrders = new Set<string>();

    for (const log of logs) {
      const executedAt = this.getTimestampMillis(log.executedAt);
      
      // Skip if outside time range
      if (executedAt < startTime || executedAt > endTime) continue;

      // Skip demo trades if needed (optional filter)
      // if (log.isDemoAccount === true) continue;

      const orderId = this.extractOrderId(log);
      
      // For martingale, only count the final result (highest step)
      if (log.martingaleStep !== undefined && log.martingaleStep > 0) {
        // Check if this is the final step for this order
        const isFinalStep = !logs.some(l => 
          this.extractOrderId(l) === orderId && 
          (l.martingaleStep || 0) > (log.martingaleStep || 0)
        );
        if (!isFinalStep) continue;
      }

      // Skip duplicates
      const uniqueKey = `${orderId}_${log.martingaleStep || 0}`;
      if (processedOrders.has(uniqueKey)) continue;
      processedOrders.add(uniqueKey);

      // Count completed trades only
      if (log.result === 'WIN' || log.result === 'LOSE' || log.result === 'DRAW') {
        trades++;
        
        if (log.result === 'WIN') {
          wins++;
          pnl += log.profit || 0;
        } else if (log.result === 'LOSE') {
          losses++;
          pnl += log.profit || -(log.amount || 0);
        } else if (log.result === 'DRAW') {
          // Draw: no profit/loss
        }
      } else if (log.sessionPnL !== undefined && log.sessionPnL !== null) {
        // Alternative: use sessionPnL delta if available
        // This is more accurate for some modes
      }
    }

    // Recalculate PnL from session totals if available for better accuracy
    const sessionPnL = this.calculateSessionPnLFromLogs(logs, startTime, endTime);
    if (sessionPnL !== null) {
      pnl = sessionPnL;
    }

    return {
      mode,
      pnl,
      trades,
      wins,
      losses,
    };
  }

  /**
   * Get asset breakdown for a specific mode
   */
  private async getModeAssetBreakdown(
    userId: string,
    mode: string,
    startTime: number,
    endTime: number,
  ): Promise<Array<{ ric: string; name: string; pnl: number; trades: number }>> {
    const logs = await this.fetchLogsFromFirebase(userId, mode, startTime, endTime);
    const assetMap = new Map<string, { ric: string; name: string; pnl: number; trades: number }>();

    for (const log of logs) {
      const executedAt = this.getTimestampMillis(log.executedAt);
      if (executedAt < startTime || executedAt > endTime) continue;
      if (!log.result) continue;

      const ric = log.ric || log.assetRic || 'unknown';
      const name = log.assetName || ric;

      if (!assetMap.has(ric)) {
        assetMap.set(ric, { ric, name, pnl: 0, trades: 0 });
      }

      const asset = assetMap.get(ric)!;
      asset.trades++;

      if (log.result === 'WIN') {
        asset.pnl += log.profit || 0;
      } else if (log.result === 'LOSE') {
        asset.pnl += log.profit || -(log.amount || 0);
      }
    }

    return Array.from(assetMap.values());
  }

  /**
   * Fetch logs from Firebase for a specific mode
   */
  private async fetchLogsFromFirebase(
    userId: string,
    mode: string,
    startTime: number,
    endTime: number,
  ): Promise<LogEntry[]> {
    try {
      // Convert to Firestore Timestamps for query
      const startTimestamp = this.firebaseService.Timestamp.fromMillis(startTime);
      const endTimestamp = this.firebaseService.Timestamp.fromMillis(endTime);

      const snapshot = await this.firebaseService.db
        .collection(`${mode}_logs`)
        .doc(userId)
        .collection('entries')
        .where('executedAt', '>=', startTimestamp)
        .where('executedAt', '<=', endTimestamp)
        .orderBy('executedAt', 'desc')
        .limit(1000)
        .get();

      return snapshot.docs.map(doc => {
        const data = doc.data() as LogEntry;
        // Add mode info for identification
        return { ...data, mode };
      });
    } catch (error: any) {
      this.logger.warn(`[${userId}] Failed to fetch ${mode} logs: ${error.message}`);
      return [];
    }
  }

  /**
   * Calculate PnL from session totals in logs (more accurate method)
   */
  private calculateSessionPnLFromLogs(
    logs: LogEntry[],
    startTime: number,
    endTime: number,
  ): number | null {
    // Find the last log with sessionPnL
    const sortedLogs = logs
      .filter(l => l.sessionPnL !== undefined && l.sessionPnL !== null)
      .sort((a, b) => this.getTimestampMillis(b.executedAt) - this.getTimestampMillis(a.executedAt));

    if (sortedLogs.length === 0) return null;

    // Get final session PnL
    const finalLog = sortedLogs[0];
    const finalPnL = finalLog.sessionPnL || 0;

    // Find starting PnL (first log of the day or 0)
    const firstLog = sortedLogs[sortedLogs.length - 1];
    const startPnL = 0; // Assume starting from 0 for daily calculation

    return finalPnL - startPnL;
  }

  /**
   * Extract order ID from various log formats
   */
  private extractOrderId(log: LogEntry): string {
    // Handle different ID formats across modes
    if (log.id) {
      // Remove step suffix if present (e.g., "orderId_s1" -> "orderId")
      return log.id.replace(/_s\d+$/, '');
    }
    return 'unknown';
  }

  /**
   * Convert various timestamp formats to milliseconds
   */
  private getTimestampMillis(timestamp: any): number {
    if (typeof timestamp === 'number') return timestamp;
    if (typeof timestamp === 'object' && timestamp?.toMillis) return timestamp.toMillis();
    if (timestamp instanceof Date) return timestamp.getTime();
    return Date.now();
  }

  /**
   * Get today's date as YYYY-MM-DD string
   */
  private getTodayDateString(): string {
    const now = new Date();
    return now.toISOString().split('T')[0];
  }

  /**
   * Get start and end timestamps for a date
   */
  private getDayBoundaries(dateStr: string): { startOfDay: number; endOfDay: number } {
    const date = new Date(dateStr);
    const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
    const endOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
    
    return {
      startOfDay: startOfDay.getTime(),
      endOfDay: endOfDay.getTime(),
    };
  }

  /**
   * Get profit history for date range
   */
  async getProfitHistory(
    userId: string,
    startDate: string,
    endDate: string,
  ): Promise<TodayProfitSummary[]> {
    const results: TodayProfitSummary[] = [];
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    // Iterate through each day
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0];
      const dailyProfit = await this.getTodayProfit(userId, dateStr);
      if (dailyProfit.totalTrades > 0) {
        results.push(dailyProfit);
      }
    }
    
    return results;
  }

  /**
   * Get real-time profit from in-memory active sessions
   */
  async getRealtimeProfit(userId: string): Promise<Partial<TodayProfitSummary>> {
    const today = this.getTodayDateString();
    const baseProfit = await this.getTodayProfit(userId, today);
    
    // Add active session data if available
    // This would integrate with active trading modes
    // to show unrealized/current session PnL
    
    return baseProfit;
  }
}