import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';
import { AuthService } from '../auth/auth.service';
import { StockityWebSocketClient } from '../schedule/websocket-client';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import {
  AISignalOrderStatus,
  TelegramSignal,
  AISignalOrder,
  AlwaysSignalLossState,
  MartingaleSequenceInfo,
  AISignalConfig,
  EXECUTION_CHECK_INTERVAL_MS,
  EXECUTION_ADVANCE_MS,
} from './types';

const BASE_URL = 'https://api.stockity.id';

@Injectable()
export class AISignalService implements OnModuleDestroy {
  private readonly logger = new Logger(AISignalService.name);
  private configs = new Map<string, AISignalConfig>();
  private activeModes = new Map<string, {
    isActive: boolean;
    wsClient: StockityWebSocketClient;
    pendingOrders: AISignalOrder[];
    executedOrdersMap: Map<string, AISignalOrder>;
    activeMartingaleOrders: Map<string, MartingaleSequenceInfo>;
    alwaysSignalLossTracking: AlwaysSignalLossState | null;
    executionInterval?: NodeJS.Timeout;
    processedOrderIds: Set<string>;
  }>();

  constructor(
    private readonly firebaseService: FirebaseService,
    private readonly authService: AuthService,
  ) {}

  onModuleDestroy() {
    for (const [userId, mode] of this.activeModes) {
      this.stopAISignalMode(userId);
    }
  }

  // ==================== CONFIG ====================

  async getConfig(userId: string): Promise<AISignalConfig> {
    if (this.configs.has(userId)) return this.configs.get(userId)!;

    const doc = await this.firebaseService.db.collection('aisignal_configs').doc(userId).get();
    if (doc.exists) {
      const d = doc.data() as any;
      const cfg: AISignalConfig = {
        asset: d.asset || null,
        baseAmount: d.baseAmount || 1400000,
        martingale: d.martingale || {
          isEnabled: true,
          maxSteps: 2,
          multiplierValue: 2.5,
          multiplierType: 'FIXED',
          isAlwaysSignal: false,
        },
        isDemoAccount: d.isDemoAccount ?? true,
        currency: d.currency || 'IDR',
      };
      this.configs.set(userId, cfg);
      return cfg;
    }

    const def: AISignalConfig = {
      asset: null,
      baseAmount: 1400000,
      martingale: {
        isEnabled: true,
        maxSteps: 2,
        multiplierValue: 2.5,
        multiplierType: 'FIXED',
        isAlwaysSignal: false,
      },
      isDemoAccount: true,
      currency: 'IDR',
    };
    this.configs.set(userId, def);
    return def;
  }

  async updateConfig(userId: string, dto: Partial<AISignalConfig>): Promise<AISignalConfig> {
    const current = await this.getConfig(userId);
    const updated = { ...current, ...dto };
    this.configs.set(userId, updated);

    const plainCfg = JSON.parse(JSON.stringify(updated));
    await this.firebaseService.db.collection('aisignal_configs').doc(userId).set(
      { ...plainCfg, updatedAt: this.firebaseService.FieldValue.serverTimestamp() },
      { merge: true },
    );

    return updated;
  }

  // ==================== AI SIGNAL MODE CONTROL ====================

  async startAISignalMode(userId: string): Promise<{ message: string; status: string }> {
    const existing = this.activeModes.get(userId);
    if (existing?.isActive) {
      return { message: 'AI Signal mode sudah berjalan', status: 'RUNNING' };
    }

    const session = await this.authService.getSession(userId);
    if (!session) throw new Error('Session tidak ditemukan');

    const config = await this.getConfig(userId);
    if (!config.asset?.ric) {
      throw new Error('Asset belum dikonfigurasi');
    }

    const ws = new StockityWebSocketClient(
      userId,
      session.stockityToken,
      session.deviceId,
      session.deviceType || 'web',
      session.userAgent,
    );

    try {
      await ws.connect();
    } catch (err: any) {
      ws.disconnect();
      throw new Error(`Gagal koneksi WebSocket: ${err.message}`);
    }

    this.activeModes.set(userId, {
      isActive: true,
      wsClient: ws,
      pendingOrders: [],
      executedOrdersMap: new Map(),
      activeMartingaleOrders: new Map(),
      alwaysSignalLossTracking: null,
      processedOrderIds: new Set(),
    });

    // Start execution monitoring
    this.startExecutionMonitoring(userId, config, session);

    await this.updateStatus(userId, 'RUNNING');
    this.logger.log(`[${userId}] AI Signal mode started`);

    return { message: 'AI Signal mode dimulai', status: 'RUNNING' };
  }

