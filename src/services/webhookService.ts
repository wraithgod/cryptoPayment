import { createHmac } from 'crypto';
import { URL } from 'url';
import { WebhookEventType } from '@prisma/client';
import { prisma } from '../db';
import { config } from '../config';
import { getSettings } from './settingsService';
import { WebhookPayload } from '../types';

// SSRF blocklist — block requests to private/link-local/loopback ranges
const SSRF_FORBIDDEN = /^(localhost$|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|::1$|fc00:|fe80:)/i;

export function isSafeWebhookUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return false;
    if (SSRF_FORBIDDEN.test(url.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

export class WebhookService {
  async queueWebhook(
    eventType: WebhookEventType,
    payload: WebhookPayload,
    paymentId?: string,
    withdrawalId?: string,
  ): Promise<void> {
    await prisma.webhookEvent.create({
      data: {
        eventType,
        payload: JSON.parse(JSON.stringify(payload)),
        paymentId,
        withdrawalId,
        nextRetryAt: new Date(),
        maxAttempts: config.webhook.maxRetries,
      },
    });
  }

  async deliverPending(): Promise<void> {
    const BATCH_SIZE = 100;
    const MAX_BATCHES = 20;

    const settings = await getSettings();

    for (let i = 0; i < MAX_BATCHES; i++) {
      const events = await prisma.webhookEvent.findMany({
        where: {
          deliveredAt: null,
          attempts: { lt: prisma.webhookEvent.fields.maxAttempts },
          nextRetryAt: { lte: new Date() },
        },
        take: BATCH_SIZE,
      });

      if (events.length === 0) break;
      await Promise.allSettled(events.map((event) => this.deliver(event, settings)));
      if (events.length < BATCH_SIZE) break;
    }
  }

  private async deliver(
    event: {
      id: string;
      payload: unknown;
      attempts: number;
      maxAttempts: number;
    },
    settings: { webhookUrl?: string | null; webhookSecret?: string | null },
  ): Promise<void> {
    if (!settings.webhookUrl) {
      await prisma.webhookEvent.update({
        where: { id: event.id },
        data: { deliveredAt: new Date() },
      });
      return;
    }

    // SSRF guard — validate before every delivery, not just at creation time
    if (!isSafeWebhookUrl(settings.webhookUrl)) {
      await this.scheduleRetry(event, 'Webhook URL is not allowed (SSRF policy)');
      return;
    }

    const body = JSON.stringify(event.payload);
    const timestamp = new Date().toISOString();

    // Sign `timestamp.body` so recipients can detect replays by checking the timestamp
    const signature = settings.webhookSecret
      ? this.sign(`${timestamp}.${body}`, settings.webhookSecret)
      : undefined;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Webhook-ID': event.id,
      'X-Timestamp': timestamp,
    };
    // Format: `t=<iso>,v1=<hmac>` — recipients verify HMAC(secret, `t.body`)
    if (signature) headers['X-Signature'] = `t=${timestamp},v1=${signature}`;

    try {
      const response = await fetch(settings.webhookUrl, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(10000),
      });

      if (response.ok) {
        await prisma.webhookEvent.update({
          where: { id: event.id },
          data: { deliveredAt: new Date(), attempts: event.attempts + 1 },
        });
      } else {
        await this.scheduleRetry(event, `HTTP ${response.status}`);
      }
    } catch (err) {
      await this.scheduleRetry(event, err instanceof Error ? err.message : 'Network error');
    }
  }

  private async scheduleRetry(
    event: { id: string; attempts: number; maxAttempts: number },
    error: string,
  ): Promise<void> {
    const nextAttempt = event.attempts + 1;
    if (nextAttempt >= event.maxAttempts) {
      await prisma.webhookEvent.update({
        where: { id: event.id },
        data: { attempts: nextAttempt, lastError: error, nextRetryAt: null },
      });
      return;
    }

    // Exponential backoff: 5s, 25s, 125s, 625s, …
    const delayMs = config.webhook.retryDelayMs * Math.pow(5, event.attempts);
    const nextRetryAt = new Date(Date.now() + delayMs);

    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: { attempts: nextAttempt, lastError: error, nextRetryAt },
    });
  }

  private sign(data: string, secret: string): string {
    return createHmac('sha256', secret).update(data).digest('hex');
  }
}

export const webhookService = new WebhookService();
