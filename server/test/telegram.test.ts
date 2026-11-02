import { afterEach, describe, expect, it } from 'vitest';
import { TelegramBot } from '../src/telegram/bot.ts';
import { makeCtx, waitFor } from './helpers.ts';
import type { TestCtx } from './helpers.ts';

let ctx: TestCtx;
afterEach(async () => ctx?.close());

function fakeBot(c: TestCtx) {
  const sent: Array<{ method: string; body: any }> = [];
  const bot = new TelegramBot(c.s, 'TOKEN', '42');
  bot.fetcher = async (url, init) => {
    const method = url.split('/').pop()!;
    expect(url).toBe(`https://api.telegram.org/botTOKEN/${method}`);
    sent.push({ method, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: method === 'getUpdates' ? [] : { message_id: 1 } }) };
  };
  return { bot, sent };
}

const msg = (text: string, chat = 42) => ({ update_id: 1, message: { message_id: 9, chat: { id: chat }, text } });

describe('telegram bot', () => {
  it('turns text into a task and replies with the routing', async () => {
    ctx = makeCtx({ mockDelayMs: 1 });
    const { bot, sent } = fakeBot(ctx);
    await bot.handle(msg('Research the best uptime monitors'));
    const t = ctx.s.tasks.list({ q: 'uptime monitors' })[0];
    expect(t).toBeTruthy();
    expect(sent[0].body.chat_id).toBe('42');
    expect(sent[0].body.text).toMatch(/Queued <b>Research the best uptime monitors<\/b>\nRouting: research → codex/);
    expect(sent[0].body.text).toContain(`/tasks/${t.id}`);
  });

  it('ignores other chats', async () => {
    ctx = makeCtx();
    const { bot, sent } = fakeBot(ctx);
    await bot.handle(msg('Delete everything', 999));
    expect(sent).toHaveLength(0);
    expect(ctx.s.tasks.list()).toHaveLength(0);
  });

  it('answers /status, /usage, /tasks and /cancel', async () => {
    ctx = makeCtx({ mockDelayMs: 5 });
    const { bot, sent } = fakeBot(ctx);
    const t = ctx.s.tasks.create({ title: 'Watch the build [mock:long]' });
    ctx.s.orchestrator.tick();
    await waitFor(() => ctx.s.tasks.get(t.id)?.status === 'running');
    await bot.handle(msg('/status'));
    expect(sent.at(-1)!.body.text).toContain('1 running');
    await bot.handle(msg('/usage'));
    expect(sent.at(-1)!.body.text).toMatch(/<b>Claude<\/b> 5h/);
    await bot.handle(msg('/tasks'));
    expect(sent.at(-1)!.body.text).toContain(t.id);
    await bot.handle(msg(`/cancel ${t.id}`));
    await waitFor(() => ctx.s.tasks.get(t.id)?.status === 'cancelled');
    expect(sent.at(-1)!.body.text).toContain('Cancelled');
  });

  it('sends approvals with buttons and applies decisions from callbacks', async () => {
    ctx = makeCtx({ mockDelayMs: 1 });
    const { bot, sent } = fakeBot(ctx);
    bot.start();
    const t = ctx.s.tasks.create({ title: 'Ship the fix [mock:approval]', type: 'code' });
    ctx.s.orchestrator.tick();
    await waitFor(() => sent.some((x) => x.method === 'sendMessage' && x.body.reply_markup));
    const card = sent.find((x) => x.body.reply_markup)!;
    expect(card.body.text).toContain('<b>Approval needed</b>: Push jarvis/');
    const [approve] = card.body.reply_markup.inline_keyboard[0];
    await bot.handle({ update_id: 2, callback_query: { id: 'cq', data: approve.callback_data, message: { message_id: 5, chat: { id: 42 }, text: 'Approval needed' } } });
    await waitFor(() => ctx.s.tasks.get(t.id)?.status === 'done');
    expect(ctx.s.approvals.list()[0]).toMatchObject({ status: 'approved', decided_via: 'telegram' });
    expect(sent.some((x) => x.method === 'answerCallbackQuery' && x.body.text === 'Approved ✓')).toBe(true);
    await waitFor(() => sent.some((x) => x.method === 'sendMessage' && /^✓ <b>Ship the fix/.test(x.body.text)));
    bot.stop();
  });
});
