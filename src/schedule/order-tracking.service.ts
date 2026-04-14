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
 *
 * OPTIMASI QUOTA FIRESTORE:
 * - Semua state tracking disimpan di in-memory cache terlebih dahulu
 * - Flush ke Firestore dilakukan secara throttled (max sekali per FLUSH_INTERVAL_MS)
 * - Terminal events (WIN/LOSE/DRAW/FAILED/SKIPPED) langsung flush tanpa delay
 * - Mencegah RESOURCE_EXHAUSTED akibat terlalu banyak write per detik
 */
@Injectable()
export class OrderTrackingService {
  private readonly logger = new Logger(OrderTrackingService.name);

  /**
   * In-memory cache untuk tracking data.
   * Key = userId, Value = { data, dirty, lastFlush }
   */
  private cache = new Map<string, {
    data: any;
    dirty: boolean;
    lastFlush: number;
  }>();

  /**
   * Throttle: flush ke Firestore paling cepat sekali per interval ini
   * untuk event non-terminal (MONITORING, MARTINGALE_STEP_X).
   */
  private readonly FLUSH_INTERVAL_MS = 4000;

  /**
   * Event dengan status terminal → langsung flush tanpa throttle.
   */
  private readonly TERMINAL_STATUSES = new Set(['WIN', 'LOSE', 'DRAW', 'FAILED', 'SKIPPED']);

  constructor(private readonly firebaseService: FirebaseService) {}

  // ── Private Cache Helpers ──────────────────────────────────────────

  /**
   * Load data dari Firestore ke cache jika belum ada.
   */
  private async loadCache(userId: string): Promise<any | null> {
    if (this.cache.has(userId)) {
      return this.cache.get(userId)!.data;
    }
    const doc = await this.firebaseService.db.collection('order_tracking').doc(userId).get();
    if (!doc.exists) return null;
    const data = doc.data();
    this.cache.set(userId, { data, dirty: false, lastFlush: Date.now() });
    return data;
  }

  /**
   * Set cache entry dan tandai sebagai dirty.
   */
  private setCache(userId: string, data: any) {
    const existing = this.cache.get(userId);
    this.cache.set(userId, {
      data,
      dirty: true,
      lastFlush: existing?.lastFlush ?? 0,
    });
  }

  /**
   * Flush cache ke Firestore.
   * @param force - Jika true, flush tanpa cek throttle interval (untuk terminal events)
   */
  private async flushCache(userId: string, force = false): Promise<void> {
    const entry = this.cache.get(userId);
    if (!entry || !entry.dirty) return;

    const now = Date.now();
    const timeSinceLastFlush = now - entry.lastFlush;

    // Throttle: skip flush jika interval belum cukup dan bukan force
    if (!force && timeSinceLastFlush < this.FLUSH_INTERVAL_MS) {
      return;
    }

    try {
      // Strip FieldValue sentinels dari data cache sebelum disimpan
      const dataToSave = this.stripCacheForFirestore(entry.data);

      await this.firebaseService.db
        .collection('order_tracking')
        .doc(userId)
        .set({
          ...dataToSave,
          updatedAt: this.firebaseService.FieldValue.serverTimestamp(),
        });

      entry.dirty = false;
      entry.lastFlush = now;
    } catch (error: any) {
      this.logger.error(`[${userId}] Flush cache failed: ${error.message}`);
    }
  }

  /**
   * Hapus field yang tidak bisa di-serialize ke Firestore dari cache data.
   */
  private stripCacheForFirestore(data: any): any {
    if (!data) return data;
    const { updatedAt, startedAt, stoppedAt, archivedAt, ...rest } = data;
    return rest;
  }

  // ── Public Methods ─────────────────────────────────────────────────

  /**
   * Inisialisasi tracking untuk session baru.
   * Selalu flush langsung karena ini adalah event kritis.
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
    };

    // Simpan ke cache dan langsung flush (init selalu force)
    this.setCache(userId, trackingData);
    await this.firebaseService.db
      .collection('order_tracking')
      .doc(userId)
      .set({
        ...trackingData,
        startedAt: this.firebaseService.FieldValue.serverTimestamp(),
        updatedAt: this.firebaseService.FieldValue.serverTimestamp(),
      });

    // Update cache lastFlush
    const entry = this.cache.get(userId);
    if (entry) { entry.dirty = false; entry.lastFlush = Date.now(); }

    this.logger.log(`[${userId}] Tracking initialized with ${orders.length} orders`);
  }

  /**
   * Update status order saat dieksekusi.
   * Non-terminal → throttled flush.
   */
  async markOrderAsExecuted(
    userId: string,
    orderId: string,
    dealId: string,
    amount: number,
    estimatedCompletionTime: number,
  ): Promise<void> {
    try {
      let data = await this.loadCache(userId);
      if (!data) return;

      const orders: TrackedOrder[] = [...(data.orders || [])];
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

      this.setCache(userId, { ...data, orders });
      await this.flushCache(userId, false); // throttled

      this.logger.log(`[${userId}] Order ${orderId} marked as MONITORING`);
    } catch (error: any) {
      this.logger.error(`[${userId}] Failed to mark order as executed: ${error.message}`);
    }
  }

