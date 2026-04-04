export enum IndicatorType {
  SMA = 'SMA',
  EMA = 'EMA',
  RSI = 'RSI',
}

export interface IndicatorSettings {
  type: IndicatorType;
  period: number;
  rsiOverbought: number;
  rsiOversold: number;
  isEnabled: boolean;
  sensitivity: number;
  amount: number;
}

export interface IndicatorAnalysisResult {
  indicatorType: IndicatorType;
  calculatedValues: number[];
  finalIndicatorValue: number;
  trend: string;
  strength: string;
  analysisTime: number;
}

export interface PricePrediction {
  id: string;
  targetPrice: number;
  predictionType: string;
  recommendedTrend: string;
  confidence: number;
  isTriggered: boolean;
  triggeredAt: number;
  createdAt: number;
  isDisabled: boolean;
}

export interface IndicatorOrder {
  id: string;
  assetRic: string;
  assetName: string;
  trend: string;
  amount: number;
  executionTime: number;
  triggerLevel: number;
  triggerType: string;
  indicatorType: string;
  indicatorValue: number;
  isExecuted: boolean;
  isSkipped: boolean;
  skipReason?: string;
  martingaleState: IndicatorOrderMartingaleState;
}

export interface IndicatorOrderMartingaleState {
  isActive: boolean;
  currentStep: number;
  isCompleted: boolean;
  finalResult?: string;
  totalLoss: number;
  totalRecovered: number;
}

export interface IndicatorMartingaleOrder {
  originalOrderId: string;
  currentStep: number;
  maxSteps: number;
  totalLoss: number;
  nextAmount: number;
  isActive: boolean;
  indicatorType: string;
  lastTriggerLevel: number;
}

export interface IndicatorMartingaleResult {
  isWin: boolean;
  step: number;
  amount: number;
  totalLoss: number;
  totalRecovered: number;
  message: string;
  shouldContinue: boolean;
  isMaxReached: boolean;
  indicatorOrderId?: string;
  triggerLevel: number;
  indicatorValue: number;
  indicatorType: string;
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

export const DEFAULT_INDICATOR_SETTINGS: IndicatorSettings = {
  type: IndicatorType.SMA,
  period: 14,
  rsiOverbought: 70,
  rsiOversold: 30,
  isEnabled: true,
  sensitivity: 0.5,
  amount: 1400000,
};

export const SENSITIVITY_PRESETS = {
  LOW: 0.1,
  MEDIUM: 1,
  HIGH: 5,
  VERY_HIGH: 10,
  MAX: 100,
};
