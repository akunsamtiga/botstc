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
  private onSignalReceived: SignalCallback | null = null;
  private activeListeners = new Map<string, () => void>();
  private fcmUnsubscribers = new Map<string, () => void>();

  // Konfigurasi topic FCM
  private readonly FCM_TOPIC = 'trading_signals';

  constructor(private readonly firebaseService: FirebaseService) {}

  onModuleDestroy() {
    // Cleanup semua listeners saat module dihancurkan
    for (const [userId, unsubscribe] of this.activeListeners) {
      unsubscribe();
      this.logger.log(`[${userId}] Cleaned up signal listener`);
    }
    this.activeListeners.clear();

    for (const [userId, unsubscribe] of this.fcmUnsubscribers) {
      unsubscribe();
      this.logger.log(`[${userId}] Cleaned up FCM listener`);
    }
    this.fcmUnsubscribers.clear();
  }

  /**
   * Set callback yang akan dipanggil saat sinyal diterima
   */
  setSignalCallback(callback: SignalCallback): void {
    this.onSignalReceived = callback;
    this.logger.log('Signal callback registered');
  }

  /**
   * Mulai listening untuk sinyal trading dari Firestore/FCM
   */
  async startListening(userId: string): Promise<void> {
    if (this.activeListeners.has(userId)) {
      this.logger.warn(`[${userId}] Already listening for signals`);
      return;
    }

    this.logger.log(`[${userId}] Starting to listen for Telegram signals`);

    // Opsi 1: Listen via Firestore (recommended untuk real-time)
    await this.startFirestoreListener(userId);

    // Opsi 2: Subscribe ke FCM topic (untuk push notification)
    await this.subscribeToFCMTopic(userId);

    this.logger.log(`[${userId}] Signal listeners started successfully`);
  }

  /**
   * Stop listening untuk user tertentu
   */
  stopListening(userId: string): void {
    const firestoreUnsubscribe = this.activeListeners.get(userId);
    if (firestoreUnsubscribe) {
      firestoreUnsubscribe();
      this.activeListeners.delete(userId);
      this.logger.log(`[${userId}] Firestore listener stopped`);
    }

    const fcmUnsubscribe = this.fcmUnsubscribers.get(userId);
    if (fcmUnsubscribe) {
      fcmUnsubscribe();
      this.fcmUnsubscribers.delete(userId);
      this.logger.log(`[${userId}] FCM listener stopped`);
    }
  }

  /**
   * Listen untuk sinyal via Firestore Realtime
   * Sinyal baru akan ditulis ke collection trading_signals/{userId}/incoming
   */
  private async startFirestoreListener(userId: string): Promise<void> {
    try {
      const signalRef = this.firebaseService.db
        .collection('trading_signals')
        .doc(userId)
        .collection('incoming');

      // Listen untuk sinyal baru
      const unsubscribe = signalRef.onSnapshot(
        (snapshot) => {
          snapshot.docChanges().forEach((change) => {
            if (change.type === 'added') {
              this.processIncomingSignal(userId, change.doc);
            }
          });
        },
        (error) => {
          this.logger.error(`[${userId}] Firestore listener error: ${error.message}`);
        },
      );

      this.activeListeners.set(userId, unsubscribe);
      this.logger.log(`[${userId}] Firestore listener started`);
    } catch (error) {
      this.logger.error(`[${userId}] Failed to start Firestore listener: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Subscribe ke FCM topic untuk push notifications
   */
  private async subscribeToFCMTopic(userId: string): Promise<void> {
    try {
      // Subscribe ke topic user-specific
      const userTopic = `${this.FCM_TOPIC}_${userId}`;
      
      // Note: Di server-side, kita tidak bisa "listen" ke topic FCM
      // Tapi kita bisa setup handler untuk messages yang dikirim via FCM
      // yang kemudian ditulis ke Firestore
      
      // Setup listener untuk FCM messages yang masuk ke Firestore
      const fcmMessageRef = this.firebaseService.db
        .collection('fcm_messages')
        .doc(userId)
        .collection('trading_signals');

      const unsubscribe = fcmMessageRef.onSnapshot(
        (snapshot) => {
          snapshot.docChanges().forEach((change) => {
            if (change.type === 'added') {
              this.processFCMMessage(userId, change.doc);
            }
          });
        },
        (error) => {
          this.logger.error(`[${userId}] FCM message listener error: ${error.message}`);
        },
      );

      this.fcmUnsubscribers.set(userId, unsubscribe);
      this.logger.log(`[${userId}] FCM message listener started for topic: ${userTopic}`);
    } catch (error) {
      this.logger.error(`[${userId}] Failed to setup FCM listener: ${(error as Error).message}`);
      // Tidak throw error karena ini adalah fallback
    }
  }

  /**
   * Proses sinyal yang masuk dari Firestore
   */
  private async processIncomingSignal(userId: string, doc: admin.firestore.QueryDocumentSnapshot): Promise<void> {
    try {
      const data = doc.data();
      
      this.logger.log(`[${userId}] Processing incoming signal: ${JSON.stringify(data)}`);

      // Validasi data sinyal
      if (!data.trend) {
        this.logger.warn(`[${userId}] Invalid signal: missing trend`);
        await doc.ref.delete();
        return;
      }

      // Parse execution time
      let executionTime: number;
      
      if (data.executionTime) {
        executionTime = data.executionTime;
      } else if (data.hour !== undefined && data.minute !== undefined) {
        // Calculate execution time from specified time
        executionTime = this.calculateExecutionTime(
          data.hour,
          data.minute,
          data.second || 0,
          data.receivedAt || Date.now(),
        );
      } else {
        // Default: execute 5 seconds from now
        executionTime = Date.now() + 5000;
      }

      const signal: TelegramSignal = {
        trend: this.normalizeTrend(data.trend),
        executionTime,
        receivedAt: data.receivedAt || Date.now(),
        originalMessage: data.originalMessage || `Signal: ${data.trend}`,
      };

      this.logger.log(
        `[${userId}] Signal processed: ${signal.trend} at ${new Date(signal.executionTime).toISOString()}`,
      );

      // Panggil callback
      if (this.onSignalReceived) {
        this.onSignalReceived(userId, signal);
      } else {
        this.logger.warn('No signal callback registered!');
      }

      // Hapus sinyal dari Firestore setelah diproses
      await doc.ref.delete();
      this.logger.debug(`[${userId}] Signal document deleted after processing`);
    } catch (error) {
      this.logger.error(`[${userId}] Error processing signal: ${(error as Error).message}`);
      // Tetap hapus dokumen untuk mencegah infinite loop
      try {
        await doc.ref.delete();
      } catch {
        // Ignore delete error
      }
    }
  }

  /**
   * Proses message dari FCM yang ditulis ke Firestore
   */
  private async processFCMMessage(userId: string, doc: admin.firestore.QueryDocumentSnapshot): Promise<void> {
    try {
      const data = doc.data();
      
      // FCM message structure berbeda dengan direct signal
      const signalData = data.data || data;
      
      // FIX: was `!signalData.type === 'TRADING_SIGNAL'` which compared boolean to string
      if (!signalData.trend && signalData.type !== 'TRADING_SIGNAL') {
        await doc.ref.delete();
        return;
      }

      const trend = signalData.trend;
      const hour = signalData.hour ? parseInt(signalData.hour, 10) : undefined;
      const minute = signalData.minute ? parseInt(signalData.minute, 10) : undefined;
      const second = signalData.second ? parseInt(signalData.second, 10) : 0;

      let executionTime: number;
      
      if (hour !== undefined && minute !== undefined) {
        executionTime = this.calculateExecutionTime(hour, minute, second, Date.now());
      } else {
        executionTime = Date.now() + 5000;
      }

      const signal: TelegramSignal = {
        trend: this.normalizeTrend(trend),
        executionTime,
        receivedAt: Date.now(),
        originalMessage: signalData.original_message || signalData.originalMessage || `FCM Signal: ${trend}`,
      };

      this.logger.log(`[${userId}] FCM signal processed: ${signal.trend}`);

      if (this.onSignalReceived) {
        this.onSignalReceived(userId, signal);
      }

      await doc.ref.delete();
    } catch (error) {
      this.logger.error(`[${userId}] Error processing FCM message: ${(error as Error).message}`);
      try {
        await doc.ref.delete();
      } catch {
        // Ignore
      }
    }
  }

  /**
   * Calculate execution time from specified hour:minute:second
   * Sama dengan logika di Kotlin
   */
  private calculateExecutionTime(hour: number, minute: number, second: number, messageTimestamp: number): number {
    const now = Date.now();
    const calendar = new Date(now);
    
    calendar.setHours(hour);
    calendar.setMinutes(minute);
    calendar.setSeconds(second);
    calendar.setMilliseconds(0);
    
    let executionTime = calendar.getTime();
    
    // Jika waktu sudah lewat, schedule untuk besok
    if (executionTime < messageTimestamp) {
      calendar.setDate(calendar.getDate() + 1);
      executionTime = calendar.getTime();
      this.logger.log(`Time already passed, scheduling for tomorrow: ${new Date(executionTime).toISOString()}`);
    }
    
    return executionTime;
  }

  /**
   * Calculate execution time untuk sinyal tanpa waktu spesifik
   * Sama dengan logika di Kotlin: eksekusi di :00 menit berikutnya
   */
  calculateExecutionTimeFromNow(): number {
    const now = new Date();
    const currentSecond = now.getSeconds();
    const currentMinute = now.getMinutes();
    
    const secondsToNextMinuteEnd = 60 - currentSecond;
    
    // Jika sisa waktu >= 30 detik, eksekusi di menit berikutnya
    // Jika < 30 detik, skip 1 menit
    const minutesToAdd = secondsToNextMinuteEnd >= 30 ? 1 : 2;
    
    now.setSeconds(0);
    now.setMilliseconds(0);
    now.setMinutes(currentMinute + minutesToAdd);
    
    this.logger.log(
      `Execution time calculation: current=${currentMinute}:${currentSecond}, ` +
      `secondsToNext=${secondsToNextMinuteEnd}, minutesToAdd=${minutesToAdd}, ` +
      `executeAt=${now.toISOString()}`,
    );
    
    return now.getTime();
  }

  /**
   * Normalize trend ke format standar (call/put)
   */
  private normalizeTrend(trend: string): string {
    const normalized = trend.toLowerCase().trim();
    
    if (normalized === 'buy' || normalized === 'call' || normalized === 'b' || normalized === 'up') {
      return 'call';
    }
    if (normalized === 'sell' || normalized === 'put' || normalized === 's' || normalized === 'down') {
      return 'put';
    }
    
    return normalized;
  }

  /**
   * Inject test signal untuk testing
   */
  async injectTestSignal(userId: string, trend: string, delayMs: number = 5000): Promise<void> {
    const signalRef = this.firebaseService.db
      .collection('trading_signals')
      .doc(userId)
      .collection('incoming');

    await signalRef.add({
      trend,
      executionTime: Date.now() + delayMs,
      receivedAt: Date.now(),
      originalMessage: `Test signal: ${trend}`,
      isTest: true,
    });

    this.logger.log(`[${userId}] Test signal injected: ${trend}`);
  }

  /**
   * Get status listening
   */
  getStatus(userId: string): { isListening: boolean; hasCallback: boolean } {
    return {
      isListening: this.activeListeners.has(userId),
      hasCallback: this.onSignalReceived !== null,
    };
  }
}