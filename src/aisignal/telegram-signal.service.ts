import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';
import { TelegramSignal } from './types';
import * as admin from 'firebase-admin';

interface SignalCallback {
  (userId: string, signal: TelegramSignal): void;
}

@Injectable()
export class TelegramSignalService implements OnModuleDestroy {
  private readonly logger = new Logger(TelegramSignalService.name);

  // Per-user callbacks: userId → callback
  private signalCallbacks = new Map<string, SignalCallback>();

  // Track which userIds are actively listening
  private activeUserIds = new Set<string>();

  // Single global Firestore listener for 'telegram_signals' collection
  // (written by Python bridge after receiving from Telegram)
  private globalUnsubscribe: (() => void) | null = null;

  constructor(private readonly firebaseService: FirebaseService) {}

  onModuleDestroy() {
    this.stopGlobalListener();
    this.signalCallbacks.clear();
    this.activeUserIds.clear();
    this.logger.log('TelegramSignalService destroyed, all listeners cleaned up');
  }

  /**
   * Register a callback for a specific user.
   * When a global signal arrives, all registered users receive it.
   */
  setSignalCallback(userId: string, callback: SignalCallback): void {
    this.signalCallbacks.set(userId, callback);
    this.logger.log(`[${userId}] Signal callback registered`);
  }

  /**
   * Start listening for signals for a user.
   * Starts the global Firestore listener if not already running.
   */
  async startListening(userId: string): Promise<void> {
    if (this.activeUserIds.has(userId)) {
      this.logger.warn(`[${userId}] Already listening for signals`);
      return;
    }

    this.activeUserIds.add(userId);
    this.logger.log(`[${userId}] Starting to listen for Telegram signals`);

    // Start global listener if not already running
    if (!this.globalUnsubscribe) {
      await this.startGlobalListener();
    }

    this.logger.log(`[${userId}] Signal listeners started successfully`);
  }

  /**
   * Stop listening for a specific user.
   * Stops the global listener if no users remain.
   */
  stopListening(userId: string): void {
    this.activeUserIds.delete(userId);
    this.signalCallbacks.delete(userId);
    this.logger.log(`[${userId}] Signal listener stopped`);

    // Stop global listener if no users are left
    if (this.activeUserIds.size === 0) {
      this.stopGlobalListener();
    }
  }

