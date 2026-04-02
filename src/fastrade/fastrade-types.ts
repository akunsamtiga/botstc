export type FastradeBotState = 'STOPPED' | 'RUNNING';
export type FastradeMode = 'FTT' | 'CTC';
export type TrendType = 'call' | 'put';

export interface FastradeAsset {
  ric: string;
  name: string;
  profitRate?: number;
  typeName?: string;
  iconUrl?: string | null;
}

export interface FastradeMartingale {
  isEnabled: boolean;
  maxSteps: number;
  baseAmount: number;
  multiplierValue: number;
  multiplierType: 'FIXED' | 'PERCENTAGE';
}

export interface FastradeConfig {
  asset: FastradeAsset;
  martingale: FastradeMartingale;
  isDemoAccount: boolean;
  currency: string;
  currencyIso: string;
  stopLoss?: number;
  stopProfit?: number;
}

export interface FastradeOrder {
  id: string;
  trend: TrendType;
  amount: number;
  executedAt: number;
  dealId?: string;
  result?: 'WIN' | 'LOSE' | 'DRAW';
  martingaleStep: number;
  isMartingale: boolean;
  cycleNumber: number;
}

export interface FastradeLog {
  id: string;
  orderId: string;
  trend: TrendType;
  amount: number;
  martingaleStep: number;
  dealId?: string;
  result?: string;
  profit?: number;
  sessionPnL?: number;
  executedAt: number;
  note?: string;
  cycleNumber: number;
  mode?: FastradeMode;
}

export interface FastradeTradeOrder {
  amount: number;
  createdAt: number;
  dealType: string;
  expireAt: number;
  iso: string;
  optionType: string;
  ric: string;
  trend: TrendType;
}