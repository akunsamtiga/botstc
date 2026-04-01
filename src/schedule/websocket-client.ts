import * as WebSocket from 'ws';
import { Logger } from '@nestjs/common';
import { TradeOrderData } from './types';

export interface DealResultPayload {
  id: string;
  status?: string;
  result?: string;
  trend?: string;
  amount?: number;
  win?: number;
  [key: string]: any;
}

export class StockityWebSocketClient {
  private readonly logger = new Logger('StockityWS');
  private ws: WebSocket | null = null;
  private refCounter = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT = 10;
  private isDestroyed = false;

  private pendingTrades: Map<
    string,
    { resolve: (dealId: string | null) => void; timer: NodeJS.Timeout }
  > = new Map();

  private onDealResultCb?: (payload: DealResultPayload) => void;
  private onStatusChangeCb?: (connected: boolean, reason?: string) => void;

  constructor(
    private readonly userId: string,
    private readonly authToken: string,
    private readonly deviceId: string,
    private readonly deviceType: string,
    private readonly userAgent: string,
  ) {}

  setOnDealResult(cb: (payload: DealResultPayload) => void) {
    this.onDealResultCb = cb;
  }

  setOnStatusChange(cb: (connected: boolean, reason?: string) => void) {
    this.onStatusChangeCb = cb;
  }

  private getRef(): string {
    return String(++this.refCounter);
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.isDestroyed) return reject(new Error('Client sudah di-destroy'));

      try {
        this.ws = new WebSocket('wss://ws.stockity.id/?v=2&vsn=2.0.0', {
          headers: {
            'User-Agent': this.userAgent,
            'Sec-WebSocket-Protocol': 'phoenix',
            Origin: 'https://stockity.id',
            'Cache-Control': 'no-cache',
            Pragma: 'no-cache',
          },
          handshakeTimeout: 15000,
        });

        const connectTimeout = setTimeout(() => {
          reject(new Error('WebSocket connection timeout'));
          this.ws?.terminate();
        }, 20000);

        this.ws.on('open', () => {
          clearTimeout(connectTimeout);
          this.reconnectAttempts = 0;
          this.logger.log(`[${this.userId}] ✅ WebSocket connected`);
          this.joinChannels();
          this.startHeartbeat();
          this.onStatusChangeCb?.(true);
          resolve();
        });

        this.ws.on('message', (raw: Buffer | string) => {
          this.handleMessage(raw.toString());
        });

        this.ws.on('error', (err) => {
          this.logger.error(`[${this.userId}] WS error: ${err.message}`);
          this.onStatusChangeCb?.(false, err.message);
          clearTimeout(connectTimeout);
          reject(err);
        });

        this.ws.on('close', (code, reason) => {
          this.logger.warn(`[${this.userId}] WS closed: ${code} ${reason?.toString()}`);
          this.stopHeartbeat();
          this.onStatusChangeCb?.(false, `Closed: ${code}`);
          if (!this.isDestroyed) this.scheduleReconnect();
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  private joinChannels() {
    this.sendRaw(['1', '1', `user:${this.userId}`, 'phx_join', { token: this.authToken }]);
    this.sendRaw(['2', '2', 'bo', 'phx_join', { token: this.authToken }]);
  }

  private sendRaw(msg: any[]): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendRaw([null, this.getRef(), 'phoenix', 'heartbeat', {}]);
    }, 30000);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect() {
    if (this.isDestroyed) return;
    if (this.reconnectAttempts >= this.MAX_RECONNECT) {
      this.logger.error(`[${this.userId}] Max reconnect attempts reached`);
      return;
    }
    const delay = Math.min(2000 * Math.pow(1.5, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;
    this.logger.log(`[${this.userId}] Reconnect in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch (err: any) {
        this.logger.error(`[${this.userId}] Reconnect failed: ${err.message}`);
      }
    }, delay);
  }

  private handleMessage(raw: string) {
    try {
      const msg = JSON.parse(raw);
      if (!Array.isArray(msg) || msg.length < 5) return;
      const [, ref, topic, event, payload] = msg;

      // Deal result dari user channel
      if (topic === `user:${this.userId}` && event === 'deal' && payload) {
        this.logger.debug(`[${this.userId}] Deal result: ${payload.id} → ${payload.status || payload.result}`);
        this.onDealResultCb?.(payload);
      }

      // Reply sukses placement trade
      if (event === 'phx_reply' && payload?.status === 'ok' && ref) {
        const dealId = payload?.response?.id;
        if (dealId) {
          const pending = this.pendingTrades.get(ref);
          if (pending) {
            clearTimeout(pending.timer);
            pending.resolve(dealId);
            this.pendingTrades.delete(ref);
            this.logger.log(`[${this.userId}] Trade placed: dealId=${dealId}`);
          }
        }
      }

      // Error reply
      if (event === 'phx_reply' && payload?.status === 'error' && ref) {
        const pending = this.pendingTrades.get(ref);
        if (pending) {
          clearTimeout(pending.timer);
          pending.resolve(null);
          this.pendingTrades.delete(ref);
          this.logger.warn(`[${this.userId}] Trade error: ${JSON.stringify(payload.response)}`);
        }
      }
    } catch {
      // ignore non-JSON
    }
  }

  async placeTrade(order: TradeOrderData): Promise<string | null> {
    const ref = this.getRef();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingTrades.delete(ref);
        this.logger.warn(`[${this.userId}] Trade timeout ref=${ref}`);
        resolve(null);
      }, 8000);

      this.pendingTrades.set(ref, { resolve, timer });

      const sent = this.sendRaw([
        null, ref, 'bo', 'create',
        {
          amount: order.amount,
          created_at: order.createdAt,
          deal_type: order.dealType,
          expire_at: order.expireAt,
          iso: order.iso,
          option_type: order.optionType,
          ric: order.ric,
          trend: order.trend,
        },
      ]);

      if (!sent) {
        clearTimeout(timer);
        this.pendingTrades.delete(ref);
        this.logger.error(`[${this.userId}] WS tidak open, tidak bisa place trade`);
        resolve(null);
      }
    });
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  disconnect() {
    this.isDestroyed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const [, pending] of this.pendingTrades.entries()) {
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    this.pendingTrades.clear();
    this.ws?.close();
    this.ws = null;
    this.logger.log(`[${this.userId}] WebSocket disconnected`);
  }
}
