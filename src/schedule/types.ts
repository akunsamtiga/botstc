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
  profitRate?: number;
  typeName?: string;
  iconUrl?: string | null;
}

export interface ScheduleConfig {
  asset: AssetConfig;
  martingale: MartingaleSettings;
  isDemoAccount: boolean;
  currency: string;
  currencyIso: string;
  duration?: number;

  /**
   * Stop Loss: bot otomatis berhenti jika total kerugian sesi
   * mencapai atau melebihi nilai ini (dalam satuan currency terkecil, misal cents/IDR).
   * Contoh IDR: 50000000 = Rp 50.000.000
   * Set 0 atau undefined untuk menonaktifkan.
   */
  stopLoss?: number;

  /**
   * Stop Profit: bot otomatis berhenti jika total keuntungan sesi
   * mencapai atau melebihi nilai ini.
   * Set 0 atau undefined untuk menonaktifkan.
   */
  stopProfit?: number;
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
  createdAt: number;   // MILIDETIK
  dealType: string;
  expireAt: number;    // DETIK
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
  profit?: number;      // profit/loss aktual trade ini (positif = untung, negatif = rugi)
  sessionPnL?: number;  // running total P&L sesi setelah trade ini selesai
  executedAt: number;
  note?: string;
}

export interface StockityAsset {
  ric: string;
  name: string;
  type: number;
  typeName: string;
  profitRate: number;
  iconUrl: string | null;
}