import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { AISignalConfig, AISignalOrderStatus } from './types';
import { StockityWebSocketClient, DealResultPayload } from '../schedule/websocket-client';
import { curlGet } from '../common/http-utils';

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

  /** Loop utama: cek state (timeout/selesai). 200ms sudah lebih dari cukup. */
  private readonly MONITORING_INTERVAL_MS = 200;

  /**
   * Throttle HTTP call ke Stockity API. WebSocket = jalur utama (real-time).
   * API = fallback jika WS miss. 2000ms: responsif tapi tidak flood.
   * FIX (dari sesi 1): sebelumnya 50ms → 20 req/detik. Sekarang 0.5 req/detik.
   */
  private readonly API_POLL_INTERVAL_MS = 2000;

  private readonly MONITORING_TIMEOUT_MS = 90_000;
  private readonly WEBSOCKET_PRIORITY_WINDOW_MS = 2000;
  private readonly BASE_URL = 'https://api.stockity.id';

  /**
   * FIX performa: nested Map — O(1) akses per user.
   *
   * Sebelumnya: Map<"userId_orderId", MonitoringOrder>
   *   → setiap tick iterasi SEMUA entry dari SEMUA user, filter string prefix.
   *   → O(N×M) di mana N=user aktif, M=order per user.
   *
   * Sesudah: Map<userId, Map<orderId, MonitoringOrder>>
   *   → checkOrdersViaApi hanya iterasi Map user yang bersangkutan: O(M).
   *   → stopMonitoring hapus 1 entry: O(1), bukan O(semua entry).
   */
  private activeMonitoring = new Map<string, Map<string, MonitoringOrder>>();

  /** processedResults: cegah WS + API keduanya emit hasil untuk trade yang sama */
  private processedResults = new Map<string, string>();

  private monitoringIntervals = new Map<string, NodeJS.Timeout>();
  private lastApiCheckTime = new Map<string, number>();
  private userSessions = new Map<string, any>();
  private lastWebSocketUpdateTime = Date.now();

  onModuleDestroy() {
    for (const [userId, interval] of this.monitoringIntervals) {
      clearInterval(interval);
      this.logger.log(`Cleaned up monitoring for user: ${userId}`);
    }
    this.monitoringIntervals.clear();
    this.activeMonitoring.clear();
    this.processedResults.clear();
    this.lastApiCheckTime.clear();
    this.userSessions.clear();
  }

  setUserSession(userId: string, session: any): void {
    this.userSessions.set(userId, session);
  }

  private getUserSession(userId: string): any | null {
    return this.userSessions.get(userId) ?? null;
  }

  /** Helper: ambil/buat Map order untuk user tertentu */
  private getOrderMap(userId: string): Map<string, MonitoringOrder> {
    let map = this.activeMonitoring.get(userId);
    if (!map) {
      map = new Map();
      this.activeMonitoring.set(userId, map);
    }
    return map;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

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
    this.setupWebSocketHandler(userId, wsClient, onTradeResult);

    const interval = setInterval(async () => {
      await this.checkOrdersViaApi(userId, onTradeResult);
    }, this.MONITORING_INTERVAL_MS);

    this.monitoringIntervals.set(userId, interval);

    this.logger.log(
      `[${userId}] Monitoring started ` +
      `(loop: ${this.MONITORING_INTERVAL_MS}ms, API throttle: ${this.API_POLL_INTERVAL_MS}ms)`,
    );
  }

  stopMonitoring(userId: string): void {
    const interval = this.monitoringIntervals.get(userId);
    if (interval) {
      clearInterval(interval);
      this.monitoringIntervals.delete(userId);
    }

    // FIX performa: O(1) delete — sebelumnya O(n) loop dengan prefix-filter
    this.activeMonitoring.delete(userId);

    // Bersihkan processedResults untuk user ini
    for (const key of this.processedResults.keys()) {
      if (key.startsWith(`${userId}_`)) {
        this.processedResults.delete(key);
      }
    }

    this.lastApiCheckTime.delete(userId);
    this.userSessions.delete(userId);
    this.logger.log(`[${userId}] Monitoring stopped`);
  }

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

    // FIX performa: simpan ke nested Map, bukan flat Map dengan prefix key
    this.getOrderMap(userId).set(monitoringOrderId, monitoring);

    this.logger.log(
      `[${userId}] Monitoring order: ${monitoringOrderId}, trend: ${trend}, amount: ${amount}`,
    );
  }

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
        this.processWebSocketResult(
          userId, orderId, status, amount, trend, payload, onTradeResult,
        );
      }
    }
  }

  // ─── WebSocket handler ──────────────────────────────────────────────────────

  private setupWebSocketHandler(
    userId: string,
    wsClient: StockityWebSocketClient,
    onTradeResult: (result: TradeResult) => void,
  ): void {
    wsClient.setOnDealResult((payload: DealResultPayload) => {
      this.logger.debug(`[${userId}] Deal result via WS: ${JSON.stringify(payload)}`);

      const message = {
        event: payload.status ? 'deal_result' : 'closed',
        payload: {
          id:      payload.id,
          status:  payload.status,
          amount:  payload.amount,
          trend:   payload.trend,
          win:     payload.win,
          payment: payload.payment,
        },
      };

      this.handleWebSocketTradeUpdate(userId, message, onTradeResult);
    });

    this.logger.log(`[${userId}] WebSocket handler setup complete`);
  }

  // ─── API polling (fallback) ─────────────────────────────────────────────────

  /**
   * Cek status order via loop utama:
   *   1. Selesaikan order yang sudah completed / timeout
   *   2. Kumpulkan order yang perlu di-cek via API
   *   3. Throttle: hanya panggil HTTP jika sudah melewati API_POLL_INTERVAL_MS
   *
   * FIX performa: iterasi hanya orderMap milik userId ini (nested Map),
   *               bukan semua entry dari semua user.
   * FIX sesi 1: throttle API — sebelumnya dipanggil setiap 50ms tanpa batas.
   */
  private async checkOrdersViaApi(
    userId: string,
    onTradeResult: (result: TradeResult) => void,
  ): Promise<void> {
    const orderMap = this.activeMonitoring.get(userId);
    if (!orderMap || orderMap.size === 0) return;

    const currentTime = Date.now();
    const ordersToCheck: MonitoringOrder[] = [];
    const ordersToComplete: string[] = [];

    for (const [orderId, monitoring] of orderMap) {
      if (monitoring.isCompleted) {
        ordersToComplete.push(orderId);
      } else if (currentTime - monitoring.startTime > this.MONITORING_TIMEOUT_MS) {
        this.logger.warn(`[${userId}] Monitoring timeout for ${orderId}`);
        ordersToComplete.push(orderId);
      } else if (
        !monitoring.webSocketResultReceived ||
        currentTime - monitoring.executionTime > this.WEBSOCKET_PRIORITY_WINDOW_MS
      ) {
        ordersToCheck.push(monitoring);
      }
    }

    for (const orderId of ordersToComplete) {
      orderMap.delete(orderId);
      this.processedResults.delete(`${userId}_${orderId}`);
    }
    if (orderMap.size === 0) this.activeMonitoring.delete(userId);

    if (ordersToCheck.length === 0) return;

    // Throttle: HTTP call max 1× per API_POLL_INTERVAL_MS per user
    const lastCheck = this.lastApiCheckTime.get(userId) ?? 0;
    if (currentTime - lastCheck < this.API_POLL_INTERVAL_MS) return;
    this.lastApiCheckTime.set(userId, currentTime);

    await this.checkOrdersForUser(userId, ordersToCheck, onTradeResult);
  }

  /**
   * Panggil Stockity API untuk batch-check order yang belum ada hasil WS.
   *
   * FIX sesi 1 (dead code removed): endpoint yang benar = bo-deals-history.
   * FIX: gunakan finished_at (bukan created_at) untuk time-matching.
   * FIX: simpan trade.uuid (bukan trade.id numerik) agar konsisten.
   */
  private async checkOrdersForUser(
    userId: string,
    orders: MonitoringOrder[],
    onTradeResult: (result: TradeResult) => void,
  ): Promise<void> {
    if (orders.length === 0) return;

    this.logger.debug(`[${userId}] API fallback check for ${orders.length} order(s)`);

    const session = this.getUserSession(userId);
    if (!session) {
      this.logger.warn(`[${userId}] No session for API check`);
      return;
    }

    try {
      const accountType = orders[0].isDemoAccount ? 'demo' : 'real';
      const headers = this.buildStockityHeaders(session);
      const response = await curlGet(
        `${this.BASE_URL}/bo-deals-history/v3/deals/trade?type=${accountType}&locale=id`,
        headers,
        20,
      );

      if (!response?.data?.data) return;

      const trades: any[] = response.data.data.standard_trade_deals ?? [];

      for (const order of orders) {
        if (order.webSocketResultReceived || order.isCompleted) continue;

        const matchingTrade = this.findMatchingTrade(trades, order, userId);
        if (!matchingTrade) {
          // Update lastCheckedTime walaupun belum ada hasil
          const orderMap = this.activeMonitoring.get(userId);
          const existing = orderMap?.get(order.monitoringOrderId);
          if (existing) {
            orderMap!.set(order.monitoringOrderId, {
              ...existing,
              lastCheckedTime: Date.now(),
            });
          }
          continue;
        }

        this.logger.log(
          `[${userId}] Trade result via API: ${order.monitoringOrderId} — ` +
          `${matchingTrade.status?.toUpperCase()}`,
        );

        const isWin = matchingTrade.status?.toLowerCase() === 'won';
        const tradeUuid = matchingTrade.uuid ?? matchingTrade.id;

        const orderMap = this.activeMonitoring.get(userId);
        if (orderMap) {
          orderMap.set(order.monitoringOrderId, {
            ...order,
            lastCheckedTime: Date.now(),
            webSocketResultReceived: true,
            isCompleted: true,
          });
        }

        this.processedResults.set(`${userId}_${order.monitoringOrderId}`, tradeUuid);

        const result: TradeResult = {
          parentOrderId:     order.parentOrderId,
          monitoringOrderId: order.monitoringOrderId,
          isWin,
          isMartingale:      order.isMartingale,
          martingaleStep:    order.martingaleStep,
          details: new Map<string, any>([
            ['trade_id',         tradeUuid],
            ['amount',           matchingTrade.amount],
            ['trend',            matchingTrade.trend],
            ['status',           matchingTrade.status],
            ['win_amount',       matchingTrade.win ?? 0],
            ['payment_rate',     matchingTrade.payment_rate ?? 0],
            ['detection_method', 'ai_signal_monitor_api'],
            ['detection_time',   Date.now()],
            ['monitoring_duration', Date.now() - order.startTime],
          ]),
        };

        onTradeResult(result);
      }
    } catch (err: any) {
      this.logger.error(`[${userId}] API fallback error: ${err?.message ?? err}`);
    }
  }

  private findMatchingTrade(
    trades: any[],
    order: MonitoringOrder,
    userId: string,
  ): any | null {
    const recentTimeThreshold = Date.now() - 120_000;

    for (const trade of trades) {
      const finishedAt = trade.finished_at
        ? new Date(trade.finished_at).getTime()
        : new Date(trade.created_at).getTime();

      const amountMatch   = Math.abs(trade.amount - order.amount) < 100;
      const trendMatch    = trade.trend?.toLowerCase() === order.trend.toLowerCase();
      const isCompleted   = ['won', 'lost', 'equal'].includes(trade.status?.toLowerCase());
      const isRecent      = finishedAt >= recentTimeThreshold;

      const tradeUuid = trade.uuid ?? trade.id;
      const isNotProcessed =
        tradeUuid !== this.processedResults.get(`${userId}_${order.monitoringOrderId}`);

      if (isRecent && amountMatch && trendMatch && isCompleted && isNotProcessed) {
        return trade;
      }
    }
    return null;
  }

  // ─── WebSocket result processing ───────────────────────────────────────────

  private processWebSocketResult(
    userId: string,
    tradeId: string,
    status: string,
    amount: number,
    trend: string,
    payload: any,
    onTradeResult: (result: TradeResult) => void,
  ): void {
    // FIX performa: iterasi hanya orderMap milik userId, bukan semua entry
    const orderMap = this.activeMonitoring.get(userId);
    if (!orderMap) return;

    let matchingMonitoring: MonitoringOrder | null = null;
    let matchingOrderId: string | null = null;

    for (const [orderId, monitoring] of orderMap) {
      if (
        !monitoring.isCompleted &&
        monitoring.amount === amount &&
        monitoring.trend === trend &&
        Date.now() - monitoring.executionTime < 120_000
      ) {
        matchingMonitoring = monitoring;
        matchingOrderId = orderId;
        break;
      }
    }

    if (!matchingMonitoring || !matchingOrderId) return;

    orderMap.set(matchingOrderId, {
      ...matchingMonitoring,
      webSocketResultReceived: true,
      isCompleted: true,
    });

    const isWin = status === 'won';
    this.processedResults.set(
      `${userId}_${matchingMonitoring.monitoringOrderId}`,
      tradeId,
    );

    this.logger.log(
      `[${userId}] Trade result via WS: ${matchingMonitoring.monitoringOrderId} — ` +
      `${isWin ? 'WIN' : 'LOSE'}`,
    );

    const result: TradeResult = {
      parentOrderId:     matchingMonitoring.parentOrderId,
      monitoringOrderId: matchingMonitoring.monitoringOrderId,
      isWin,
      isMartingale:      matchingMonitoring.isMartingale,
      martingaleStep:    matchingMonitoring.martingaleStep,
      details: new Map<string, any>([
        ['trade_id',         tradeId],
        ['amount',           amount],
        ['trend',            trend],
        ['status',           status],
        ['win_amount',       payload.win ?? 0],
        ['payment',          payload.payment ?? 0],
        ['detection_method', 'ai_signal_monitor_websocket'],
        ['detection_time',   Date.now()],
        ['monitoring_duration', Date.now() - matchingMonitoring.startTime],
      ]),
    };

    onTradeResult(result);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private buildStockityHeaders(session: any): Record<string, string> {
    return {
      'authorization-token': session.stockity_token,
      'device-id':           session.device_id,
      'device-type':         session.device_type ?? 'web',
      'user-timezone':       session.user_timezone ?? 'Asia/Jakarta',
      'User-Agent':          session.user_agent,
      'Accept':              'application/json, text/plain, */*',
      'Origin':              'https://stockity.id',
      'Referer':             'https://stockity.id/',
    };
  }

  getMonitoringStatus(userId: string): object {
    const orderMap = this.activeMonitoring.get(userId);
    return {
      is_active:              this.monitoringIntervals.has(userId),
      active_monitoring_count: orderMap?.size ?? 0,
      monitoring_interval_ms: this.MONITORING_INTERVAL_MS,
      api_poll_interval_ms:   this.API_POLL_INTERVAL_MS,
      timeout_ms:             this.MONITORING_TIMEOUT_MS,
      processed_results_count: this.processedResults.size,
      last_api_check_ago_ms:  this.lastApiCheckTime.has(userId)
        ? Date.now() - this.lastApiCheckTime.get(userId)!
        : null,
    };
  }
}