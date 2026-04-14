import { Injectable, Logger } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';
import {
  ScheduledOrder,
  TrackedOrder,
  OrderTrackingStatus,
  OrderTrackingResponse,
  OrderTrackingFilter,
  TrendType,
  BotState,
} from './types';

/**
 * Service untuk tracking dan monitoring order mode signal.
 * Menyimpan history order lengkap dengan status tracking di Firestore.
 */
@Injectable()
export class OrderTrackingService {
  private readonly logger = new Logger(OrderTrackingService.name);

  constructor(private readonly firebaseService: FirebaseService) {}

  /**
   * Inisialisasi tracking untuk session baru.
   * Dipanggil saat schedule dimulai.
   */
  async initializeTracking(userId: string, orders: ScheduledOrder[]): Promise<void> {
    const trackedOrders: TrackedOrder[] = orders.map(order => ({
      ...order,
      trackingStatus: 'PENDING',
      currentMartingaleStep: 0,
    }));

    const trackingData = {
      userId,
      botState: 'RUNNING' as BotState,
      orders: trackedOrders,
      sessionPnL: 0,
      startedAt: this.firebaseService.FieldValue.serverTimestamp(),
      updatedAt: this.firebaseService.FieldValue.serverTimestamp(),
    };

    await this.firebaseService.db
      .collection('order_tracking')
      .doc(userId)
      .set(trackingData);

    this.logger.log(`[${userId}] Tracking initialized with ${orders.length} orders`);
  }

  /**
   * Update status order saat dieksekusi.
   */
  async markOrderAsExecuted(
    userId: string,
    orderId: string,
    dealId: string,
    amount: number,
    estimatedCompletionTime: number,
  ): Promise<void> {
    const docRef = this.firebaseService.db.collection('order_tracking').doc(userId);

    try {
      await this.firebaseService.db.runTransaction(async (transaction) => {
        const doc = await transaction.get(docRef);
        if (!doc.exists) return;

        const data = doc.data();
        const orders: TrackedOrder[] = data?.orders || [];
        const orderIndex = orders.findIndex(o => o.id === orderId);

        if (orderIndex === -1) return;

        orders[orderIndex] = {
          ...orders[orderIndex],
          isExecuted: true,
          trackingStatus: 'MONITORING',
          activeDealId: dealId,
          dealId: dealId,
          amount: amount,
          executedAt: Date.now(),
          estimatedCompletionTime: estimatedCompletionTime,
          currentMartingaleStep: 0,
        };

        transaction.update(docRef, {
          orders,
          updatedAt: this.firebaseService.FieldValue.serverTimestamp(),
        });
      });

      this.logger.log(`[${userId}] Order ${orderId} marked as MONITORING`);
    } catch (error: any) {
      this.logger.error(`[${userId}] Failed to mark order as executed: ${error.message}`);
    }
  }

  /**
   * Update status order saat martingale step berubah.
   */
  async updateMartingaleStep(
    userId: string,
    orderId: string,
    step: number,
    amount: number,
    dealId?: string,
  ): Promise<void> {
    const docRef = this.firebaseService.db.collection('order_tracking').doc(userId);

    const martingaleStatusMap: Record<number, OrderTrackingStatus> = {
      1: 'MARTINGALE_STEP_1',
      2: 'MARTINGALE_STEP_2',
      3: 'MARTINGALE_STEP_3',
      4: 'MARTINGALE_STEP_4',
      5: 'MARTINGALE_STEP_5',
    };

    const trackingStatus = martingaleStatusMap[step] || `MARTINGALE_STEP_${Math.min(step, 5)}` as OrderTrackingStatus;

    try {
      await this.firebaseService.db.runTransaction(async (transaction) => {
        const doc = await transaction.get(docRef);
        if (!doc.exists) return;

        const data = doc.data();
        const orders: TrackedOrder[] = data?.orders || [];
        const orderIndex = orders.findIndex(o => o.id === orderId);

        if (orderIndex === -1) return;

        const update: Partial<TrackedOrder> = {
          trackingStatus,
          currentMartingaleStep: step,
          amount: amount,
        };

        if (dealId) {
          update.dealId = dealId;
          update.activeDealId = dealId;
        }

        orders[orderIndex] = {
          ...orders[orderIndex],
          ...update,
        };

        transaction.update(docRef, {
          orders,
          updatedAt: this.firebaseService.FieldValue.serverTimestamp(),
        });
      });

      this.logger.log(`[${userId}] Order ${orderId} martingale step ${step}`);
    } catch (error: any) {
      this.logger.error(`[${userId}] Failed to update martingale step: ${error.message}`);
    }
  }