  /**
   * Update status order saat martingale step berubah.
   * Non-terminal → throttled flush.
   */
  async updateMartingaleStep(
    userId: string,
    orderId: string,
    step: number,
    amount: number,
    dealId?: string,
  ): Promise<void> {
    const martingaleStatusMap: Record<number, OrderTrackingStatus> = {
      1: 'MARTINGALE_STEP_1',
      2: 'MARTINGALE_STEP_2',
      3: 'MARTINGALE_STEP_3',
      4: 'MARTINGALE_STEP_4',
      5: 'MARTINGALE_STEP_5',
    };
    const trackingStatus = martingaleStatusMap[step] || `MARTINGALE_STEP_${Math.min(step, 5)}` as OrderTrackingStatus;

    try {
      let data = await this.loadCache(userId);
      if (!data) return;

      const orders: TrackedOrder[] = [...(data.orders || [])];
      const orderIndex = orders.findIndex(o => o.id === orderId);
      if (orderIndex === -1) return;

      const update: Partial<TrackedOrder> = { trackingStatus, currentMartingaleStep: step, amount };
      if (dealId) { update.dealId = dealId; update.activeDealId = dealId; }

      orders[orderIndex] = { ...orders[orderIndex], ...update };

      this.setCache(userId, { ...data, orders });
      await this.flushCache(userId, false); // throttled

      this.logger.log(`[${userId}] Order ${orderId} martingale step ${step}`);
    } catch (error: any) {
      this.logger.error(`[${userId}] Failed to update martingale step: ${error.message}`);
    }
  }

  /**
   * Complete order dengan hasil WIN, LOSE, atau DRAW.
   * Terminal event → langsung flush.
   */
  async completeOrder(
    userId: string,
    orderId: string,
    result: 'WIN' | 'LOSE' | 'DRAW',
    profit: number,
    sessionPnL: number,
  ): Promise<void> {
    const statusMap: Record<string, OrderTrackingStatus> = {
      WIN: 'WIN', LOSE: 'LOSE', DRAW: 'DRAW',
    };

    try {
      let data = await this.loadCache(userId);
      if (!data) return;

      const orders: TrackedOrder[] = [...(data.orders || [])];
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

      this.setCache(userId, { ...data, orders, sessionPnL });
      await this.flushCache(userId, true); // force flush — terminal event

      this.logger.log(`[${userId}] Order ${orderId} completed: ${result} (profit: ${profit})`);
    } catch (error: any) {
      this.logger.error(`[${userId}] Failed to complete order: ${error.message}`);
    }
  }

  /**
   * Mark order sebagai FAILED.
   * Terminal event → langsung flush.
   */
  async markOrderAsFailed(userId: string, orderId: string, reason: string): Promise<void> {
    try {
      let data = await this.loadCache(userId);
      if (!data) return;

      const orders: TrackedOrder[] = [...(data.orders || [])];
      const orderIndex = orders.findIndex(o => o.id === orderId);
      if (orderIndex === -1) return;

      orders[orderIndex] = {
        ...orders[orderIndex],
        trackingStatus: 'FAILED',
        result: 'FAILED',
        completedAt: Date.now(),
        skipReason: reason,
      };

      this.setCache(userId, { ...data, orders });
      await this.flushCache(userId, true); // force flush — terminal event

      this.logger.log(`[${userId}] Order ${orderId} marked as FAILED: ${reason}`);
    } catch (error: any) {
      this.logger.error(`[${userId}] Failed to mark order as failed: ${error.message}`);
    }
  }

