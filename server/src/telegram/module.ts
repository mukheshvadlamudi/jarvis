import type { Services } from '../app.ts';
import { TelegramBot } from './bot.ts';

/** Starts the bot only when TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_CHAT_ID are set and it is enabled in settings. */
export function setupTelegram(s: Services): TelegramBot | null {
  if (!s.env.telegramToken || !s.env.telegramChatId) return null;
  const bot = new TelegramBot(s, s.env.telegramToken, s.env.telegramChatId);
  s.modules.telegram = bot;
  s.starters.push(() => {
    if (s.config.get().telegram.enabled) bot.start();
  });
  s.config.onChange((c) => (c.telegram.enabled ? bot.start() : bot.stop()));
  s.closers.push(() => bot.stop());
  return bot;
}