  async stopAISignalMode(userId: string): Promise<{ message: string }> {
    const mode = this.activeModes.get(userId);
    if (!mode?.isActive) {
      return { message: 'AI Signal mode tidak berjalan' };
    }

    mode.isActive = false;
    if (mode.executionInterval) {
      clearInterval(mode.executionInterval);
    }
    mode.wsClient.disconnect();
    this.activeModes.delete(userId);

    await this.updateStatus(userId, 'STOPPED');
    this.logger.log(`[${userId}] AI Signal mode stopped`);

    return { message: 'AI Signal mode dihentikan' };
  }

  async getStatus(userId: string): Promise<object> {
    const mode = this.activeModes.get(userId);
    const config = await this.getConfig(userId);

    if (mode) {
      const pendingCount = mode.pendingOrders.filter((o) => !o.isExecuted).length;
      const executedCount = mode.pendingOrders.filter((o) => o.isExecuted).length;

      return {
        isActive: mode.isActive,
        botState: 'RUNNING',
        totalOrders: mode.pendingOrders.length,
        pendingOrders: pendingCount,
        executedOrders: executedCount,
        activeMartingaleSequences: mode.activeMartingaleOrders.size,
        wsConnected: mode.wsClient.isConnected(),
        alwaysSignalStatus: this.getAlwaysSignalStatus(mode, config),
        config,
      };
    }

    const statusDoc = await this.firebaseService.db.collection('aisignal_status').doc(userId).get();
    return {
      isActive: false,
      botState: statusDoc.exists ? (statusDoc.data()?.botState ?? 'STOPPED') : 'STOPPED',
      config,
    };
  }

  private getAlwaysSignalStatus(mode: any, config: AISignalConfig): object {
    if (!config.martingale.isAlwaysSignal || !mode.alwaysSignalLossTracking) {
      return { isActive: false, status: 'No outstanding loss' };
    }

    const lossState = mode.alwaysSignalLossTracking;
    if (!lossState.hasOutstandingLoss) {
      return { isActive: false, status: 'No outstanding loss' };
    }

    return {
      isActive: true,
      currentStep: lossState.currentMartingaleStep,
      maxSteps: config.martingale.maxSteps,
      totalLoss: lossState.totalLoss,
      status: `Waiting for next signal (Step ${lossState.currentMartingaleStep}/${config.martingale.maxSteps})`,
    };
  }

  // ==================== SIGNAL HANDLING ====================

  async receiveSignal(userId: string, signalData: { trend: string; executionTime?: number; originalMessage?: string }): Promise<{ message: string }> {
    const mode = this.activeModes.get(userId);
    if (!mode?.isActive) {
      throw new Error('AI Signal mode tidak aktif');
    }

    const config = await this.getConfig(userId);
    const session = await this.authService.getSession(userId);
    if (!session) throw new Error('Session tidak ditemukan');

    const signal: TelegramSignal = {
      trend: signalData.trend.toLowerCase() === 'buy' || signalData.trend.toLowerCase() === 'call' ? 'call' : 'put',
      executionTime: signalData.executionTime || Date.now() + 5000,
      receivedAt: Date.now(),
      originalMessage: signalData.originalMessage || `AI Signal: ${signalData.trend}`,
    };

    // Check for active martingale (standard mode)
    if (mode.activeMartingaleOrders.size > 0 && !config.martingale.isAlwaysSignal) {
      this.logger.log(`[${userId}] Signal skipped - Standard Martingale active`);
      return { message: 'Signal skipped - Martingale in progress' };
    }

    // Handle Always Signal mode with outstanding loss
    if (config.martingale.isAlwaysSignal &&
        mode.alwaysSignalLossTracking?.hasOutstandingLoss) {
      return this.handleAlwaysSignalMartingale(userId, config, session, signal);
    }

    // Create normal order
    const order: AISignalOrder = {
      id: uuidv4(),
      assetRic: config.asset!.ric,
      assetName: config.asset!.name,
      trend: signal.trend,
      amount: config.baseAmount,
      executionTime: signal.executionTime,
      receivedAt: signal.receivedAt,
      originalMessage: signal.originalMessage,
      isExecuted: false,
      status: AISignalOrderStatus.PENDING,
      martingaleStep: 0,
      maxMartingaleSteps: config.martingale.maxSteps,
    };

    mode.pendingOrders.push(order);
    mode.pendingOrders.sort((a, b) => a.executionTime - b.executionTime);

    this.logger.log(`[${userId}] New AI Signal received: ${signal.trend} at ${new Date(signal.executionTime).toISOString()}`);

    return { message: `Signal received: ${signal.trend.toUpperCase()}` };
  }

