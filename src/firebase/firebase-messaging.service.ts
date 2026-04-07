import { Injectable, Logger } from '@nestjs/common';
import * as admin from 'firebase-admin';

@Injectable()
export class FirebaseMessagingService {
  private readonly logger = new Logger(FirebaseMessagingService.name);

  /**
   * Send a message to a specific device, topic, or condition
   */
  async send(message: admin.messaging.Message): Promise<string> {
    try {
      const response = await admin.messaging().send(message);
      this.logger.log(`Message sent successfully: ${response}`);
      return response;
    } catch (error: any) {
      this.logger.error(`Failed to send message: ${error?.message || error}`, error?.stack);
      throw error;
    }
  }

  /**
   * Send a message to a topic
   */
  async sendToTopic(
    topic: string,
    payload: admin.messaging.MessagingPayload,
    options?: admin.messaging.MessagingOptions,
  ): Promise<admin.messaging.MessagingTopicResponse> {
    try {
      const response = await admin.messaging().sendToTopic(topic, payload, options);
      this.logger.log(`Message sent to topic '${topic}': ${response.messageId}`);
      return response;
    } catch (error: any) {
      this.logger.error(`Failed to send to topic '${topic}': ${error?.message || error}`, error?.stack);
      throw error;
    }
  }

  /**
   * Send a multicast message to multiple devices
   */
  async sendMulticast(
    message: admin.messaging.MulticastMessage,
  ): Promise<admin.messaging.BatchResponse> {
    try {
      const response = await admin.messaging().sendMulticast(message);
      this.logger.log(
        `Multicast sent: ${response.successCount} success, ${response.failureCount} failed`,
      );
      return response;
    } catch (error: any) {
      this.logger.error(`Failed to send multicast: ${error?.message || error}`, error?.stack);
      throw error;
    }
  }

  /**
   * Subscribe devices to a topic
   */
  async subscribeToTopic(tokens: string | string[], topic: string): Promise<void> {
    const tokenArray = Array.isArray(tokens) ? tokens : [tokens];
    try {
      await admin.messaging().subscribeToTopic(tokenArray, topic);
      this.logger.log(`Subscribed ${tokenArray.length} token(s) to topic '${topic}'`);
    } catch (error: any) {
      this.logger.error(`Failed to subscribe to topic: ${error?.message || error}`, error?.stack);
      throw error;
    }
  }

  /**
   * Unsubscribe devices from a topic
   */
  async unsubscribeFromTopic(tokens: string | string[], topic: string): Promise<void> {
    const tokenArray = Array.isArray(tokens) ? tokens : [tokens];
    try {
      await admin.messaging().unsubscribeFromTopic(tokenArray, topic);
      this.logger.log(`Unsubscribed ${tokenArray.length} token(s) from topic '${topic}'`);
    } catch (error: any) {
      this.logger.error(`Failed to unsubscribe from topic: ${error?.message || error}`, error?.stack);
      throw error;
    }
  }
}