  /**
   * Mark order sebagai SKIPPED.
   * Terminal event → langsung flush.
   */
  async markOrderAsSkipped(userId: string, orderId: string, reason: string): Promise<void> {
    try {
      let data = await this.loadCache(userId);
      if (!data) return;

      const orders: TrackedOrder[] = [...(data.orders || [])];
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

      this.setCache(userId, { ...data, orders });
      await this.flushCache(userId, true); // force flush — terminal event

      this.logger.log(`[${userId}] Order ${orderId} marked as SKIPPED: ${reason}`);
    } catch (error: any) {
      this.logger.error(`[${userId}] Failed to mark order as skipped: ${error.message}`);
    }
  }

  /**
   * Update bot state.
   * State change → langsung flush (kritis untuk restore session).
   */
  async updateBotState(userId: string, botState: BotState): Promise<void> {
    try {
      let data = await this.loadCache(userId);
      const updatedData = data
        ? { ...data, botState }
        : { userId, botState, orders: [], sessionPnL: 0 };

      this.setCache(userId, updatedData);
      await this.flushCache(userId, true); // force flush — state change kritis

      // Hapus cache saat STOPPED agar tidak stale di memory
      if (botState === 'STOPPED') {
        this.cache.delete(userId);
      }
    } catch (error: any) {
      this.logger.error(`[${userId}] Failed to update bot state: ${error.message}`);
    }
  }

  /**
   * Update active martingale info.
   * Throttled — bisa sering dipanggil dari executor.
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
    try {
      let data = await this.loadCache(userId);
      if (!data) return;

      this.setCache(userId, { ...data, activeMartingale: martingaleInfo });
      await this.flushCache(userId, false); // throttled
    } catch (error: any) {
      this.logger.error(`[${userId}] Failed to update active martingale: ${error.message}`);
    }
  }

  /**
   * Get tracking data dengan filter.
   * Selalu baca dari cache jika ada (tidak perlu hit Firestore).
   */
  async getTracking(
    userId: string,
    filter?: OrderTrackingFilter,
  ): Promise<OrderTrackingResponse | null> {
    // Coba ambil dari cache dulu, fallback ke Firestore
    let data = await this.loadCache(userId);
    if (!data) return null;

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
        const activeStatuses: OrderTrackingStatus[] = [
          'PENDING', 'MONITORING',
          'MARTINGALE_STEP_1', 'MARTINGALE_STEP_2', 'MARTINGALE_STEP_3',
          'MARTINGALE_STEP_4', 'MARTINGALE_STEP_5',
        ];
        orders = orders.filter(o => activeStatuses.includes(o.trackingStatus));
      }
      if (filter.limit && filter.limit > 0) {
        orders = orders.slice(0, filter.limit);
      }
    }

    // Sort by time
    orders.sort((a, b) => a.timeInMillis - b.timeInMillis);

    const summary = {
      total: orders.length,
      pending: orders.filter(o => o.trackingStatus === 'PENDING').length,
      monitoring: orders.filter(o => o.trackingStatus === 'MONITORING').length,
      martingaleActive: orders.filter(o => o.trackingStatus.startsWith('MARTINGALE_STEP')).length,
      completed: orders.filter(o => ['WIN', 'LOSE', 'DRAW'].includes(o.trackingStatus)).length,
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
    return this.getTracking(userId, { fromTime: startOfDayUtc });
  }

  /**
   * Get only active orders.
   */
  async getActiveOrders(userId: string): Promise<TrackedOrder[]> {
    const tracking = await this.getTracking(userId, { onlyActive: true });
    return tracking?.orders || [];
  }

  /**
   * Clear tracking data dan cache.
   */
  async clearTracking(userId: string): Promise<void> {
    this.cache.delete(userId);
    await this.firebaseService.db.collection('order_tracking').doc(userId).delete();
    this.logger.log(`[${userId}] Tracking cleared`);
  }

  /**
   * Archive tracking data ke history collection.
   * Flush cache terlebih dahulu sebelum archive.
   */
  async archiveTracking(userId: string): Promise<void> {
    // Flush cache dulu agar data di Firestore up-to-date
    await this.flushCache(userId, true);
    this.cache.delete(userId);

    const doc = await this.firebaseService.db.collection('order_tracking').doc(userId).get();
    if (!doc.exists) return;

    const archiveData = {
      ...doc.data(),
      archivedAt: this.firebaseService.FieldValue.serverTimestamp(),
    };
    const historyId = `${userId}_${Date.now()}`;
    await this.firebaseService.db
      .collection('order_tracking_history')
      .doc(historyId)
      .set(archiveData);

    this.logger.log(`[${userId}] Tracking archived to ${historyId}`);
  }
}