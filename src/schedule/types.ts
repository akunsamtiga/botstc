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
  profitRate?: number;   // opsional, diisi saat auto-fetch dari Stockity
  typeName?: string;     // opsional, misal "Forex", "Crypto", dll
  iconUrl?: string | null;
}

export interface ScheduleConfig {
  asset: AssetConfig;
  martingale: MartingaleSettings;
  isDemoAccount: boolean;
  currency: string;
  currencyIso: string;
  /**
   * CATATAN: `duration` tidak mempengaruhi perhitungan trade ke WebSocket.
   * Durasi trade selalu dihitung otomatis dari algoritma timing (createdAt/expireAt),
   * identik dengan logika Kotlin TradeManager.createTradeOrder().
   * Field ini hanya disimpan sebagai metadata/referensi UI.
   */
  duration?: number;
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
  createdAt: number;    // dalam MILIDETIK
  dealType: string;
  expireAt: number;     // dalam DETIK
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

// Model untuk asset yang di-fetch dari Stockity
export interface StockityAsset {
  ric: string;
  name: string;
  type: number;
  typeName: string;
  profitRate: number;
  iconUrl: string | null;
}