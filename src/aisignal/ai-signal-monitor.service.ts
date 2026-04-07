import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import axios from 'axios';
import { AISignalConfig, AISignalOrder, AISignalOrderStatus } from './types';
import { StockityWebSocketClient } from '../schedule/websocket-client';

interface MonitoringOrder {
  parentOrderId: string;
  monitoringOrderId: string;
  trend: string;
  amount: number;
  assetRic: string;
  isDemoAccount: boolean;
  isMartingale: boolean;
  martingaleStep: number;
  startTime: number;
  executionTime: number;
  lastCheckedTime: number;
  webSocketResultReceived: boolean;
  isCompleted: boolean;
}

interface TradeResult {
  parentOrderId: string;
  monitoringOrderId: string;
  isWin: boolean;
  isMartingale: boolean;
  martingaleStep: number;
  details: Map<string, any>;
}

@Injectable()
export class AISignalMonitorService implements OnModuleDestroy {
  private readonly logger = new Logger(AISignalMonitorService.name);
  private readonly MONITORING_INTERVAL_MS = 50;
  private readonly MONITORING_TIMEOUT_MS = 90000;
  private readonly WEBSOCKET_PRIORITY_WINDOW_MS = 2000;
  private readonly BASE_URL = 'https://api.stockity.id';

  private activeMonitoring = new Map<string, MonitoringOrder>();
  private processedResults = new Map<string, string>();
  private monitoringIntervals = new Map<string, NodeJS.Timeout>();
  private lastWebSocketUpdateTime = Date.now();

  onModuleDestroy() {
    for (const [userId, interval] of this.monitoringIntervals) {
      clearInterval(interval);
      this.logger.log(`Cleaned up monitoring for user: ${userId}`);
    }
    this.monitoringIntervals.clear();
    this.activeMonitoring.clear();
    this.processedResults.clear();
  }

  /**
   * Start monitoring for a specific user
   */
  startMonitoring(
    userId: string,
    wsClient: StockityWebSocketClient,
    onTradeResult: (result: TradeResult) => void,
  ): void {
    if (this.monitoringIntervals.has(userId)) {
      this.logger.warn(`[${userId}] Monitoring already active`);
      return;
    }

    this.logger.log(`[${userId}] Starting AI Signal monitoring`);

    // Set up WebSocket message handler
    this.setupWebSocketHandler(userId, wsClient, onTradeResult);

    // Start API polling interval
    const interval = setInterval(async () => {
      await this.checkOrdersViaApi(userId, onTradeResult);
    }, this.MONITORING_INTERVAL_MS);

    this.monitoringIntervals.set(userId, interval);
  }

  /**
   * Stop monitoring for a specific user
   */
  stopMonitoring(userId: string): void {
    const interval = this.monitoringIntervals.get(userId);
    if (interval) {
      clearInterval(interval);
      this.monitoringIntervals.delete(userId);
    }

    // Clean up monitoring orders for this user
    for (const [key, order] of this.activeMonitoring) {
      if (key.startsWith(`${userId}_`)) {
        this.activeMonitoring.delete(key);
      }
    }

    this.logger.log(`[${userId}] Monitoring stopped`);
  }

  /**
   * Start monitoring a specific order
   */
  startMonitoringOrder(
    userId: string,
    parentOrderId: string,
    trend: string,
    amount: number,
    assetRic: string,
    isDemoAccount: boolean,
    isMartingale: boolean,
    martingaleStep: number,
  ): void {
    const monitoringOrderId = isMartingale
      ? `${parentOrderId}_martingale_${martingaleStep}`
      : parentOrderId;

    const monitoring: MonitoringOrder = {
      parentOrderId,
      monitoringOrderId,
      trend,
      amount,
      assetRic,
      isDemoAccount,
      isMartingale,
      martingaleStep,
      startTime: Date.now(),
      executionTime: Date.now(),
      lastCheckedTime: 0,
      webSocketResultReceived: false,
      isCompleted: false,
    };

    const key = `${userId}_${monitoringOrderId}`;
    this.activeMonitoring.set(key, monitoring);

    this.logger.log(
      `[${userId}] Monitoring started for order: ${monitoringOrderId}, trend: ${trend}, amount: ${amount}`,
    );
  }

  /**
   * Handle WebSocket trade update
   */
  handleWebSocketTradeUpdate(
    userId: string,
    message: any,
    onTradeResult: (result: TradeResult) => void,
  ): void {
    const event = message.event || '';
    const payload = message.payload || {};

    if (['closed', 'deal_result', 'trade_update'].includes(event)) {
      this.lastWebSocketUpdateTime = Date.now();

      const orderId = payload.id || '';
      const status = payload.status || '';
      const amount = payload.amount || 0;
      const trend = payload.trend || '';

      if (orderId && ['won', 'lost'].includes(status)) {
        this.processWebSocketResult(userId, orderId, status, amount, trend, payload, onTradeResult);
      }
    }
  }

  private setupWebSocketHandler(
    userId: string,
    wsClient: StockityWebSocketClient,
    onTradeResult: (result: TradeResult) => void,
  ): void {
    // Note: This assumes wsClient has an onMessage method
    // You may need to modify StockityWebSocketClient to support this
    if ((wsClient as any).onMessage) {
      (wsClient as any).onMessage((message: any) => {
        this.handleWebSocketTradeUpdate(userId, message, onTradeResult);
      });
    }
  }