  /**
   * Start global Firestore listener on 'telegram_signals' collection.
   * This collection is written by the Python Telegram bridge.
   *
   * Schema written by Python:
   * {
   *   trend: "call" | "put",
   *   hour: number,
   *   minute: number,
   *   second: number,
   *   originalMessage: string,
   *   autoTimeAdded: boolean,
   *   receivedAt: number (ms),
   *   source: "telegram",
   * }
   */
  private async startGlobalListener(): Promise<void> {
    try {
      const collectionRef = this.firebaseService.db.collection('telegram_signals');

      // Only listen to NEW documents (not past ones that may have accumulated)
      const startTime = admin.firestore.Timestamp.now();

      this.globalUnsubscribe = collectionRef
        .where('processedAt', '>=', startTime)
        .onSnapshot(
          (snapshot) => {
            snapshot.docChanges().forEach((change) => {
              if (change.type === 'added') {
                this.processGlobalSignal(change.doc);
              }
            });
          },
          (error) => {
            this.logger.error(`Global Firestore listener error: ${error.message}`);
            // Restart listener after delay
            this.globalUnsubscribe = null;
            setTimeout(() => {
              if (this.activeUserIds.size > 0) {
                this.startGlobalListener().catch((e) =>
                  this.logger.error(`Failed to restart global listener: ${e.message}`),
                );
              }
            }, 5000);
          },
        );

      this.logger.log(
        `✅ Global Firestore listener started on 'telegram_signals' collection`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to start global listener: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  private stopGlobalListener(): void {
    if (this.globalUnsubscribe) {
      this.globalUnsubscribe();
      this.globalUnsubscribe = null;
      this.logger.log('Global Firestore listener stopped');
    }
  }

  /**
   * Process a new signal from the global 'telegram_signals' collection.
   * Broadcasts to ALL active user callbacks.
   */
  private async processGlobalSignal(
    doc: admin.firestore.QueryDocumentSnapshot,
  ): Promise<void> {
    try {
      const data = doc.data();

      this.logger.log(
        `📡 New Telegram signal received: ${JSON.stringify(data)}`,
      );

      if (!data.trend) {
        this.logger.warn('Invalid signal: missing trend, deleting');
        await doc.ref.delete();
        return;
      }

      const trend = this.normalizeTrend(data.trend);
      const receivedAt: number = data.receivedAt ?? Date.now();

      // Calculate execution time from hour:minute:second
      let executionTime: number;
      if (data.hour !== undefined && data.minute !== undefined) {
        executionTime = this.calculateExecutionTime(
          Number(data.hour),
          Number(data.minute),
          Number(data.second ?? 0),
          receivedAt,
        );
      } else {
        executionTime = this.calculateExecutionTimeFromNow();
      }

      const signal: TelegramSignal = {
        trend,
        executionTime,
        receivedAt,
        originalMessage: data.originalMessage ?? `Telegram: ${trend}`,
      };

      this.logger.log(
        `✅ Signal parsed: ${trend.toUpperCase()} → execute at ${new Date(executionTime).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB`,
      );

      // Broadcast to ALL active users
      const activeCount = this.activeUserIds.size;
      if (activeCount === 0) {
        this.logger.warn('Signal received but no active AI Signal users');
      } else {
        this.logger.log(`Broadcasting signal to ${activeCount} active user(s)`);
        for (const userId of this.activeUserIds) {
          const callback = this.signalCallbacks.get(userId);
          if (callback) {
            try {
              callback(userId, signal);
              this.logger.log(`[${userId}] Signal dispatched`);
            } catch (cbErr) {
              this.logger.error(
                `[${userId}] Callback error: ${(cbErr as Error).message}`,
              );
            }
          } else {
            this.logger.warn(`[${userId}] No callback registered, signal dropped`);
          }
        }
      }

      // Delete processed signal from Firestore
      await doc.ref.delete();
      this.logger.debug(`Signal document ${doc.id} deleted after processing`);
    } catch (error) {
      this.logger.error(
        `Error processing global signal: ${(error as Error).message}`,
      );
      try {
        await doc.ref.delete();
      } catch {
        // Ignore
      }
    }
  }

  /**
   * Calculate execution timestamp from explicit hour:minute:second.
   * If the time is in the past, schedule for tomorrow.
   */
  private calculateExecutionTime(
    hour: number,
    minute: number,
    second: number,
    referenceMs: number,
  ): number {
    const target = new Date();
    target.setHours(hour, minute, second, 0);
    let ts = target.getTime();

    if (ts < referenceMs) {
      target.setDate(target.getDate() + 1);
      ts = target.getTime();
      this.logger.log(
        `Time already passed, scheduling for tomorrow: ${target.toISOString()}`,
      );
    }

    return ts;
  }

  /**
   * Calculate execution time when no explicit time is given.
   * Mirrors Python logic: next minute if ≥30s remaining, +2 min otherwise.
   */
  calculateExecutionTimeFromNow(): number {
    const now = new Date();
    const currentSecond = now.getSeconds();
    const minutesToAdd = (60 - currentSecond) >= 30 ? 1 : 2;

    now.setSeconds(0, 0);
    now.setMinutes(now.getMinutes() + minutesToAdd);

    this.logger.log(
      `Auto execution time: +${minutesToAdd}min → ${now.toISOString()}`,
    );
    return now.getTime();
  }

  /**
   * Normalize trend string to "call" | "put"
   */
  private normalizeTrend(trend: string): string {
    const t = trend.toLowerCase().trim();
    if (['buy', 'call', 'b', 'up'].includes(t)) return 'call';
    if (['sell', 'put', 's', 'down'].includes(t)) return 'put';
    return t;
  }

  /**
   * Inject a test signal directly into Firestore (for testing without Python bridge)
   */
  async injectTestSignal(
    userId: string,
    trend: string,
    delayMs = 5000,
  ): Promise<void> {
    const executionTime = Date.now() + delayMs;
    await this.firebaseService.db.collection('telegram_signals').add({
      trend,
      executionTime,
      receivedAt: Date.now(),
      originalMessage: `Test signal: ${trend}`,
      source: 'test',
      processedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    this.logger.log(`[${userId}] Test signal injected: ${trend} (delay: ${delayMs}ms)`);
  }

  /**
   * Get listening status for a user
   */
  getStatus(userId: string): { isListening: boolean; hasCallback: boolean; globalListenerActive: boolean } {
    return {
      isListening: this.activeUserIds.has(userId),
      hasCallback: this.signalCallbacks.has(userId),
      globalListenerActive: this.globalUnsubscribe !== null,
    };
  }
}