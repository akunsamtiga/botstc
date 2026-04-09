import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * FirebaseMessagingService
 *
 * Drop-in replacement for firebase-admin messaging that sends FCM messages
 * via the FCM HTTP v1 REST API using the system `curl` binary instead of
 * Node.js's built-in HTTP client.
 *
 * WHY: This VPS blocks outbound TLS connections made by Node.js (Cloudflare
 * JA3/JA4 fingerprint filtering). The firebase-admin SDK fetches its OAuth2
 * access token using Node's HTTP stack → the request silently hangs →
 * "Error while making request: ." in the logs.
 *
 * SOLUTION: Mirror the same pattern used in auth.service.ts and http-utils.ts:
 *   1. Build & sign a service-account JWT locally (pure crypto, no network).
 *   2. Exchange JWT → short-lived OAuth2 access token via curlPost().
 *   3. Call the FCM v1 send endpoint via curlPost().
 *
 * The public API surface (.send / .sendToTopic / .sendMulticast) is kept
 * identical so callers (AISignalService, etc.) need zero changes.
 */

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

@Injectable()
export class FirebaseMessagingService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseMessagingService.name);

  /** Cached OAuth2 access token + expiry */
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0; // epoch ms

  private serviceAccount: ServiceAccount | null = null;
  private projectId: string;

  constructor(private readonly configService: ConfigService) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Module init: load service account (same logic as firebase.service.ts)
  // ─────────────────────────────────────────────────────────────────────────

  onModuleInit() {
    const serviceAccountPath = this.configService.get<string>('FIREBASE_SERVICE_ACCOUNT_PATH');

    if (serviceAccountPath) {
      const resolved = path.resolve(process.cwd(), serviceAccountPath);
      if (fs.existsSync(resolved)) {
        this.serviceAccount = JSON.parse(fs.readFileSync(resolved, 'utf8'));
        this.projectId = this.serviceAccount!.project_id;
        this.logger.log('✅ FirebaseMessagingService: service account loaded from file');
        return;
      }
      this.logger.warn(`Service account file not found at ${resolved}, falling back to env vars`);
    }

    // Fall back to individual env vars
    const projectId   = this.configService.get<string>('FIREBASE_PROJECT_ID');
    const clientEmail = this.configService.get<string>('FIREBASE_CLIENT_EMAIL');
    const privateKey  = this.configService.get<string>('FIREBASE_PRIVATE_KEY');

    if (projectId && clientEmail && privateKey) {
      this.serviceAccount = {
        project_id:   projectId,
        client_email: clientEmail,
        private_key:  privateKey.replace(/\\n/g, '\n'),
      };
      this.projectId = projectId;
      this.logger.log('✅ FirebaseMessagingService: service account loaded from env vars');
    } else {
      this.logger.error('❌ FirebaseMessagingService: no service account configured');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // OAuth2 token: sign JWT locally, exchange via curl
  // ─────────────────────────────────────────────────────────────────────────

  private buildJwt(): string {
    const sa = this.serviceAccount!;
    const now = Math.floor(Date.now() / 1000);

    const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss:   sa.client_email,
      sub:   sa.client_email,
      aud:   'https://oauth2.googleapis.com/token',
      iat:   now,
      exp:   now + 3600,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
    })).toString('base64url');

    const signingInput = `${header}.${payload}`;
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(signingInput);
    const signature = sign.sign(sa.private_key, 'base64url');

    return `${signingInput}.${signature}`;
  }

  private async fetchAccessToken(): Promise<string> {
    // Return cached token if still valid (with 60s buffer)
    if (this.cachedToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.cachedToken;
    }

    if (!this.serviceAccount) {
      throw new Error('Service account not configured');
    }

    const jwt = this.buildJwt();

    const { stdout } = await execFileAsync('curl', [
      '-s',
      '-X', 'POST',
      'https://oauth2.googleapis.com/token',
      '-H', 'Content-Type: application/x-www-form-urlencoded',
      '-d', `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
      '--max-time', '15',
      '-w', '\n__HTTP_STATUS__%{http_code}',
    ]);

    const parts      = stdout.split('\n__HTTP_STATUS__');
    const statusCode = parseInt(parts[1]?.trim() ?? '0', 10);
    const rawBody    = parts[0].trim();

    if (!rawBody || statusCode === 0) {
      throw new Error('OAuth2 token request timed out');
    }

    let parsed: any;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new Error(`OAuth2 non-JSON response (HTTP ${statusCode}): ${rawBody.slice(0, 200)}`);
    }

    if (statusCode !== 200 || !parsed.access_token) {
      throw new Error(`OAuth2 error (HTTP ${statusCode}): ${JSON.stringify(parsed).slice(0, 300)}`);
    }

    this.cachedToken    = parsed.access_token as string;
    this.tokenExpiresAt = Date.now() + (parsed.expires_in ?? 3600) * 1000;

    this.logger.log('✅ OAuth2 access token refreshed via curl');
    return this.cachedToken;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FCM REST API send via curl
  // ─────────────────────────────────────────────────────────────────────────

  private async curlFcmSend(fcmMessage: object): Promise<string> {
    const accessToken = await this.fetchAccessToken();
    const url = `https://fcm.googleapis.com/v1/projects/${this.projectId}/messages:send`;

    const { stdout } = await execFileAsync('curl', [
      '-s',
      '-X', 'POST',
      url,
      '-H', `Authorization: Bearer ${accessToken}`,
      '-H', 'Content-Type: application/json',
      '-d', JSON.stringify({ message: fcmMessage }),
      '--max-time', '15',
      '-w', '\n__HTTP_STATUS__%{http_code}',
    ]);

    const parts      = stdout.split('\n__HTTP_STATUS__');
    const statusCode = parseInt(parts[1]?.trim() ?? '0', 10);
    const rawBody    = parts[0].trim();

    if (!rawBody || statusCode === 0) {
      throw new Error('FCM send request timed out');
    }

    let parsed: any;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new Error(`FCM non-JSON response (HTTP ${statusCode}): ${rawBody.slice(0, 200)}`);
    }

    if (statusCode !== 200) {
      // Token expired mid-flight? Invalidate cache and let caller retry once.
      if (statusCode === 401) {
        this.cachedToken    = null;
        this.tokenExpiresAt = 0;
      }
      throw new Error(`FCM error (HTTP ${statusCode}): ${JSON.stringify(parsed).slice(0, 300)}`);
    }

    return parsed.name as string; // e.g. "projects/xxx/messages/yyy"
  }

  // ─────────────────────────────────────────────────────────────────────────
  // admin.messaging.Message → FCM v1 REST shape converter
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Convert a firebase-admin Message object (v9 shape) into the FCM HTTP v1
   * REST API message body.  Only the fields used by AISignalService are mapped;
   * extend as needed.
   */
  private toRestMessage(message: admin.messaging.Message): object {
    const rest: Record<string, any> = {};

    // Routing
    if ('token'     in message) rest['token']     = (message as any).token;
    if ('topic'     in message) rest['topic']     = (message as any).topic;
    if ('condition' in message) rest['condition'] = (message as any).condition;

    // Data payload
    if (message.data) rest['data'] = message.data;

    // Notification
    if (message.notification) {
      rest['notification'] = {
        title: message.notification.title,
        body:  message.notification.body,
      };
    }

    // Android config
    const android = (message as any).android as admin.messaging.AndroidConfig | undefined;
    if (android) {
      const androidRest: Record<string, any> = {};

      if (android.priority) {
        androidRest['priority'] = android.priority === 'high' ? 'HIGH' : 'NORMAL';
      }

      if (android.ttl !== undefined) {
        // admin SDK accepts timedelta ms number; REST API wants "<seconds>s"
        const ttlMs = typeof android.ttl === 'number' ? android.ttl : (android.ttl as any);
        androidRest['ttl'] = `${Math.round(ttlMs / 1000)}s`;
      }

      const notif = android.notification as admin.messaging.AndroidNotification | undefined;
      if (notif) {
        androidRest['notification'] = {
          ...(notif.title     && { title:      notif.title }),
          ...(notif.body      && { body:       notif.body }),
          ...(notif.sound     && { sound:      notif.sound }),
          ...(notif.channelId && { channel_id: notif.channelId }),
          // Map priority string
          ...((notif as any).priority && {
            notification_priority:
              (notif as any).priority === 'high' ? 'PRIORITY_HIGH' : 'PRIORITY_DEFAULT',
          }),
        };
      }

      rest['android'] = androidRest;
    }

    // APNS config (pass-through if present)
    if ((message as any).apns) rest['apns'] = (message as any).apns;

    // WebPush config
    if ((message as any).webpush) rest['webpush'] = (message as any).webpush;

    return rest;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API  (identical signatures to original service)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Send a message to a specific device, topic, or condition.
   * Returns the FCM message name (e.g. "projects/xxx/messages/yyy").
   */
  async send(message: admin.messaging.Message): Promise<string> {
    try {
      const restMsg  = this.toRestMessage(message);
      const response = await this.curlFcmSend(restMsg);
      this.logger.log(`Message sent successfully: ${response}`);
      return response;
    } catch (error: any) {
      this.logger.error(`Failed to send message: ${error?.message || error}`);
      throw error;
    }
  }

  /**
   * Send a message to a topic (legacy sendToTopic API shape).
   * Maps notification + data payload onto FCM v1 format.
   */
  async sendToTopic(
    topic: string,
    payload: admin.messaging.MessagingPayload,
    _options?: admin.messaging.MessagingOptions,
  ): Promise<admin.messaging.MessagingTopicResponse> {
    try {
      const restMsg: Record<string, any> = { topic };
      if (payload.notification) restMsg['notification'] = payload.notification;
      if (payload.data)         restMsg['data']         = payload.data;

      await this.curlFcmSend(restMsg);
      this.logger.log(`Message sent to topic '${topic}'`);
      return { messageId: 0, failedRegistrationTokens: [] } as any;
    } catch (error: any) {
      this.logger.error(`Failed to send to topic '${topic}': ${error?.message || error}`);
      throw error;
    }
  }

  /**
   * Send a multicast message to multiple devices.
   * FCM v1 does not have a native multicast endpoint — we fan-out individually
   * and aggregate results, exactly like the admin SDK does internally.
   */
  async sendMulticast(
    message: admin.messaging.MulticastMessage,
  ): Promise<admin.messaging.BatchResponse> {
    const { tokens, ...rest } = message as any;
    const responses: admin.messaging.SendResponse[] = [];

    for (const token of tokens as string[]) {
      try {
        const msgName = await this.curlFcmSend(this.toRestMessage({ ...rest, token }));
        responses.push({ success: true, messageId: msgName } as any);
      } catch (err: any) {
        responses.push({ success: false, error: err } as any);
      }
    }

    const successCount = responses.filter(r => r.success).length;
    const failureCount = responses.length - successCount;

    this.logger.log(`Multicast sent: ${successCount} success, ${failureCount} failed`);
    return { responses, successCount, failureCount };
  }

  /**
   * Subscribe devices to a topic via the IID (Instance ID) REST API.
   * This endpoint is unrelated to OAuth2 token auth — it uses the server key,
   * which is NOT available from a service account. Kept as a stub that logs a
   * warning; topic subscriptions should be done client-side via the Flutter SDK.
   */
  async subscribeToTopic(tokens: string | string[], topic: string): Promise<void> {
    this.logger.warn(
      `subscribeToTopic('${topic}') is not supported via REST API without a legacy server key. ` +
      `Subscribe on the client side using Firebase SDK instead.`,
    );
  }

  async unsubscribeFromTopic(tokens: string | string[], topic: string): Promise<void> {
    this.logger.warn(
      `unsubscribeFromTopic('${topic}') is not supported via REST API without a legacy server key. ` +
      `Unsubscribe on the client side using Firebase SDK instead.`,
    );
  }
}