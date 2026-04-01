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

// Format pesan sesuai Kotlin: JSON object {topic, event, payload, ref}
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

  // pending trade: ref → { resolve, timer }
  private pendingTrades: Map<number, { resolve: (dealId: string | null) => void; timer: NodeJS.Timeout }> = new Map();

  private onDealResultCb?: (payload: DealResultPayload) => void;
  private onStatusChangeCb?: (connected: boolean, reason?: string) => void;

  // Channels sesuai Kotlin: connection, tournament, user, cfd_zero_spread, bo, asset, account
  private readonly CHANNELS = ['connection', 'tournament', 'user', 'cfd_zero_spread', 'bo', 'asset', 'account'];
  private readonly REQUIRED_CHANNELS = new Set(['bo', 'account', 'asset']);

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

  private getRef(): number {
    return this.refCounter++;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.isDestroyed) return reject(new Error('Client sudah di-destroy'));

      try {
        // URL benar sesuai Kotlin: wss://ws.stockity.id/?v=2&vsn=2.0.0
        // Auth via Cookie header sesuai Kotlin, BUKAN query param
        this.ws = new WebSocket('wss://ws.stockity.id/?v=2&vsn=2.0.0', {
          headers: {
            'User-Agent': this.userAgent,
            'Origin': 'https://stockity.id',
            'Cookie': `authtoken=${this.authToken}; device_type=${this.deviceType}; device_id=${this.deviceId}`,
            'Sec-WebSocket-Protocol': 'phoenix',
            'Cache-Control': 'no-cache',
          },
          handshakeTimeout: 15000,
        });

        const connectTimeout = setTimeout(() => {
          reject(new Error('WebSocket connection timeout'));
          this.ws?.terminate();
        }, 20000);

        this.ws.on('open', async () => {
          clearTimeout(connectTimeout);
          this.reconnectAttempts = 0;
          this.logger.log(`[${this.userId}] ✅ WebSocket connected`);
          this.onStatusChangeCb?.(true, 'Connected to Stockity WebSocket');

          // Sesuai Kotlin: delay 1 detik setelah open, lalu join channels
          await this.sleep(1000);
          await this.joinChannelsWithRetry();
          this.startHeartbeat();

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

  // Join semua channel sesuai Kotlin, dengan delay 800ms antar channel
  private async joinChannelsWithRetry() {
    this.joinedChannels.clear();
    let retryCount = 0;
    const maxRetries = 3;

    while (retryCount < maxRetries) {
      for (const channel of this.CHANNELS) {
        if (this.isDestroyed || !this.ws) break;
        if (this.joinedChannels.has(channel)) continue;

        // Payload join sesuai Kotlin: empty payload {}
        const sent = this.sendMsg({
          topic: channel,
          event: 'phx_join',
          payload: {},
          ref: this.getRef(),
        });

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

    // Minimal: bo + account
    const hasEssential = ['bo', 'account'].every(c => this.joinedChannels.has(c));
    if (hasEssential) {
      this.logger.log(`[${this.userId}] Essential channels available`);
      this.onStatusChangeCb?.(true, 'Connected with essential channels');
    } else {
      this.logger.error(`[${this.userId}] ❌ Failed to join essential channels`);
    }
  }

  // Format pesan sesuai Kotlin: JSON object {topic, event, payload, ref}
  // BUKAN array [null, ref, topic, event, payload]
  private sendMsg(msg: WsMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify({
        topic: msg.topic,
        event: msg.event,
        payload: msg.payload,
        ref: msg.ref,
      }));
      return true;
    } catch {
      return false;
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    // Heartbeat sesuai Kotlin: topic=phoenix, event=heartbeat, interval=25 detik
    this.heartbeatTimer = setInterval(() => {
      this.sendMsg({
        topic: 'phoenix',
        event: 'heartbeat',
        payload: {},
        ref: this.getRef(),
      });
    }, this.HEARTBEAT_INTERVAL_MS);
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
    const delay = Math.min(1500 * Math.pow(2, Math.min(this.reconnectAttempts - 1, 5)), 45000);
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
      // Sesuai Kotlin: parse sebagai JSON object {topic, event, payload, ref}
      const msg = JSON.parse(raw);
      const event: string = msg.event ?? '';
      const topic: string = msg.topic ?? '';
      const payload: any = msg.payload ?? {};
      const ref: number = msg.ref ?? -1;

      // phx_reply → cek trade response atau heartbeat
      if (event === 'phx_reply') {
        if (topic === 'phoenix') return; // heartbeat reply, abaikan

        const status = payload?.status;
        const response = payload?.response;

        if (status === 'ok' && response?.id) {
          const pending = this.pendingTrades.get(ref);
          if (pending) {
            clearTimeout(pending.timer);
            pending.resolve(response.id);
            this.pendingTrades.delete(ref);
            this.logger.log(`[${this.userId}] ✅ Trade placed: dealId=${response.id}`);
          }
        } else if (status === 'error') {
          const pending = this.pendingTrades.get(ref);
          if (pending) {
            clearTimeout(pending.timer);
            pending.resolve(null);
            this.pendingTrades.delete(ref);
            this.logger.warn(`[${this.userId}] Trade error: ${JSON.stringify(response)}`);
          }
        }
        return;
      }

      // Hasil trade sesuai Kotlin: opened, closed, deal_result, close_deal_batch pada topic "bo"
      if (topic === 'bo' && payload) {
        if (['opened', 'closed', 'deal_result', 'close_deal_batch'].includes(event)) {
          this.logger.debug(`[${this.userId}] Trade event: ${event} id=${payload.id}`);
          this.onDealResultCb?.(payload);
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

      // Format trade sesuai Kotlin TradeManager.executeTradeOrder
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

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  isRequiredChannelsReady(): boolean {
    return [...this.REQUIRED_CHANNELS].every(c => this.joinedChannels.has(c));
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

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}