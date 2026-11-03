/** Merge follow-on speech until the answer starts, cancelling obsolete work first. */
export class LocalTurn {
  private text = '';
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private version = 0;
  private unheard = 0;
  get pendingText() { return this.text; }
  resetRecognition() { this.unheard = 0; }
  private send: (text: string, signal: AbortSignal) => Promise<void>;
  private cancel: () => Promise<unknown>;
  private cancellation = Promise.resolve<unknown>(undefined);
  constructor(send: (text: string, signal: AbortSignal) => Promise<void>, cancel: () => Promise<unknown>) { this.send = send; this.cancel = cancel; }
  private interrupt() { clearTimeout(this.timer); ++this.version; if (this.controller) { this.controller.abort(); this.controller = null; this.cancellation = this.cancellation.then(this.cancel).catch(() => undefined); } }
  speechStart() { ++this.unheard; this.interrupt(); }
  heard(text: string) {
    this.unheard = Math.max(0, this.unheard - 1);
    this.interrupt(); this.text = [this.text, text].filter(Boolean).join(' ');
    if (this.unheard || !this.text) return;
    const version = this.version;
    this.timer = setTimeout(() => {
      void this.cancellation.then(async () => {
        if (version !== this.version) return;
        const controller = new AbortController(); this.controller = controller;
        await this.send(this.text, controller.signal);
      }).catch(() => undefined);
    }, 1200);
  }
  answerStarted() { this.text = ''; this.controller = null; }
  dispose() { clearTimeout(this.timer); ++this.version; this.controller?.abort(); this.controller = null; this.text = ''; this.unheard = 0; }
}

export class SentenceStream {
  private buffer = '';
  private count = 0;
  push(text: string, final = false): string[] {
    this.buffer += text;
    const result: string[] = [];
    while (this.count < 3) {
      const match = /[.!?](?:[”"']?)(?:\s|$)/.exec(this.buffer);
      if (!match && !final) break;
      if (!this.buffer.trim()) break;
      const end = match ? match.index + match[0].length : this.buffer.length;
      result.push(this.buffer.slice(0, end).trim()); this.buffer = this.buffer.slice(end); this.count++;
    }
    return result;
  }
}
