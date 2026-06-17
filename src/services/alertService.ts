import pino from 'pino';

const logger = pino({ name: 'alerts' });

class AlertService {
  private botToken = process.env.TELEGRAM_BOT_TOKEN ?? '';
  private chatId = process.env.TELEGRAM_CHAT_ID ?? '';
  private cooldowns = new Map<string, number>();

  async send(message: string, dedupeKey?: string): Promise<void> {
    // Simple deduplication: same key → max once per 5 min
    if (dedupeKey) {
      const last = this.cooldowns.get(dedupeKey) ?? 0;
      if (Date.now() - last < 5 * 60_000) return;
      this.cooldowns.set(dedupeKey, Date.now());
    }

    logger.warn({ alert: message }, 'ALERT');

    if (!this.botToken || !this.chatId) return;

    try {
      await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: message,
          parse_mode: 'HTML',
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      logger.error({ err }, 'Failed to send Telegram alert');
    }
  }

  async critical(message: string): Promise<void> {
    return this.send(`🚨 <b>CRITICAL</b>\n${message}`, message.slice(0, 60));
  }

  async info(message: string): Promise<void> {
    return this.send(`ℹ️ ${message}`);
  }
}

export const alertService = new AlertService();
