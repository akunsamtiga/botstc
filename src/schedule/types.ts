export type BotState = 'STOPPED' | 'RUNNING' | 'PAUSED';
export type MultiplierType = 'FIXED' | 'PERCENTAGE';
export type TrendType = 'call' | 'put';

export interface MartingaleSettings {
  isEnabled: boolean;
  maxSteps: number;
  baseAmount: number;
  multiplierValue: number;
  multiplierType: MultiplierType;
  isAlwaysSignal: boolean;
}

export interface AssetConfig {
  ric: string;
  name: string;
}

export interface ScheduleConfig {
  asset: AssetConfig;
  martingale: MartingaleSettings;
  isDemoAccount: boolean;
  currency: string;
  currencyIso: string;
  duration: number;
}

export interface ScheduledOrderMartingaleState {
  isActive: boolean;
  currentStep: number;
  maxSteps: number;
  isCompleted: boolean;
  finalResult?: string;
  totalLoss: number;
  totalRecovered: number;
  failureReason?: string;
  lastUpdateTime?: number;
}

export interface ScheduledOrder {
  id: string;
  time: string;
  trend: TrendType;
  timeInMillis: number;
  isExecuted: boolean;
  isSkipped: boolean;
  skipReason?: string;
  martingaleState: ScheduledOrderMartingaleState;
  result?: string;
  activeDealId?: string;
}

export interface AlwaysSignalLossState {
  hasOutstandingLoss: boolean;
  currentMartingaleStep: number;
  originalOrderId: string;
  totalLoss: number;
  currentTrend: TrendType;
}

export interface TradeOrderData {
  amount: number;
  createdAt: number;
  dealType: string;
  expireAt: number;
  iso: string;
  optionType: string;
  ric: string;
  trend: TrendType;
}

export interface ExecutionLog {
  id: string;
  orderId: string;
  time: string;
  trend: TrendType;
  amount: number;
  martingaleStep: number;
  dealId?: string;
  result?: string;
  executedAt: number;
  note?: string;
}