  private async checkOrdersViaApi(
    userId: string,
    onTradeResult: (result: TradeResult) => void,
  ): Promise<void> {
    const currentTime = Date.now();
    const ordersToCheck: MonitoringOrder[] = [];
    const ordersToComplete: string[] = [];

    // Collect orders to check
    for (const [key, monitoring] of this.activeMonitoring) {
      if (!key.startsWith(`${userId}_`)) continue;

      if (monitoring.isCompleted) {
        ordersToComplete.push(key);
      } else if (currentTime - monitoring.startTime > this.MONITORING_TIMEOUT_MS) {
        this.logger.log(`[${userId}] Timeout for ${monitoring.monitoringOrderId}`);
        ordersToComplete.push(key);
      } else if (
        !monitoring.webSocketResultReceived ||
        currentTime - monitoring.executionTime > this.WEBSOCKET_PRIORITY_WINDOW_MS
      ) {
        ordersToCheck.push(monitoring);
      }
    }

    // Remove completed/timed out orders
    for (const key of ordersToComplete) {
      this.activeMonitoring.delete(key);
      const orderId = key.replace(`${userId}_`, '');
      this.processedResults.delete(`${userId}_${orderId}`);
    }

    if (ordersToCheck.length === 0) return;

    // Check orders via API
    await this.checkOrdersForUser(userId, ordersToCheck, onTradeResult);
  }

  private async checkOrdersForUser(
    userId: string,
    orders: MonitoringOrder[],
    onTradeResult: (result: TradeResult) => void,
  ): Promise<void> {
    // Note: This requires access to user session
    // You may need to pass session or auth token when calling this method
    this.logger.debug(`[${userId}] Checking ${orders.length} orders via API`);
  }

  private processWebSocketResult(
    userId: string,
    tradeId: string,
    status: string,
    amount: number,
    trend: string,
    payload: any,
    onTradeResult: (result: TradeResult) => void,
  ): void {
    // Find matching monitoring order
    let matchingMonitoring: MonitoringOrder | null = null;
    let matchingKey: string | null = null;

    for (const [key, monitoring] of this.activeMonitoring) {
      if (!key.startsWith(`${userId}_`)) continue;

      if (
        !monitoring.isCompleted &&
        monitoring.amount === amount &&
        monitoring.trend === trend &&
        Date.now() - monitoring.executionTime < 120000
      ) {
        matchingMonitoring = monitoring;
        matchingKey = key;
        break;
      }
    }

    if (matchingMonitoring && matchingKey) {
      // Update monitoring order
      this.activeMonitoring.set(matchingKey, {
        ...matchingMonitoring,
        webSocketResultReceived: true,
        isCompleted: true,
      });

      const isWin = status === 'won';
      this.processedResults.set(`${userId}_${matchingMonitoring.monitoringOrderId}`, tradeId);

      this.logger.log(
        `[${userId}] Trade result detected (WebSocket): ${matchingMonitoring.monitoringOrderId} - ${isWin ? 'WIN' : 'LOSE'}`,
      );

      const result: TradeResult = {
        parentOrderId: matchingMonitoring.parentOrderId,
        monitoringOrderId: matchingMonitoring.monitoringOrderId,
        isWin,
        isMartingale: matchingMonitoring.isMartingale,
        martingaleStep: matchingMonitoring.martingaleStep,
        details: new Map([
          ['trade_id', tradeId],
          ['amount', amount],
          ['trend', trend],
          ['status', status],
          ['win_amount', payload.win || 0],
          ['payment', payload.payment || 0],
          ['detection_method', 'ai_signal_monitor_websocket'],
          ['detection_time', Date.now()],
          ['monitoring_duration', Date.now() - matchingMonitoring.startTime],
        ]),
      };

      onTradeResult(result);
    }
  }

  /**
   * Fetch trade result from API (fallback when WebSocket fails)
   */
  async fetchTradeResultFromApi(
    session: any,
    config: AISignalConfig,
  ): Promise<any | null> {
    try {
      const response = await axios.get(
        `${this.BASE_URL}/profile/trading-history?type=${config.isDemoAccount ? 'demo' : 'real'}`,
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
    } catch (err: any) {
      this.logger.error(`Error fetching trade result: ${err?.message || err}`);
      return null;
    }
  }

  private buildStockityHeaders(session: any): Record<string, string> {
    return {
      'authorization-token': session.stockityToken,
      'device-id': session.deviceId,
      'device-type': session.deviceType || 'web',
      'user-timezone': session.userTimezone || 'Asia/Jakarta',
      'User-Agent': session.userAgent,
      Accept: 'application/json, text/plain, */*',
      Origin: 'https://stockity.id',
      Referer: 'https://stockity.id/',
    };
  }

  getMonitoringStatus(userId: string): any {
    const userOrders = Array.from(this.activeMonitoring.entries()).filter(([key]) =>
      key.startsWith(`${userId}_`),
    );

    return {
      is_active: this.monitoringIntervals.has(userId),
      active_monitoring_count: userOrders.length,
      monitoring_interval_ms: this.MONITORING_INTERVAL_MS,
      timeout_ms: this.MONITORING_TIMEOUT_MS,
      processed_results_count: this.processedResults.size,
    };
  }
}