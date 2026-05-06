import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { AuthService } from '../auth/auth.service';
import { StockityWebSocketClient } from '../schedule/websocket-client';
import { FttExecutor } from './ftt-executor';
import { CtcExecutor } from './ctc-executor';
import { FastradeBaseExecutor, FastradeExecutorCallbacks, SessionInfo } from './fastrade-base.executor';
import { FastradeConfig, FastradeLog, FastradeMode } from './fastrade-types';
import { StartFastradeDto } from './dto/start-fastrade.dto';

@Injectable()
export class FastradeService implements OnModuleDestroy {
  private readonly logger = new Logger(FastradeService.name);

  /** Active executor per userId (one at a time — FTT or CTC, not both) */
  private executors = new Map<string, FastradeBaseExecutor>();

  /** Active WS clients per userId (separate from schedule WS) */
  private wsClients = new Map<string, StockityWebSocketClient>();

  /** In-memory logs per userId */
  private logs = new Map<string, FastradeLog[]>();

  /** Current mode per userId */
  private modes = new Map<string, FastradeMode>();

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly authService: AuthService,
  ) {}

  async onModuleDestroy() {
    for (const [, exec] of this.executors) exec.stop();
    for (const [, ws] of this.wsClients) ws.disconnect();
  }

  // ── Start ──────────────────────────────────────────

  async start(userId: string, dto: StartFastradeDto) {
    const existing = this.executors.get(userId);
    if (existing?.isActive()) {
      const mode = this.modes.get(userId);
      throw new Error(`${mode} sudah berjalan. Hentikan dulu sebelum memulai mode baru.`);
    }

    // Stop & cleanup any leftover
    if (existing) {
      existing.stop();
      this.cleanup(userId);
    }

    const session = await this.authService.getSession(userId);
    if (!session) throw new Error('Session tidak ditemukan. Silakan login ulang.');
    if (!session.stockityToken) throw new Error('Token Stockity tidak ditemukan. Silakan login ulang.');

    const sessionInfo: SessionInfo = {
      stockityToken: session.stockityToken,
      deviceId: session.deviceId,
      deviceType: session.deviceType || 'web',
      userAgent: session.userAgent,
      userTimezone: session.userTimezone || 'Asia/Jakarta',
    };

    const config: FastradeConfig = {
      asset: dto.asset,
      martingale: dto.martingale,
      isDemoAccount: dto.isDemoAccount,
      currency: dto.currency,
      currencyIso: dto.currencyIso,
      stopLoss: dto.stopLoss ?? 0,
      stopProfit: dto.stopProfit ?? 0,
    };

    // Create fresh WS connection
    const ws = new StockityWebSocketClient(
      userId,
      session.stockityToken,
      session.deviceId,
      session.deviceType || 'web',
      session.userAgent,
    );

    ws.setOnStatusChange((connected, reason) => {
      this.logger.log(`[${userId}] Fastrade WS: ${connected ? 'Connected' : 'Disconnected'} ${reason || ''}`);
    });

    try {
      await ws.connect();
    } catch (err: any) {
      ws.disconnect();
      throw new Error(`Gagal koneksi WebSocket: ${err.message}`);
    }

    this.wsClients.set(userId, ws);
    if (!this.logs.has(userId)) this.logs.set(userId, []);

    // Build callbacks
    const callbacks: FastradeExecutorCallbacks = {
      onLog: (log) => {
        const modeLabel = this.modes.get(userId) ?? 'FTT';
        const enriched = { ...log, mode: modeLabel };
        const arr = this.logs.get(userId) || [];
        // FIX: upsert by id — jika entry dengan ID yang sama sudah ada (execution log),
        // timpa dengan entry baru (result log). Mencegah duplikasi di in-memory saat
        // getLogs() dipanggil ketika bot sedang running.
        const existingIdx = arr.findIndex(l => l.id === enriched.id);
        if (existingIdx !== -1) {
          arr[existingIdx] = enriched;
        } else {
          arr.push(enriched);
        }
        if (arr.length > 500) arr.splice(0, arr.length - 500);
        this.logs.set(userId, arr);
        this.appendLogToSupabase(userId, enriched).catch(() => {});
      },
      onStatusChange: (status) => {
        this.logger.debug(`[${userId}] ${status}`);
        this.updateSupabaseStatus(userId, { lastStatus: status }).catch(() => {});
      },
      onStopped: () => {
        this.logger.log(`[${userId}] Fastrade stopped`);
        this.updateSupabaseStatus(userId, { botState: 'STOPPED' }).catch(() => {});
        this.cleanup(userId);
      },
    };

    // Instantiate executor
    const executor =
      dto.mode === 'FTT'
        ? new FttExecutor(userId, ws, config, sessionInfo, callbacks)
        : new CtcExecutor(userId, ws, config, sessionInfo, callbacks);

    this.executors.set(userId, executor);
    this.modes.set(userId, dto.mode);

    executor.start();

    const accountType = dto.isDemoAccount ? 'Demo' : 'Real';
    await this.updateSupabaseStatus(userId, {
      botState: 'RUNNING',
      mode: dto.mode,
      asset: dto.asset.ric,
      isDemoAccount: dto.isDemoAccount,
      startedAt: this.supabaseService.now(),
    });

    this.logger.log(
      `[${userId}] ✅ ${dto.mode} started | asset=${dto.asset.ric} | account=${accountType}`,
    );

    return {
      message: `${dto.mode} dimulai`,
      mode: dto.mode,
      asset: dto.asset.name,
      account: accountType,
      status: executor.getStatus(),
    };
  }

  // ── Stop ───────────────────────────────────────────

  async stop(userId: string) {
    const executor = this.executors.get(userId);
    if (!executor) return { message: 'Tidak ada mode fastrade yang berjalan' };

    const mode = this.modes.get(userId);
    executor.stop();
    await this.updateSupabaseStatus(userId, {
      botState: 'STOPPED',
      stoppedAt: this.supabaseService.now(),
    });
    this.cleanup(userId);

    return { message: `${mode} dihentikan` };
  }

  // ── Status ─────────────────────────────────────────

  getStatus(userId: string) {
    const executor = this.executors.get(userId);
    const mode = this.modes.get(userId);

    if (executor) {
      return { mode, ...executor.getStatus() };
    }

    return {
      mode: null,
      isRunning: false,
      cycleNumber: 0,
      currentTrend: null,
      martingaleStep: 0,
      isMartingaleActive: false,
      sessionPnL: 0,
      totalTrades: 0,
      totalWins: 0,
      totalLosses: 0,
      activeOrderId: null,
      wsConnected: false,
    };
  }

  // ── Logs ───────────────────────────────────────────

  async getLogs(userId: string, limit = 100): Promise<FastradeLog[]> {
    const mem = this.logs.get(userId) || [];
    if (mem.length > 0) return mem.slice(-limit);

    // Fallback: Supabase
    const { data, error } = await this.supabaseService.client
      .from('mode_logs')
      .select('data, executed_at')
      .eq('user_id', userId)
      .in('mode', ['FTT', 'CTC'])
      .order('executed_at', { ascending: false })
      .limit(limit);

    if (error || !data) return [];

    return data.map((row) => ({
      ...(row.data as FastradeLog),
      executedAt: new Date(row.executed_at).getTime(),
    }));
  }

  // ── Private helpers ────────────────────────────────

  private cleanup(userId: string) {
    this.wsClients.get(userId)?.disconnect();
    this.wsClients.delete(userId);
    this.executors.delete(userId);
    this.modes.delete(userId);
  }

  private async updateSupabaseStatus(userId: string, data: Record<string, any>) {
    await this.supabaseService.client
      .from('fastrade_status')
      .upsert({
        user_id: userId,
        ...(data.botState      !== undefined && { bot_state:       data.botState }),
        ...(data.mode          !== undefined && { mode:            data.mode }),
        ...(data.asset         !== undefined && { asset:           data.asset }),
        ...(data.isDemoAccount !== undefined && { is_demo_account: data.isDemoAccount }),
        ...(data.startedAt     !== undefined && { started_at:      data.startedAt }),
        ...(data.stoppedAt     !== undefined && { stopped_at:      data.stoppedAt }),
        updated_at: this.supabaseService.now(),
      }, { onConflict: 'user_id' });
  }

  private async appendLogToSupabase(userId: string, log: FastradeLog) {
    await this.supabaseService.client
      .from('mode_logs')
      .upsert({
        id: log.id,
        user_id: userId,
        mode: log.mode ?? 'FTT',
        data: log,
        executed_at: this.supabaseService.timestampFromMillis(log.executedAt),
      }, { onConflict: 'id' });
  }
}