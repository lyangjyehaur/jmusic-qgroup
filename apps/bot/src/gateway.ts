import { abortable as wait, within, delay } from './lifecycle';
import { randomUUID } from 'node:crypto';
import { createBotObserver, safeError, type BotObserver } from './observability';
import { gatewayCloseAction, object, reference, type APIObject } from './protocol';
export type GatewaySocket = Pick<
  WebSocket,
  'readyState' | 'send' | 'close' | 'addEventListener' | 'removeEventListener'
>;
export interface GatewayDispatch {
  op: 0;
  t: string;
  s: number;
  d: unknown;
  id?: string;
}
export interface GatewayState {
  connected: boolean;
  last_ack: number | null;
  last_ready: number | null;
  reconnects: number;
  sequence: number | null;
}
export interface GatewayAPI {
  gateway: (signal?: AbortSignal) => Promise<string>;
  auth: (signal?: AbortSignal) => Promise<string>;
}
export class GatewayFatalError extends Error {
  constructor(readonly code: number) {
    super('QQ gateway 拒絕重連，請核對平台設定');
    this.name = 'GatewayFatalError';
  }
}
export interface GatewayOptions {
  api: GatewayAPI;
  intents: number;
  onDispatch: (event: GatewayDispatch, signal: AbortSignal) => Promise<void>;
  observer?: BotObserver;
  onState?: (state: GatewayState) => void;
  socket?: (url: string) => GatewaySocket;
  now?: () => number;
  allowLoopback?: boolean;
  maxQueuedDispatches?: number;
  dispatchTimeoutMs?: number;
  connectTimeoutMs?: number;
}
function safeGatewayURL(raw: string, loopback: boolean) {
  const url = new URL(raw);
  if (
    url.username ||
    url.password ||
    url.hash ||
    !(
      url.protocol === 'wss:' ||
      (loopback && url.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    )
  )
    throw Error('Invalid gateway URL');
  return url;
}
/** Transport only. It never opens a database, claims outbox work, or starts on import. */
export class QQGateway {
  #session: string | null = null;
  #sequence: number | null = null;
  #running = false;
  #state: GatewayState = { connected: false, last_ack: null, last_ready: null, reconnects: 0, sequence: null };
  readonly #observer: BotObserver;
  readonly #now: () => number;
  constructor(private readonly options: GatewayOptions) {
    this.#observer = options.observer ?? createBotObserver();
    this.#now = options.now ?? Date.now;
  }
  state() {
    return { ...this.#state, sequence: this.#sequence };
  }
  #notify() {
    try {
      this.options.onState?.(this.state());
    } catch (error) {
      this.#observer.event('health_state_unavailable', safeError(error));
    }
  }
  #forget() {
    this.#session = null;
    this.#sequence = null;
  }
  async run(signal: AbortSignal) {
    if (this.#running) throw Error('Gateway is already running');
    this.#running = true;
    let backoff = 2000,
      resumeFailures = 0;
    try {
      while (!signal.aborted) {
        const wasResume = this.#session !== null && this.#sequence !== null;
        let outcome: { code: number; ready: boolean };
        try {
          const raw = await wait(this.options.api.gateway(signal), signal);
          if (signal.aborted) break;
          const url = safeGatewayURL(raw, this.options.allowLoopback ?? false);
          this.#observer.event('websocket_connecting', { gateway_host: url.hostname });
          outcome = await this.#connect(url.href, signal);
        } catch (error) {
          if (signal.aborted) break;
          this.#observer.event('websocket_disconnected', safeError(error));
          outcome = { code: 1006, ready: false };
        }
        if (signal.aborted) break;
        const action = gatewayCloseAction(outcome.code);
        if (action === 'stop') {
          this.#observer.event('websocket_reconnect_stopped', { close_code: outcome.code });
          throw new GatewayFatalError(outcome.code);
        }
        if (action === 'identify') this.#forget();
        if (outcome.ready) {
          backoff = 2000;
          resumeFailures = 0;
        } else if (wasResume && ++resumeFailures >= 3) {
          this.#forget();
          resumeFailures = 0;
        }
        this.#state.reconnects++;
        this.#notify();
        this.#observer.event('websocket_reconnecting', {
          close_code: outcome.code,
          reconnect_in_seconds: backoff / 1000,
          reconnects: this.#state.reconnects,
        });
        try {
          await delay(backoff, signal);
        } catch {
          if (signal.aborted) break;
          throw Error('Reconnect wait failed');
        }
        backoff = Math.min(backoff * 2, 60000);
      }
    } finally {
      this.#running = false;
      this.#state.connected = false;
      this.#notify();
    }
  }
  #connect(url: string, external: AbortSignal) {
    return new Promise<{ code: number; ready: boolean }>((resolve, reject) => {
      let socket: GatewaySocket;
      try {
        socket = (this.options.socket ?? ((value) => new WebSocket(value)))(url);
      } catch (error) {
        reject(error);
        return;
      }
      const lifetime = new AbortController(),
        queue: GatewayDispatch[] = [];
      let done = false,
        hello = false,
        identified = false,
        ready = false,
        working = false,
        received = this.#sequence,
        lastAckAt = this.#now(),
        awaitingAck = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
      const finish = (code = 1006) => {
        if (done) return;
        done = true;
        clearTimeout(deadline);
        clearInterval(heartbeat);
        lifetime.abort();
        queue.length = 0;
        external.removeEventListener('abort', abort);
        socket.removeEventListener('message', message);
        socket.removeEventListener('close', closed);
        socket.removeEventListener('error', failed);
        try {
          if (socket.readyState < 2) socket.close(1000);
        } catch {
          /* A closed transport cannot be reused. */
        }
        this.#state.connected = false;
        this.#notify();
        resolve({ code, ready });
      };
      const abort = () => finish(1000),
        closed = (event: CloseEvent) => finish(event.code),
        failed = () => finish(1006);
      const send = (frame: APIObject) => {
        if (done || external.aborted) return false;
        try {
          if (socket.readyState !== 1) throw Error();
          socket.send(JSON.stringify(frame));
          return true;
        } catch {
          finish();
          return false;
        }
      };
      const beat = () => {
        if (!identified) return;
        if (send({ op: 1, d: received })) awaitingAck = true;
      };
      const processQueue = async () => {
        if (working) return;
        working = true;
        try {
          while (queue.length && !done) {
            const event = queue.shift()!;
            if (this.#sequence !== null && event.s <= this.#sequence) continue;
            const scope = {
              trace_id: randomUUID().replaceAll('-', ''),
              input_ref: reference(object(event.d) ? event.d.id : event.id),
              platform_event_ref: reference(event.id),
            };
            try {
              await within(this.options.dispatchTimeoutMs ?? 30000, lifetime.signal, (taskSignal) =>
                Promise.resolve(this.#observer.scope(scope, () => this.options.onDispatch(event, taskSignal))),
              );
            } catch (error) {
              if (!done) {
                this.#observer.event('dispatch_failed', { ...scope, ...safeError(error) });
                finish();
              }
              return;
            }
            if (done || external.aborted) return;
            this.#sequence = event.s;
            if (event.t === 'READY') {
              if (
                !object(event.d) ||
                typeof event.d.session_id !== 'string' ||
                !event.d.session_id ||
                event.d.session_id.length > 1024
              ) {
                this.#observer.event('platform_frame_invalid', { reason: 'invalid_ready' });
                this.#forget();
                finish();
                return;
              }
              this.#session = event.d.session_id;
              this.#observer.event('websocket_ready', {
                session_ref: reference(this.#session),
                bot_id_ref: reference(object(event.d.user) ? event.d.user.id : null),
              });
            }
            if (event.t === 'READY' || event.t === 'RESUMED') {
              ready = true;
              clearTimeout(deadline);
              this.#state.last_ready = this.#now() / 1000;
              this.#state.connected = true;
            }
            this.#notify();
          }
        } finally {
          working = false;
        }
      };
      const message = (event: MessageEvent<unknown>) => {
        if (done) return;
        let frame: unknown;
        if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > 1024 * 1024) {
          this.#observer.event('platform_frame_invalid', { reason: 'invalid_frame_size_or_type' });
          finish();
          return;
        }
        try {
          frame = JSON.parse(event.data);
        } catch {
          this.#observer.event('platform_frame_invalid', { reason: 'invalid_json' });
          return;
        }
        if (!object(frame) || !Number.isSafeInteger(frame.op)) {
          this.#observer.event('platform_frame_invalid', { reason: 'invalid_envelope' });
          return;
        }
        if (frame.op === 10) {
          if (hello) {
            this.#observer.event('platform_frame_invalid', { reason: 'repeated_hello' });
            finish();
            return;
          }
          hello = true;
          const interval =
            object(frame.d) && frame.d.heartbeat_interval !== undefined ? frame.d.heartbeat_interval : 45000;
          if (typeof interval !== 'number' || !Number.isFinite(interval) || interval < 1 || interval > 3600000) {
            this.#observer.event('platform_frame_invalid', { reason: 'invalid_heartbeat_interval' });
            finish();
            return;
          }
          clearTimeout(deadline);
          deadline = setTimeout(() => {
            this.#observer.event('websocket_handshake_timeout');
            finish();
          }, this.options.connectTimeoutMs ?? 20000);
          lastAckAt = this.#now();
          void this.options.api
            .auth(lifetime.signal)
            .then((token) => {
              if (done || external.aborted) return;
              const resume = this.#session !== null && this.#sequence !== null;
              const sent = send(
                resume
                  ? { op: 6, d: { token, session_id: this.#session, seq: this.#sequence } }
                  : {
                      op: 2,
                      d: {
                        token,
                        intents: this.options.intents,
                        shard: [0, 1],
                        properties: { $os: process.platform, $browser: 'qgroup-bot', $device: 'qgroup-bot' },
                      },
                    },
              );
              if (!sent) return;
              identified = true;
              this.#observer.event(
                resume ? 'websocket_resuming' : 'websocket_identified',
                resume ? { session_ref: reference(this.#session) } : { intents: this.options.intents },
              );
              heartbeat = setInterval(
                () => {
                  if (this.#now() - lastAckAt > Math.max(interval * 3, 120000)) {
                    this.#observer.event('heartbeat_ack_timeout', {
                      seconds_since_ack: Math.floor((this.#now() - lastAckAt) / 1000),
                    });
                    finish();
                    return;
                  }
                  beat();
                },
                Math.max(interval * 0.9, 1000),
              );
            })
            .catch((error) => {
              if (!done) {
                this.#observer.event('websocket_auth_failed', safeError(error));
                finish();
              }
            });
        } else if (frame.op === 11) {
          if (awaitingAck) {
            lastAckAt = this.#now();
            awaitingAck = false;
            this.#state.last_ack = lastAckAt / 1000;
            this.#notify();
            this.#observer.event('heartbeat_ack');
          }
        } else if (frame.op === 1) {
          beat();
          this.#observer.event('heartbeat_requested');
        } else if (frame.op === 9) {
          this.#forget();
          this.#observer.event('websocket_invalid_session');
          finish(4006);
        } else if (frame.op === 7) {
          this.#observer.event('websocket_reconnect_requested');
          finish();
        } else if (frame.op === 0) {
          if (
            !identified ||
            typeof frame.t !== 'string' ||
            !frame.t ||
            !Number.isSafeInteger(frame.s) ||
            (frame.s as number) < 0
          ) {
            this.#observer.event('platform_frame_invalid', { reason: 'invalid_dispatch' });
            finish();
            return;
          }
          if (
            frame.t === 'READY' &&
            (!object(frame.d) ||
              typeof frame.d.session_id !== 'string' ||
              !frame.d.session_id ||
              frame.d.session_id.length > 1024)
          ) {
            this.#observer.event('platform_frame_invalid', { reason: 'invalid_ready' });
            this.#forget();
            finish();
            return;
          }
          received = Math.max(received ?? 0, frame.s as number);
          if (queue.length + Number(working) >= (this.options.maxQueuedDispatches ?? 128)) {
            this.#observer.event('dispatch_queue_full');
            finish();
            return;
          }
          queue.push({
            op: 0,
            t: frame.t,
            s: frame.s as number,
            d: frame.d,
            ...(typeof frame.id === 'string' ? { id: frame.id } : {}),
          });
          void processQueue();
        }
      };
      socket.addEventListener('message', message);
      socket.addEventListener('close', closed);
      socket.addEventListener('error', failed);
      external.addEventListener('abort', abort, { once: true });
      deadline = setTimeout(() => {
        this.#observer.event('websocket_hello_timeout');
        finish();
      }, this.options.connectTimeoutMs ?? 20000);
      if (external.aborted) abort();
    });
  }
}
