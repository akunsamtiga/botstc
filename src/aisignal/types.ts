export enum AISignalOrderStatus {
  WAITING = 'WAITING',
  PENDING = 'PENDING',
  EXECUTING = 'EXECUTING',
  MONITORING = 'MONITORING',
  WIN = 'WIN',
  LOSE = 'LOSE',
  MARTINGALE_STEP = 'MARTINGALE_STEP',
  COMPLETED = 'COMPLETED',
}

export interface TelegramSignal {
  trend: string;
  executionTime: number;
  receivedAt: number;
  originalMessage: string;
}

export interface AISignalOrder {
  id: string;
  assetRic: string;
  assetName: string;
  trend: string;
  amount: number;
  executionTime: number;
  receivedAt: number;
  originalMessage: string;
  isExecuted: boolean;
  result?: string;
  status: AISignalOrderStatus;
  martingaleStep: number;
  maxMartingaleSteps: number;
}

export interface AlwaysSignalLossState {
  hasOutstandingLoss: boolean;
  currentMartingaleStep: number;
  originalOrderId: string;
  totalLoss: number;
  currentTrend: string;
}

export interface MartingaleSequenceInfo {
  orderId: string;
  currentStep: number;
  maxSteps: number;
  totalLoss: number;
  isActive: boolean;
  originalTrend: string;
  lastExecutionTime: number;
}

export interface AISignalConfig {
  asset: { ric: string; name: string } | null;
  baseAmount: number;
  martingale: {
    isEnabled: boolean;
    maxSteps: number;
    multiplierValue: number;
    multiplierType: 'FIXED' | 'PERCENTAGE';
    isAlwaysSignal: boolean;
  };
  isDemoAccount: boolean;
  currency: string;
}

export const EXECUTION_CHECK_INTERVAL_MS = 100;
export const EXECUTION_ADVANCE_MS = 1000;