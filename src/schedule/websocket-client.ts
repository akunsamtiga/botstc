import WebSocket from 'ws';
import { Logger } from '@nestjs/common';
import { TradeOrderData } from './types';

export interface DealResultPayload {
  id: string;          // primary id: uuid untuk closed/deal_result
  numericId?: string;  // numeric id dari payload.id (bo:opened)
  uuid?: string;       // uuid dari payload.uuid (bo:closed)
  status?: string;
  result?: string;
  trend?: string;
  amount?: number;
  win?: number;
  [key: string]: any;
}

interface WsMessage {
  topic: string;
  event: string;
  payload: Record<string, any>;
  ref: number | null;
}

export class StockityWebSocketClient {
  private readonly logger = new Logger('StockityWS');
  private ws: WebSocket | null = null;
  private refCounter = 1;
  private joinedChannels = new Set<string>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT = 10;
  private readonly HEARTBEAT_INTERVAL_MS = 25000;
  private readonly CHANNEL_JOIN_DELAY_MS = 800;
  private isDestroyed = false;

  /**
   * Resolved with:
   *   { id: string }        — trade placed successfully
   *   { id: null, reasons } — rejected by server (e.g. deal_amount_min)
   *   null                  — timeout or WS not open
   */
  private pendingTrades: Map<number, {
    resolve: (result: { id: string | null; reasons?: Array<{ field: string; validation: string }> }) => void;
    timer: NodeJS.Timeout;
  }> = new Map();

  private onDealResultCb?: (payload: DealResultPayload) => void;
  private onStatusChangeCb?: (connected: boolean, reason?: string) => void;

  private readonly CHANNELS = ['connection', 'tournament', 'user', 'cfd_zero_spread', 'bo', 'asset', 'account'];
  private readonly REQUIRED_CHANNELS = new Set(['bo', 'account', 'asset']);

  constructor(
    private readonly userId: string,
    private readonly authToken: string,
    private readonly deviceId: string,
    private readonly deviceType: string,
    private readonly userAgent: string,
  ) {}

