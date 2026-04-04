export enum MomentumType {
  CANDLE_SABIT = 'CANDLE_SABIT',
  DOJI_TERJEPIT = 'DOJI_TERJEPIT',
  DOJI_PEMBATALAN = 'DOJI_PEMBATALAN',
  BB_SAR_BREAK = 'BB_SAR_BREAK',
}

export interface MomentumSignal {
  momentumType: MomentumType;
  trend: string;
  confidence: number;
  details: string;
}

export interface MomentumOrder {
  id: string;
  assetRic: string;
  assetName: string;
  trend: string;
  amount: number;
  executionTime: number;
  momentumType: MomentumType;
  confidence: number;
  sourceCandle: Candle;
  isExecuted: boolean;
  isSkipped: boolean;
  skipReason?: string;
  martingaleState: MomentumOrderMartingaleState;
}

export interface MomentumOrderMartingaleState {
  isActive: boolean;
  currentStep: number;
  isCompleted: boolean;
  finalResult?: string;
  totalLoss: number;
  totalRecovered: number;
}

export interface MomentumMartingaleOrder {
  originalOrderId: string;
  momentumType: MomentumType;
  currentStep: number;
  maxSteps: number;
  totalLoss: number;
  nextAmount: number;
  trend: string;
  isActive: boolean;
}

export interface MomentumMartingaleResult {
  isWin: boolean;
  step: number;
  amount: number;
  totalLoss: number;
  totalRecovered: number;
  message: string;
  shouldContinue: boolean;
  isMaxReached: boolean;
  momentumType: MomentumType;
}

export interface Candle {
  open: number;
  close: number;
  high: number;
  low: number;
  createdAt: string;
}

export interface CandleApiResponse {
  data: CandleData[];
}

export interface CandleData {
  open: string;
  close: string;
  high: string;
  low: string;
  created_at: string;
}

export interface BollingerBands {
  upper: number;
  middle: number;
  lower: number;
}

export interface SignalState {
  lastSignal: string | null;
  lastSignalTime: number;
  lastPrice: number | null;
  consecutiveSignals: number;
  signalHistory: number[];
  isOrderActive: boolean;
}

export interface MomentumStates {
  candleSabit: SignalState;
  dojiTerjepit: SignalState;
  dojiPembatalan: SignalState;
  bbSarBreak: SignalState;
}

export const SIGNAL_COOLDOWN_MS = 3 * 60 * 1000; // 3 minutes
export const PRICE_MOVE_THRESHOLD = 0.0003; // 0.03%
export const MAX_SIGNALS_PER_HOUR = 10;
export const SIGNAL_HISTORY_CLEANUP_MS = 60 * 60 * 1000; // 1 hour
export const MAX_CANDLES_STORAGE = 100;
export const MIN_CANDLES_FOR_BB_SAR = 10;
export const CANDLES_5SEC_PER_MINUTE = 12;
export const FETCH_5SEC_OFFSET = 300;