  private async handleAlwaysSignalMartingale(
    userId: string,
    config: AISignalConfig,
    session: any,
    signal: TelegramSignal,
  ): Promise<{ message: string }> {
    const mode = this.activeModes.get(userId);
    if (!mode) return { message: 'Mode not active' };

    const lossState = mode.alwaysSignalLossTracking!;
    const nextStep = lossState.currentMartingaleStep + 1;

    if (nextStep > config.martingale.maxSteps) {
      this.logger.log(`[${userId}] Always Signal: Max steps reached - RESET`);
      mode.alwaysSignalLossTracking = null;
      return { message: 'Max steps reached - Resetting' };
    }

    const nextAmount = this.calculateMartingaleAmount(config, nextStep);

    const order: AISignalOrder = {
      id: uuidv4(),
      assetRic: config.asset!.ric,
      assetName: config.asset!.name,
      trend: signal.trend,
      amount: nextAmount,
      executionTime: signal.executionTime,
      receivedAt: signal.receivedAt,
      originalMessage: `${signal.originalMessage} (Step ${nextStep})`,
      isExecuted: false,
      status: AISignalOrderStatus.MARTINGALE_STEP,
      martingaleStep: nextStep,
      maxMartingaleSteps: config.martingale.maxSteps,
    };

    mode.pendingOrders.push(order);
    mode.pendingOrders.sort((a, b) => a.executionTime - b.executionTime);

    mode.alwaysSignalLossTracking = {
      ...lossState,
      currentMartingaleStep: nextStep,
    };

    this.logger.log(`[${userId}] Always Signal Martingale Step ${nextStep}: ${nextAmount}`);

    return { message: `Martingale Step ${nextStep}/${config.martingale.maxSteps}` };
  }

  // ==================== EXECUTION MONITORING ====================

