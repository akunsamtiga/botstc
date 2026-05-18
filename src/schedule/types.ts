export type BotState = 'STOPPED' | 'RUNNING' | 'PAUSED';
export type MultiplierType = 'FIXED' | 'PERCENTAGE';
export type TrendType = 'call' | 'put';

/**
 * Status tracking untuk order mode signal
 * - PENDING: Menunggu waktu eksekusi (belum order)
 * - MONITORING: Sudah order, menunggu hasil
 * - MARTINGALE_STEP_1: Martingale step 1 aktif
 * - MARTINGALE_STEP_2: Martingale step 2 aktif
 * - MARTINGALE_STEP_3: Martingale step 3 aktif (dan seterusnya)
 * - WIN: Order selesai dengan hasil menang
 * - LOSE: Order selesai dengan hasil kalah
 * - DRAW: Order selesai dengan hasil seri
 * - FAILED: Order gagal dieksekusi
 * - SKIPPED: Order dilewati (kadaluarsa atau bentrok)
 */
export type OrderTrackingStatus =
  | 'PENDING'
  | 'MONITORING'
  | 'MARTINGALE_STEP_1'
  | 'MARTINGALE_STEP_2'
  | 'MARTINGALE_STEP_3'
  | 'MARTINGALE_STEP_4'
  | 'MARTINGALE_STEP_5'
  | 'WIN'
  | 'LOSE'
  | 'DRAW'
  | 'FAILED'
  | 'SKIPPED';

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

/**
 * Extended order dengan tracking status lengkap untuk monitoring
 */
export interface TrackedOrder extends ScheduledOrder {
  /** Status tracking yang lebih detail */
  trackingStatus: OrderTrackingStatus;
  /** Waktu order dieksekusi (dalam ms) */
  executedAt?: number;
  /** Waktu order selesai (dalam ms) */
  completedAt?: number;
  /** Profit/loss dari order ini */
  profit?: number;
  /** Deal ID dari Stockity */
  dealId?: string;
  /** Jumlah amount yang diorder */
  amount?: number;
  /** Step martingale saat ini */
  currentMartingaleStep: number;
  /** Durasi monitoring dalam detik (untuk order yang sedang berjalan) */
  monitoringDurationSeconds?: number;
  /** Estimasi waktu selesai (dalam ms) */
  estimatedCompletionTime?: number;
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
  isDemoAccount?: boolean; // true = demo, false = real (untuk filter profit hari ini)
}

export interface StockityAsset {
  ric: string;
  name: string;
  type: number;
  typeName: string;
  profitRate: number;
  iconUrl: string | null;
}

/**
 * Response untuk endpoint monitoring order
 */
export interface OrderTrackingResponse {
  /** User ID */
  userId: string;
  /** Status bot saat ini */
  botState: BotState;
  /** Daftar semua order dengan status tracking */
  orders: TrackedOrder[];
  /** Ringkasan statistik */
  summary: {
    total: number;
    pending: number;
    monitoring: number;
    martingaleActive: number;
    completed: number;
    win: number;
    lose: number;
    draw: number;
    failed: number;
    skipped: number;
  };
  /** Informasi martingale yang sedang aktif */
  activeMartingale?: {
    orderId: string;
    step: number;
    maxSteps: number;
    trend: TrendType;
    amount: number;
    startedAt: number;
  } | null;
  /** Session P&L */
  sessionPnL: number;
  /** Waktu response */
  timestamp: number;
}

/**
 * Filter untuk query tracking order
 */
export interface OrderTrackingFilter {
  /** Filter berdasarkan status */
  status?: OrderTrackingStatus[];
  /** Filter order dari waktu tertentu (ms) */
  fromTime?: number;
  /** Filter order sampai waktu tertentu (ms) */
  toTime?: number;
  /** Hanya order yang aktif (belum selesai) */
  onlyActive?: boolean;
  /** Limit jumlah order */
  limit?: number;
}