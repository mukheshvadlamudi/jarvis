export interface BusEvent {
  type: string;
  data: unknown;
}

type Listener = (e: BusEvent) => void;

/**
 * In-process pub/sub. SSE clients, Telegram notifications and internal hooks subscribe here.
 * Listeners must be cheap; slow consumers buffer on their own side.
 */
export class EventBus {
  private listeners = new Set<Listener>();

  publish(type: string, data: unknown): void {
    const e = { type, data };
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        // a broken listener must never break the publisher
      }
    }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get size(): number {
    return this.listeners.size;
  }
}