  /**
   * Complete order dengan hasil WIN, LOSE, atau DRAW.
   */
  async completeOrder(
    userId: string,
    orderId: string,
    result: 'WIN' | 'LOSE' | 'DRAW',
    profit: number,
    sessionPnL: number,
  ): Promise<void> {
    const docRef = this.firebaseService.db.collection('order_tracking').doc(userId);

    const statusMap: Record<string, OrderTrackingStatus> = {
      WIN: 'WIN',
      LOSE: 'LOSE',
      DRAW: 'DRAW',
    };

    try {
      await this.firebaseService.db.runTransaction(async (transaction) => {
        const doc = await transaction.get(docRef);
        if (!doc.exists) return;

        const data = doc.data();
        const orders: TrackedOrder[] = data?.orders || [];
        const orderIndex = orders.findIndex(o => o.id === orderId);

        if (orderIndex === -1) return;

        orders[orderIndex] = {
          ...orders[orderIndex],
          trackingStatus: statusMap[result],
          result: result,
          profit: profit,
          completedAt: Date.now(),
          martingaleState: {
            ...orders[orderIndex].martingaleState,
            isCompleted: true,
            finalResult: result,
          },
        };

        transaction.update(docRef, {
          orders,
          sessionPnL,
          updatedAt: this.firebaseService.FieldValue.serverTimestamp(),
        });
      });

      this.logger.log(`[${userId}] Order ${orderId} completed: ${result} (profit: ${profit})`);
    } catch (error: any) {
      this.logger.error(`[${userId}] Failed to complete order: ${error.message}`);
    }
  }

  /**
   * Mark order sebagai FAILED.
   */
  async markOrderAsFailed(
    userId: string,
    orderId: string,
    reason: string,
  ): Promise<void> {
    const docRef = this.firebaseService.db.collection('order_tracking').doc(userId);

    try {
      await this.firebaseService.db.runTransaction(async (transaction) => {
        const doc = await transaction.get(docRef);
        if (!doc.exists) return;

        const data = doc.data();
        const orders: TrackedOrder[] = data?.orders || [];
        const orderIndex = orders.findIndex(o => o.id === orderId);

        if (orderIndex === -1) return;

        orders[orderIndex] = {
          ...orders[orderIndex],
          trackingStatus: 'FAILED',
          result: 'FAILED',
          completedAt: Date.now(),
          skipReason: reason,
        };

        transaction.update(docRef, {
          orders,
          updatedAt: this.firebaseService.FieldValue.serverTimestamp(),
        });
      });

      this.logger.log(`[${userId}] Order ${orderId} marked as FAILED: ${reason}`);
    } catch (error: any) {
      this.logger.error(`[${userId}] Failed to mark order as failed: ${error.message}`);
    }
  }

  /**
   * Mark order sebagai SKIPPED.
   */
  async markOrderAsSkipped(
    userId: string,
    orderId: string,
    reason: string,
  ): Promise<void> {
    const docRef = this.firebaseService.db.collection('order_tracking').doc(userId);

    try {
      await this.firebaseService.db.runTransaction(async (transaction) => {
        const doc = await transaction.get(docRef);
        if (!doc.exists) return;

        const data = doc.data();
        const orders: TrackedOrder[] = data?.orders || [];
        const orderIndex = orders.findIndex(o => o.id === orderId);

        if (orderIndex === -1) return;

        orders[orderIndex] = {
          ...orders[orderIndex],
          isSkipped: true,
          trackingStatus: 'SKIPPED',
          result: 'SKIPPED',
          completedAt: Date.now(),
          skipReason: reason,
        };

        transaction.update(docRef, {
          orders,
          updatedAt: this.firebaseService.FieldValue.serverTimestamp(),
        });
      });

      this.logger.log(`[${userId}] Order ${orderId} marked as SKIPPED: ${reason}`);
    } catch (error: any) {
      this.logger.error(`[${userId}] Failed to mark order as skipped: ${error.message}`);
    }
  }

  /**
   * Update bot state.
   */
  async updateBotState(userId: string, botState: BotState): Promise<void> {
    const docRef = this.firebaseService.db.collection('order_tracking').doc(userId);

    const update: any = {
      botState,
      updatedAt: this.firebaseService.FieldValue.serverTimestamp(),
    };

    if (botState === 'STOPPED') {
      update.stoppedAt = this.firebaseService.FieldValue.serverTimestamp();
    }

    try {
      await docRef.set(update, { merge: true });
    } catch (error: any) {
      this.logger.error(`[${userId}] Failed to update bot state: ${error.message}`);
    }
  }

