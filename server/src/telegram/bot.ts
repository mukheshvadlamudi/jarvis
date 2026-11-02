import type { Services } from '../app.ts';
import { all, get } from '../db/index.ts';
import type { Approval, Run, Task } from '../types.ts';
import { logger } from '../util/log.ts';

const log = logger('telegram');

export type TgFetch = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

interface Update {
  update_id: number;
  message?: { message_id: number; chat: { id: number }; text?: string };
  callback_query?: { id: string; data?: string; message?: { message_id: number; chat: { id: number }; text?: string } };
}

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
const STATUS_ICON: Record<string, string> = { running: '>', queued: '…', needs_you: '!', done: '✓', failed: '✗', cancelled: '–', inbox: '·' };

/**
 * Optional Telegram bot (SPEC §17): plain-fetch long polling, only the allowed chat. Any text becomes
 * a task; /status /tasks /usage /cancel; approval requests arrive with Approve/Reject buttons.
 */
export class TelegramBot {
  private s: Services;
  private token: string;
  private chatId: string;
  private offset = 0;
  private running = false;
  private abort: AbortController | null = null;
  private unsubscribe: (() => void) | null = null;
  fetcher: TgFetch = (url, init) => fetch(url, init);
  base = 'https://api.telegram.org';
  publicUrl: string;

  constructor(s: Services, token: string, chatId: string) {
    this.s = s;
    this.token = token;
    this.chatId = chatId;
    this.publicUrl = process.env.JARVIS_PUBLIC_URL?.replace(/\/$/, '') ?? `http://127.0.0.1:${s.env.port}`;
  }

