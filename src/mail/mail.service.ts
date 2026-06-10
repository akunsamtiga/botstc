import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

/**
 * Pengiriman email via SMTP (TitanMail/Rumahweb atau provider SMTP lain).
 * Konfigurasi lewat env (dibaca saat request agar `pm2 reload --update-env`
 * langsung berlaku):
 *   SMTP_HOST   (mis. smtp.titan.email)
 *   SMTP_PORT   (465 = SSL, 587 = STARTTLS)  [default 465]
 *   SMTP_USER   (support@stcautotrade.id)
 *   SMTP_PASS   (password mailbox)
 *   MAIL_FROM   (opsional, mis. "STC AutoTrade <support@stcautotrade.id>")
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter | null = null;
  private cachedKey = '';

  isConfigured(): boolean {
    return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
  }

  private get from(): string {
    return (process.env.MAIL_FROM ?? '').trim() ||
      `STC AutoTrade <${process.env.SMTP_USER ?? 'support@stcautotrade.id'}>`;
  }

  private getTransporter(): nodemailer.Transporter {
    const host = (process.env.SMTP_HOST ?? '').trim();
    const user = (process.env.SMTP_USER ?? '').trim();
    const pass = process.env.SMTP_PASS ?? '';
    const port = parseInt(process.env.SMTP_PORT ?? '465', 10);
    if (!host || !user || !pass) {
      throw new BadRequestException(
        'Email belum dikonfigurasi. Set SMTP_HOST, SMTP_USER, SMTP_PASS di .env backend.',
      );
    }
    // Rebuild bila env berubah (setelah reload).
    const key = `${host}:${port}:${user}`;
    if (this.transporter && this.cachedKey === key) return this.transporter;
    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465, // 465 → SSL; 587 → STARTTLS
      auth: { user, pass },
    });
    this.cachedKey = key;
    return this.transporter;
  }

  /**
   * Kirim ke banyak penerima SATU-PER-SATU (bukan BCC) agar penerima tidak
   * saling melihat alamat email. Throttle ringan untuk hindari limit SMTP.
   */
  async sendBulk(
    recipients: string[],
    subject: string,
    html: string,
    text?: string,
  ): Promise<{ sent: number; failed: number; errors: string[] }> {
    const t = this.getTransporter();
    let sent = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const to of recipients) {
      try {
        await t.sendMail({ from: this.from, to, subject, html, text });
        sent++;
      } catch (e: any) {
        failed++;
        if (errors.length < 8) errors.push(`${to}: ${e?.message ?? 'gagal'}`);
        this.logger.warn(`Kirim email gagal ke ${to}: ${e?.message}`);
      }
      // jeda kecil antar email (hindari throttle TitanMail)
      await new Promise((r) => setTimeout(r, 200));
    }

    return { sent, failed, errors };
  }
}