  /**
   * Update active martingale info.
   */
  async updateActiveMartingale(
    userId: string,
    martingaleInfo: {
      orderId: string;
      step: number;
      maxSteps: number;
      trend: TrendType;
      amount: number;
      startedAt: number;
    } | null,
  ): Promise<void> {
    const docRef = this.firebaseService.db.collection('order_tracking').doc(userId);

    try {
      await docRef.set(
        {
          activeMartingale: martingaleInfo,
          updatedAt: this.firebaseService.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    } catch (error: any) {
      this.logger.error(`[${userId}] Failed to update active martingale: ${error.message}`);
    }
  }

  /**
   * Get tracking data dengan filter.
   */
  async getTracking(
    userId: string,
    filter?: OrderTrackingFilter,
  ): Promise<OrderTrackingResponse | null> {
    const doc = await this.firebaseService.db.collection('order_tracking').doc(userId).get();

    if (!doc.exists) {
      return null;
    }

    const data = doc.data();
    let orders: TrackedOrder[] = data?.orders || [];
    const now = Date.now();

    // Calculate monitoring duration for active orders
    orders = orders.map(order => {
      if (order.trackingStatus === 'MONITORING' && order.executedAt) {
        return {
          ...order,
          monitoringDurationSeconds: Math.floor((now - order.executedAt) / 1000),
        };
      }
      return order;
    });

    // Apply filters
    if (filter) {
      if (filter.status && filter.status.length > 0) {
        orders = orders.filter(o => filter.status!.includes(o.trackingStatus));
      }

      if (filter.fromTime) {
        orders = orders.filter(o => o.timeInMillis >= filter.fromTime!);
      }

      if (filter.toTime) {
        orders = orders.filter(o => o.timeInMillis <= filter.toTime!);
      }

      if (filter.onlyActive) {
        const activeStatuses: OrderTrackingStatus[] = ['PENDING', 'MONITORING', 'MARTINGALE_STEP_1', 'MARTINGALE_STEP_2', 'MARTINGALE_STEP_3', 'MARTINGALE_STEP_4', 'MARTINGALE_STEP_5'];
        orders = orders.filter(o => activeStatuses.includes(o.trackingStatus));
      }

      if (filter.limit && filter.limit > 0) {
        orders = orders.slice(0, filter.limit);
      }
    }

    // Sort by time
    orders.sort((a, b) => a.timeInMillis - b.timeInMillis);

    // Calculate summary
    const summary = {
      total: orders.length,
      pending: orders.filter(o => o.trackingStatus === 'PENDING').length,
      monitoring: orders.filter(o => o.trackingStatus === 'MONITORING').length,
      martingaleActive: orders.filter(o =>
        o.trackingStatus.startsWith('MARTINGALE_STEP'),
      ).length,
      completed: orders.filter(o =>
        ['WIN', 'LOSE', 'DRAW'].includes(o.trackingStatus),
      ).length,
      win: orders.filter(o => o.trackingStatus === 'WIN').length,
      lose: orders.filter(o => o.trackingStatus === 'LOSE').length,
      draw: orders.filter(o => o.trackingStatus === 'DRAW').length,
      failed: orders.filter(o => o.trackingStatus === 'FAILED').length,
      skipped: orders.filter(o => o.trackingStatus === 'SKIPPED').length,
    };

    return {
      userId,
      botState: data?.botState || 'STOPPED',
      orders,
      summary,
      activeMartingale: data?.activeMartingale || null,
      sessionPnL: data?.sessionPnL || 0,
      timestamp: now,
    };
  }

  /**
   * Get tracking untuk hari ini (berdasarkan waktu Jakarta).
   */
  async getTodayTracking(userId: string): Promise<OrderTrackingResponse | null> {
    const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;
    const jakartaNow = new Date(Date.now() + JAKARTA_OFFSET_MS);
    const startOfDay = new Date(jakartaNow);
    startOfDay.setHours(0, 0, 0, 0);
    const startOfDayUtc = startOfDay.getTime() - JAKARTA_OFFSET_MS;

    return this.getTracking(userId, {
      fromTime: startOfDayUtc,
    });
  }

  /**
   * Get only active orders (yang masih berjalan).
   */
  async getActiveOrders(userId: string): Promise<TrackedOrder[]> {
    const tracking = await this.getTracking(userId, { onlyActive: true });
    return tracking?.orders || [];
  }

  /**
   * Clear tracking data (dipanggil saat session baru dimulai).
   */
  async clearTracking(userId: string): Promise<void> {
    await this.firebaseService.db.collection('order_tracking').doc(userId).delete();
    this.logger.log(`[${userId}] Tracking cleared`);
  }

  /**
   * Archive tracking data ke history collection.
   */
  async archiveTracking(userId: string): Promise<void> {
    const doc = await this.firebaseService.db.collection('order_tracking').doc(userId).get();

    if (!doc.exists) return;

    const data = doc.data();
    const archiveData = {
      ...data,
      archivedAt: this.firebaseService.FieldValue.serverTimestamp(),
    };

    // Simpan ke history dengan timestamp sebagai ID
    const historyId = `${userId}_${Date.now()}`;
    await this.firebaseService.db
      .collection('order_tracking_history')
      .doc(historyId)
      .set(archiveData);

    this.logger.log(`[${userId}] Tracking archived to ${historyId}`);
  }
}