  private startExecutionMonitoring(userId: string, config: AISignalConfig, session: any) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    mode.executionInterval = setInterval(async () => {
      if (!mode.isActive) {
        clearInterval(mode.executionInterval!);
        return;
      }

      try {
        await this.checkAndExecutePendingOrders(userId, config, session);
      } catch (err) {
        this.logger.error(`[${userId}] Error in execution monitoring: ${err}`);
      }
    }, EXECUTION_CHECK_INTERVAL_MS);
  }

  private async checkAndExecutePendingOrders(userId: string, config: AISignalConfig, session: any) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    const currentTime = Date.now();
    const ordersToExecute = mode.pendingOrders.filter((order) => {
      return !order.isExecuted && currentTime >= (order.executionTime - EXECUTION_ADVANCE_MS);
    });

    for (const order of ordersToExecute) {
      await this.executeOrder(userId, config, session, order);
    }
  }

  private async executeOrder(userId: string, config: AISignalConfig, session: any, order: AISignalOrder) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    // Check if already executed
    if (order.isExecuted) return;

    // Mark as executed
    const orderIndex = mode.pendingOrders.findIndex((o) => o.id === order.id);
    if (orderIndex !== -1) {
      mode.pendingOrders[orderIndex] = {
        ...order,
        isExecuted: true,
        status: AISignalOrderStatus.EXECUTING,
      };
      mode.executedOrdersMap.set(order.id, mode.pendingOrders[orderIndex]);
    }

    this.logger.log(`[${userId}] Executing AI Signal order: ${order.trend} - ${order.amount}`);

    // Execute via WebSocket
    mode.wsClient.sendTrade({
      amount: order.amount,
      trend: order.trend,
      ric: config.asset!.ric,
      isDemo: config.isDemoAccount,
      duration: 60,
    });

    // Update status to monitoring
    setTimeout(() => {
      const idx = mode.pendingOrders.findIndex((o) => o.id === order.id);
      if (idx !== -1 && mode.pendingOrders[idx].status === AISignalOrderStatus.EXECUTING) {
        mode.pendingOrders[idx] = {
          ...mode.pendingOrders[idx],
          status: AISignalOrderStatus.MONITORING,
        };
        mode.executedOrdersMap.set(order.id, mode.pendingOrders[idx]);
      }
    }, 2000);

    // Start monitoring for result
    this.monitorTradeResult(userId, config, session, order.id, order.martingaleStep > 0);
  }

  private async monitorTradeResult(
    userId: string,
    config: AISignalConfig,
    session: any,
    orderId: string,
    isMartingale: boolean,
  ) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    const maxWaitTime = 90000;
    const startTime = Date.now();

    const checkInterval = setInterval(async () => {
      if (!mode.isActive || Date.now() - startTime > maxWaitTime) {
        clearInterval(checkInterval);
        return;
      }

      try {
        const result = await this.fetchTradeResult(session, config);
        if (result) {
          clearInterval(checkInterval);
          await this.handleTradeResult(userId, config, session, orderId, result, isMartingale);
        }
      } catch (err) {
        this.logger.error(`[${userId}] Error checking trade result: ${err}`);
      }
    }, 2000);
  }

  private async fetchTradeResult(session: any, config: AISignalConfig): Promise<any | null> {
    try {
      const response = await axios.get(
        `${BASE_URL}/profile/trading-history?type=${config.isDemoAccount ? 'demo' : 'real'}`,
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
    } catch (err) {
      this.logger.error(`Error fetching trade result: ${err}`);
      return null;
    }
  }

  private async handleTradeResult(
    userId: string,
    config: AISignalConfig,
    session: any,
    orderId: string,
    result: any,
    isMartingale: boolean,
  ) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    // Deduplication check
    if (mode.processedOrderIds.has(orderId)) {
      return;
    }
    mode.processedOrderIds.add(orderId);

    const isWin = result.status?.toLowerCase() === 'won';
    const order = mode.executedOrdersMap.get(orderId) ||
                  mode.pendingOrders.find((o) => o.id === orderId);

    if (order) {
      order.result = isWin ? 'WIN' : 'LOSE';
      order.status = isWin ? AISignalOrderStatus.WIN : AISignalOrderStatus.LOSE;
    }

    this.logger.log(`[${userId}] AI Signal result: ${isWin ? 'WIN' : 'LOSE'} - Martingale: ${isMartingale}`);

    if (isMartingale) {
      const martingaleInfo = mode.activeMartingaleOrders.get(orderId);
      if (martingaleInfo) {
        await this.handleMartingaleResult(userId, config, session, orderId, martingaleInfo, isWin);
      }
    } else {
      await this.handleInitialTradeResult(userId, config, session, orderId, isWin);
    }

    // Set status to waiting after 3 seconds
    setTimeout(() => {
      const idx = mode.pendingOrders.findIndex((o) => o.id === orderId);
      if (idx !== -1) {
        mode.pendingOrders[idx] = {
          ...mode.pendingOrders[idx],
          status: AISignalOrderStatus.WAITING,
        };
      }
    }, 3000);
  }

  private async handleInitialTradeResult(
    userId: string,
    config: AISignalConfig,
    session: any,
    orderId: string,
    isWin: boolean,
  ) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    const order = mode.executedOrdersMap.get(orderId) ||
                  mode.pendingOrders.find((o) => o.id === orderId);

    if (isWin) {
      mode.alwaysSignalLossTracking = null;
      this.logger.log(`[${userId}] Initial trade WIN`);
    } else {
      if (config.martingale.isEnabled) {
        if (config.martingale.isAlwaysSignal) {
          // Always Signal mode - track loss for next signal
          mode.alwaysSignalLossTracking = {
            hasOutstandingLoss: true,
            currentMartingaleStep: 0,
            originalOrderId: orderId,
            totalLoss: order?.amount || config.baseAmount,
            currentTrend: order?.trend || 'call',
          };
          this.logger.log(`[${userId}] Always Signal: Will continue on next signal`);
        } else {
          // Standard martingale
          await this.startMartingale(userId, config, session, orderId, order?.trend || 'call');
        }
      }
    }
  }

  private async handleMartingaleResult(
    userId: string,
    config: AISignalConfig,
    session: any,
    parentOrderId: string,
    martingaleInfo: MartingaleSequenceInfo,
    isWin: boolean,
  ) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    if (isWin) {
      mode.activeMartingaleOrders.delete(parentOrderId);
      this.logger.log(`[${userId}] Martingale WIN at step ${martingaleInfo.currentStep}`);
    } else {
      const nextStep = martingaleInfo.currentStep + 1;

      if (nextStep > config.martingale.maxSteps) {
        mode.activeMartingaleOrders.delete(parentOrderId);
        this.logger.log(`[${userId}] Martingale failed - Max steps reached`);
      } else {
        // Continue to next step
        const nextAmount = this.calculateMartingaleAmount(config, nextStep);
        mode.activeMartingaleOrders.set(parentOrderId, {
          ...martingaleInfo,
          currentStep: nextStep,
          totalLoss: martingaleInfo.totalLoss + martingaleInfo.totalLoss, // Simplified
        });

        this.logger.log(`[${userId}] Martingale continuing to step ${nextStep}`);

        // Execute next step
        setTimeout(() => {
          this.executeMartingaleTrade(userId, config, session, parentOrderId, martingaleInfo.originalTrend, nextAmount, nextStep);
        }, 300);
      }
    }
  }

  private async startMartingale(
    userId: string,
    config: AISignalConfig,
    session: any,
    parentOrderId: string,
    trend: string,
  ) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    const nextStep = 1;
    const nextAmount = this.calculateMartingaleAmount(config, nextStep);

    mode.activeMartingaleOrders.set(parentOrderId, {
      orderId: parentOrderId,
      currentStep: nextStep,
      maxSteps: config.martingale.maxSteps,
      totalLoss: config.baseAmount,
      isActive: true,
      originalTrend: trend,
      lastExecutionTime: Date.now(),
    });

    this.executeMartingaleTrade(userId, config, session, parentOrderId, trend, nextAmount, nextStep);
  }

  private executeMartingaleTrade(
    userId: string,
    config: AISignalConfig,
    session: any,
    parentOrderId: string,
    trend: string,
    amount: number,
    step: number,
  ) {
    const mode = this.activeModes.get(userId);
    if (!mode) return;

    const martingaleOrderId = `${parentOrderId}_martingale_${step}`;
    const currentTime = Date.now();

    const martingaleOrder: AISignalOrder = {
      id: martingaleOrderId,
      assetRic: config.asset!.ric,
      assetName: config.asset!.name,
      trend,
      amount,
      executionTime: currentTime,
      receivedAt: currentTime,
      originalMessage: `Martingale Step ${step}`,
      isExecuted: true,
      status: AISignalOrderStatus.EXECUTING,
      martingaleStep: step,
      maxMartingaleSteps: config.martingale.maxSteps,
    };

    mode.pendingOrders.push(martingaleOrder);
    mode.executedOrdersMap.set(martingaleOrderId, martingaleOrder);

    this.logger.log(`[${userId}] Executing martingale step ${step}: ${amount}`);

    // Execute via WebSocket
    mode.wsClient.sendTrade({
      amount,
      trend,
      ric: config.asset!.ric,
      isDemo: config.isDemoAccount,
      duration: 60,
    });

    // Monitor result
    this.monitorTradeResult(userId, config, session, martingaleOrderId, true);
  }

  private calculateMartingaleAmount(config: AISignalConfig, step: number): number {
    const multiplier = config.martingale.multiplierType === 'FIXED'
      ? config.martingale.multiplierValue
      : 1 + config.martingale.multiplierValue / 100;

    return Math.floor(config.baseAmount * Math.pow(multiplier, step - 1));
  }

  // ==================== HELPERS ====================

  private buildStockityHeaders(session: any): Record<string, string> {
    return {
      'authorization-token': session.stockityToken,
      'device-id': session.deviceId,
      'device-type': session.deviceType || 'web',
      'user-timezone': session.userTimezone || 'Asia/Jakarta',
      'User-Agent': session.userAgent,
      'Accept': 'application/json, text/plain, '*/*'',
      'Origin': 'https://stockity.id',
      'Referer': 'https://stockity.id/',
    };
  }

  private async updateStatus(userId: string, botState: string) {
    await this.firebaseService.db.collection('aisignal_status').doc(userId).set(
      { botState, updatedAt: this.firebaseService.FieldValue.serverTimestamp() },
      { merge: true },
    );
  }

  getPendingOrders(userId: string): AISignalOrder[] {
    const mode = this.activeModes.get(userId);
    return mode ? mode.pendingOrders.filter((o) => !o.isExecuted) : [];
  }

  getExecutedOrders(userId: string): AISignalOrder[] {
    const mode = this.activeModes.get(userId);
    return mode ? mode.pendingOrders.filter((o) => o.isExecuted) : [];
  }
}
