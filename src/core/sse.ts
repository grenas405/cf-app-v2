/**
 * Server-sent events: a pure message formatter and a ReadableStream that
 * cleans up its timer and subscription when the client goes away.
 */
import type { Cancel, Clock, EventBus } from "./types.ts";

const encoder = new TextEncoder();

/** Slow clients are disconnected instead of buffering for them without limit. */
const MAX_QUEUED_MESSAGES = 100;

export const SSE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  "x-accel-buffering": "no",
};

export interface SseMessage {
  readonly event?: string;
  readonly data?: string;
  readonly id?: string;
  readonly retry?: number;
  readonly comment?: string;
}

/** Removes line breaks so a value cannot inject extra SSE fields. */
function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

export function formatSse(message: SseMessage): string {
  const lines: string[] = [];
  if (message.comment !== undefined) lines.push(`: ${singleLine(message.comment)}`);
  if (message.retry !== undefined) lines.push(`retry: ${Math.trunc(message.retry)}`);
  if (message.id !== undefined) lines.push(`id: ${singleLine(message.id)}`);
  if (message.event !== undefined) lines.push(`event: ${singleLine(message.event)}`);
  if (message.data !== undefined) {
    for (const line of message.data.split(/\r\n|\r|\n/)) lines.push(`data: ${line}`);
  }
  return `${lines.join("\n")}\n\n`;
}

export interface SseStreamOptions {
  readonly clock: Clock;
  readonly events: EventBus;
  readonly heartbeatMs: number;
  readonly retryMs: number;
}

/**
 * Streams every event published on the bus, plus a `ping` heartbeat that
 * keeps proxies from closing an idle connection. Cancelling the stream (the
 * client disconnecting) stops the heartbeat and unsubscribes.
 */
export function createSseStream(options: SseStreamOptions): ReadableStream<Uint8Array> {
  let cleanup: Cancel = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (message: SseMessage): void => {
        try {
          if (-(controller.desiredSize ?? 0) > MAX_QUEUED_MESSAGES) {
            cleanup();
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(formatSse(message)));
        } catch {
          // The stream is already closed or errored: stop producing.
          cleanup();
        }
      };
      const unsubscribe = options.events.subscribe((event) => {
        send({ event: event.event, data: JSON.stringify(event.data) });
      });
      const stopHeartbeat = options.clock.every(options.heartbeatMs, () => {
        send({ event: "ping", data: JSON.stringify({ time: new Date(options.clock.now()).toISOString() }) });
      });
      cleanup = () => {
        unsubscribe();
        stopHeartbeat();
      };
      send({ retry: options.retryMs, event: "ready", data: "{}" });
    },
    cancel() {
      cleanup();
    },
  });
}