  async api<T = any>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const res = await this.fetcher(`${this.base}/bot${this.token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
    const data = await res.json();
    if (!data?.ok) throw new Error(`Telegram ${method} failed: ${data?.description ?? res.status}`);
    return data.result as T;
  }

  send(text: string, extra: Record<string, unknown> = {}): Promise<unknown> {
    return this.api('sendMessage', { chat_id: this.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }).catch((err) => log.warn('send failed', err));
  }

  link(path: string): string {
    return `${this.publicUrl}${path}`;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.unsubscribe = this.s.bus.subscribe((e) => void this.onEvent(e.type, e.data));
    void this.loop();
    log.info('Telegram bot polling');
  }

  stop(): void {
    this.running = false;
    this.abort?.abort();
    this.unsubscribe?.();
  }

  private async loop(): Promise<void> {
    let backoff = 1000;
    while (this.running) {
      try {
        this.abort = new AbortController();
        const updates = await this.api<Update[]>('getUpdates', { offset: this.offset, timeout: 50, allowed_updates: ['message', 'callback_query'] }, this.abort.signal);
        backoff = 1000;
        // Long polling normally waits server-side; never spin if it returns at once.
        if (!updates.length) await new Promise((r) => setTimeout(r, 1000));
        for (const u of updates) {
          this.offset = u.update_id + 1;
          await this.handle(u).catch((err) => log.warn('update failed', err));
        }
      } catch (err) {
        if (!this.running) return;
        log.warn(`polling error, retrying in ${backoff / 1000}s`, err);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  /** Process one update. Messages from any other chat are ignored. */
  async handle(u: Update): Promise<void> {
    if (u.callback_query) {
      const q = u.callback_query;
      if (String(q.message?.chat.id) !== this.chatId) return;
      const m = /^a:(a_[a-z0-9]+):(approved|rejected)$/.exec(q.data ?? '');
      if (!m) return;
      const r = this.s.approvals.decide(m[1], m[2] as 'approved' | 'rejected', null, 'telegram');
      const text = 'error' in r ? `Already decided (${r.error.replace('already ', '')}).` : m[2] === 'approved' ? 'Approved ✓' : 'Rejected';
      await this.api('answerCallbackQuery', { callback_query_id: q.id, text }).catch(() => undefined);
      if (q.message && !('error' in r)) {
        await this.api('editMessageText', { chat_id: this.chatId, message_id: q.message.message_id, text: `${esc(q.message.text ?? '')}\n\n<b>${m[2] === 'approved' ? 'Approved' : 'Rejected'}</b> from Telegram`, parse_mode: 'HTML' }).catch(() => undefined);
      }
      return;
    }
    const msg = u.message;
    if (!msg || String(msg.chat.id) !== this.chatId || !msg.text) return;
    const text = msg.text.trim();
    const [cmd, ...rest] = text.split(/\s+/);
    switch (cmd.split('@')[0]) {
      case '/start':
      case '/help':
        await this.send('Send any message to create a task. Commands: /status · /tasks · /usage · /cancel &lt;task id&gt;');
        return;
      case '/status': {
        const c = this.s.tasks.counts();
        const active = all<Task>(this.s.db, "SELECT * FROM tasks WHERE status IN ('running','needs_you') ORDER BY updated_at DESC LIMIT 8");
        await this.send(
          [`<b>${c.running} running · ${c.queued} queued · ${c.needs_you} need you</b>`, `${this.s.approvals.pendingCount()} approvals pending`, '', ...active.map((t) => `${STATUS_ICON[t.status]} ${esc(t.title)} <code>${t.id}</code>`)].join('\n'),
        );
        return;
      }
      case '/tasks': {
        const tasks = all<Task>(this.s.db, "SELECT * FROM tasks WHERE status NOT IN ('done','cancelled','failed') OR updated_at >= ? ORDER BY updated_at DESC LIMIT 10", new Date(Date.now() - 86400_000).toISOString());
        await this.send(tasks.length ? tasks.map((t) => `${STATUS_ICON[t.status]} ${esc(t.title)} <code>${t.id}</code>`).join('\n') : 'No tasks in the last day.');
        return;
      }
      case '/usage': {
        const u = this.s.usage.current();
        const p = (w: { usedPercent: number } | null) => (w ? `${Math.round(w.usedPercent)}%` : '—');
        await this.send(`<b>Claude</b> 5h ${p(u.claude.five_hour)} · week ${p(u.claude.weekly)}\n<b>Codex</b> 5h ${p(u.codex.five_hour)} · week ${p(u.codex.weekly)}`);
        return;
      }
      case '/cancel': {
        const id = rest[0];
        if (!id || !this.s.tasks.get(id)) {
          await this.send('Usage: /cancel &lt;task id&gt; — ids are shown by /tasks.');
          return;
        }
        const t = await this.s.orchestrator.cancel(id);
        await this.send(`Cancelled: ${esc(t.title)}`);
        return;
      }
      default: {
        if (text.startsWith('/')) {
          await this.send('Unknown command. Try /help.');
          return;
        }
        const [title, ...body] = text.split('\n');
        const t = this.s.tasks.create({ title, body: body.join('\n').trim(), run: true });
        this.s.orchestrator.tick();
        const fresh = this.s.tasks.get(t.id)!;
        const route = fresh.route_reason ?? (await import('../router/index.ts')).decide(fresh, this.s.usage.current(), this.s.config.get().router).reason;
        await this.send(`Queued <b>${esc(fresh.title)}</b>\nRouting: ${esc(route)}\n${this.link(`/tasks/${t.id}`)}`);
      }
    }
  }

  /** Bus → Telegram notifications. */
  async onEvent(type: string, data: unknown): Promise<void> {
    if (type === 'approval.created') {
      const a = data as Approval;
      const detail = JSON.parse(a.detail_json || '{}') as { input?: { command?: string }; reason?: string };
      const task = a.task_id ? this.s.tasks.get(a.task_id) : undefined;
      const lines = [`<b>Approval needed</b>: ${esc(a.summary)}`];
      if (detail.reason) lines.push(`Why: ${esc(detail.reason)}`);
      if (detail.input?.command) lines.push(`<pre>${esc(detail.input.command.slice(0, 1500))}</pre>`);
      if (task) lines.push(`Task: ${esc(task.title)} — ${this.link(`/tasks/${task.id}`)}`);
      await this.send(lines.join('\n'), {
        reply_markup: { inline_keyboard: [[{ text: 'Approve', callback_data: `a:${a.id}:approved` }, { text: 'Reject', callback_data: `a:${a.id}:rejected` }]] },
      });
    } else if (type === 'run.finished') {
      const r = data as Run;
      if ((r.route_reason ?? '').startsWith('learning')) return;
      const t = this.s.tasks.get(r.task_id);
      if (!t || (t.status !== 'done' && t.status !== 'failed')) return;
      const brief = t.schedule_id ? get<{ built_in: string | null }>(this.s.db, 'SELECT built_in FROM schedules WHERE id = ?', t.schedule_id)?.built_in === 'morning_brief' : false;
      const summary = t.result_summary ?? '';
      const body = brief ? summary.slice(0, 3500) : summary.length > 600 ? `${summary.slice(0, 597)}…` : summary;
      await this.send(`${t.status === 'done' ? '✓' : '✗'} <b>${esc(t.title)}</b>\n${esc(body)}\n${this.link(`/tasks/${t.id}`)}`);
    } else if (type === 'notify') {
      const n = data as { message: string; level?: string; taskTitle?: string | null };
      await this.send(`${n.level === 'warning' ? 'Warning: ' : ''}${esc(n.message)}${n.taskTitle ? `\n— ${esc(n.taskTitle)}` : ''}`);
    }
  }
}