  setOnDealResult(cb: (payload: DealResultPayload) => void) { this.onDealResultCb = cb; }
  setOnStatusChange(cb: (connected: boolean, reason?: string) => void) { this.onStatusChangeCb = cb; }
  private getRef(): number { return this.refCounter++; }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.isDestroyed) return reject(new Error('Client sudah di-destroy'));

      let settled = false;
      const doResolve = () => { if (!settled) { settled = true; resolve(); } };
      const doReject = (err: Error) => { if (!settled) { settled = true; reject(err); } };

      try {
        this.ws = new WebSocket('wss://ws.stockity.id/?v=2&vsn=2.0.0', {
          headers: {
            'authorization-token': this.authToken,
            'device-id': this.deviceId,
            'device-type': this.deviceType,
            'user-timezone': 'Asia/Jakarta',
            'User-Agent': this.userAgent,
            'Origin': 'https://stockity.id',
            'Referer': 'https://stockity.id/',
            'Cookie': `authtoken=${this.authToken}; device_type=${this.deviceType}; device_id=${this.deviceId}`,
            'Cache-Control': 'no-cache',
          },
          handshakeTimeout: 15000,
        });

        const connectTimeout = setTimeout(() => {
          doReject(new Error('WebSocket connection timeout'));
          this.ws?.terminate();
        }, 20000);

        this.ws.on('open', async () => {
          clearTimeout(connectTimeout);
          this.reconnectAttempts = 0;
          this.logger.log(`[${this.userId}] ✅ WebSocket connected`);
          this.onStatusChangeCb?.(true, 'Connected to Stockity WebSocket');
          await this.sleep(1000);
          await this.joinChannelsWithRetry();
          this.startHeartbeat();
          doResolve();
        });

        this.ws.on('message', (raw: Buffer | string) => { this.handleMessage(raw.toString()); });

        this.ws.on('error', (err) => {
          this.logger.error(`[${this.userId}] WS error: ${err.message}`);
          this.onStatusChangeCb?.(false, err.message);
          clearTimeout(connectTimeout);
          doReject(err);
        });

        this.ws.on('close', (code, reason) => {
          this.logger.warn(`[${this.userId}] WS closed: ${code} ${reason?.toString()}`);
          this.stopHeartbeat();
          this.onStatusChangeCb?.(false, `Closed: ${code}`);
          if (!this.isDestroyed && settled) this.scheduleReconnect();
        });

      } catch (err) { doReject(err as Error); }
    });
  }

  private async joinChannelsWithRetry() {
    this.joinedChannels.clear();
    let retryCount = 0;
    const maxRetries = 3;

    while (retryCount < maxRetries) {
      for (const channel of this.CHANNELS) {
        if (this.isDestroyed || !this.ws) break;
        if (this.joinedChannels.has(channel)) continue;

        const sent = this.sendMsg({ topic: channel, event: 'phx_join', payload: {}, ref: this.getRef() });
        if (sent) {
          this.joinedChannels.add(channel);
          await this.sleep(this.CHANNEL_JOIN_DELAY_MS);
        } else {
          this.logger.warn(`[${this.userId}] Failed to join channel: ${channel}`);
        }
      }

      const hasRequired = [...this.REQUIRED_CHANNELS].every(c => this.joinedChannels.has(c));
      if (hasRequired) {
        this.logger.log(`[${this.userId}] ✅ All required channels joined: ${[...this.joinedChannels].join(', ')}`);
        this.onStatusChangeCb?.(true, 'Ready for automated trading');
        return;
      }

      retryCount++;
      this.logger.warn(`[${this.userId}] Not all required channels joined (attempt ${retryCount}/${maxRetries})`);
      if (retryCount < maxRetries) await this.sleep(2000);
    }

    const hasEssential = ['bo', 'account'].every(c => this.joinedChannels.has(c));
    if (hasEssential) {
      this.logger.log(`[${this.userId}] Essential channels available`);
      this.onStatusChangeCb?.(true, 'Connected with essential channels');
    } else {
      this.logger.error(`[${this.userId}] ❌ Failed to join essential channels`);
    }
  }

  private sendMsg(msg: WsMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify({ topic: msg.topic, event: msg.event, payload: msg.payload, ref: msg.ref }));
      return true;
    } catch { return false; }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendMsg({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: this.getRef() });
    }, this.HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  private scheduleReconnect() {
    if (this.isDestroyed) return;
    if (this.reconnectAttempts >= this.MAX_RECONNECT) {
      this.logger.error(`[${this.userId}] Max reconnect attempts reached`);
      this.onStatusChangeCb?.(false, 'Max reconnect attempts reached');
      return;
    }
    const delay = Math.min(1500 * Math.pow(2, Math.min(this.reconnectAttempts, 5)), 45000);
    this.reconnectAttempts++;
    this.logger.log(`[${this.userId}] Reconnect in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(async () => {
      try {
        this.joinedChannels.clear();
        await this.connect();
      } catch (err: any) {
        this.logger.error(`[${this.userId}] Reconnect failed: ${err.message}`);
      }
    }, delay);
  }

  private handleMessage(raw: string) {
    try {
      const msg = JSON.parse(raw);
      const event: string = msg.event ?? '';
      const topic: string = msg.topic ?? '';
      const payload: any = msg.payload ?? {};
      const ref: number = msg.ref ?? -1;

      // ── phx_reply ────────────────────────────────────────────────────────
      if (event === 'phx_reply') {
        if (topic === 'phoenix') return;
        const status = payload?.status;
        const response = payload?.response;

        if (status === 'ok' && response?.id) {
          const pending = this.pendingTrades.get(ref);
          if (pending) {
            clearTimeout(pending.timer);
            pending.resolve({ id: String(response.id) });
            this.pendingTrades.delete(ref);
            this.logger.log(`[${this.userId}] ✅ Trade placed (phx_reply): dealId=${response.id}`);
          }
        } else if (status === 'error') {
          const pending = this.pendingTrades.get(ref);
          if (pending) {
            clearTimeout(pending.timer);
            const reasons: Array<{ field: string; validation: string }> =
              response?.reasons ?? [];
            pending.resolve({ id: null, reasons });
            this.pendingTrades.delete(ref);
            this.logger.warn(`[${this.userId}] Trade error: ${JSON.stringify(response)}`);
          }
        }
        return;
      }

      if (topic !== 'bo' || !payload) return;
      if (!['opened', 'closed', 'deal_result', 'close_deal_batch'].includes(event)) return;

      // ── close_deal_batch ─────────────────────────────────────────────────
      if (event === 'close_deal_batch') {
        const deals: any[] = payload.deals || payload.data || [];
        for (const deal of deals) {
          const numericId: string | undefined = deal.id != null ? String(deal.id) : undefined;
          const uuidStr: string | undefined = deal.uuid ?? deal.deal_id ?? deal.dealId;
          const dealId = uuidStr ?? numericId;
          if (dealId) {
            this.logger.debug(`[${this.userId}] Trade event: close_deal_batch id=${dealId}`);
            this.onDealResultCb?.({ ...deal, id: dealId, numericId, uuid: uuidStr });
          }
        }
        return;
      }

      // ─────────────────────────────────────────────────────────────────────
      // STOCKITY DUAL-ID SYSTEM:
      //   bo:opened  → payload.id = numeric (4643345638), tidak ada uuid
      //   bo:closed  → payload.uuid = UUID string, tidak ada numeric id
      //
      // FIX: bo:opened hanya digunakan untuk resolve pendingTrade (activeDealId).
      //      TIDAK di-emit ke executor — mencegah false-match karena opened
      //      tidak punya status "won"/"lost", sama seperti Kotlin yang hanya
      //      handle "closed"/"deal_result"/"trade_update" di isWebSocketTradeMatch.
      //
      //      bo:closed → emit ke executor dengan uuid sebagai primary id.
      //      Executor pakai fallback matching (amount + trend + 120s window).
      // ─────────────────────────────────────────────────────────────────────

      const numericId: string | undefined = payload.id != null ? String(payload.id) : undefined;
      const uuidStr: string | undefined = payload.uuid ?? payload.deal_id ?? payload.dealId;

      if (event === 'opened') {
        // Hanya resolve pendingTrade — TIDAK emit ke onDealResultCb
        const dealId = numericId ?? uuidStr;
        this.logger.debug(`[${this.userId}] Trade event: opened numeric=${numericId} (pendingTrade resolve only)`);

        if (dealId && this.pendingTrades.size > 0) {
          const oldestRef = Math.min(...this.pendingTrades.keys());
          const pending = this.pendingTrades.get(oldestRef);
          if (pending) {
            clearTimeout(pending.timer);
            pending.resolve({ id: String(dealId) });
            this.pendingTrades.delete(oldestRef);
            this.logger.log(`[${this.userId}] ✅ Trade confirmed via bo:opened: dealId=${dealId}`);
          }
        }
        return; // ← TIDAK lanjut ke onDealResultCb
      }

      // closed / deal_result → uuid sebagai primary id
      const dealId = uuidStr ?? numericId;
      this.logger.debug(`[${this.userId}] Trade event: ${event} uuid=${uuidStr} numeric=${numericId}`);

      if (dealId) {
        this.onDealResultCb?.({ ...payload, id: String(dealId), numericId, uuid: uuidStr });
      } else {
        this.logger.warn(
          `[${this.userId}] ${event} payload missing id: ${JSON.stringify(payload).slice(0, 300)}`,
        );
      }

    } catch {
      // ignore non-JSON
    }
  }

  async placeTrade(order: TradeOrderData): Promise<{ id: string | null; reasons?: Array<{ field: string; validation: string }> } | null> {
    const ref = this.getRef();

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingTrades.delete(ref);
        this.logger.warn(`[${this.userId}] Trade timeout ref=${ref}`);
        resolve(null);
      }, 8000);

      this.pendingTrades.set(ref, { resolve, timer });

      const sent = this.sendMsg({
        topic: 'bo',
        event: 'create',
        payload: {
          amount: order.amount,
          created_at: order.createdAt,
          deal_type: order.dealType,
          expire_at: order.expireAt,
          iso: order.iso,
          option_type: order.optionType,
          ric: order.ric,
          trend: order.trend,
        },
        ref,
      });

      if (!sent) {
        clearTimeout(timer);
        this.pendingTrades.delete(ref);
        this.logger.error(`[${this.userId}] WS tidak open, tidak bisa place trade`);
        resolve(null);
      }
    });
  }

  isConnected(): boolean { return this.ws?.readyState === WebSocket.OPEN; }
  isRequiredChannelsReady(): boolean { return [...this.REQUIRED_CHANNELS].every(c => this.joinedChannels.has(c)); }

  disconnect() {
    this.isDestroyed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    for (const [, pending] of this.pendingTrades.entries()) {
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    this.pendingTrades.clear();
    this.ws?.close();
    this.ws = null;
    this.logger.log(`[${this.userId}] WebSocket disconnected`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}