import { randomUUID } from 'node:crypto';
import { checkAbort as aborted, abortable as withAbort, within } from './lifecycle';
import type { BotConfig } from './config';
import { createBotObserver, safeError, type BotObserver } from './observability';
import {
  AUTH_CODES,
  apiCode,
  classifyAPIError,
  endpoint,
  object,
  platformTrace,
  reference,
  validPlatformId,
  type APIObject,
} from './protocol';
export interface HTTPResult {
  status: number;
  data: unknown;
  trace?: string | null;
}
export type BotRequest = (
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload: unknown,
  headers: Record<string, string>,
  signal: AbortSignal,
) => Promise<HTTPResult>;
export interface BotAPIResult {
  ok: boolean;
  code: number | null;
  data: APIObject;
  status: number;
  kind: 'ok' | ReturnType<typeof classifyAPIError>;
  platformTrace: string | null;
}
class BotTransportError extends Error {
  constructor() {
    super('QQ 平台連線失敗');
    this.name = 'BotTransportError';
  }
}
export async function fetchBotJSON(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload: unknown,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<HTTPResult> {
  try {
    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(payload !== undefined && payload !== null ? { body: JSON.stringify(payload) } : {}),
      signal,
      redirect: 'manual',
    });
    const chunks: Uint8Array[] = [],
      reader = response.body?.getReader();
    let size = 0;
    if (reader)
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 1024 * 1024) {
            await reader.cancel();
            return { status: response.status, data: { error_type: 'ResponseTooLarge' } };
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
    let data: unknown = {};
    const text = Buffer.concat(chunks).toString('utf8');
    try {
      data = JSON.parse(text || '{}');
    } catch {
      data = { raw: true };
    }
    return { status: response.status, data, trace: platformTrace(response.headers.get('X-Tps-trace-ID')) };
  } catch (error) {
    if (signal.aborted) throw error;
    return { status: 0, data: { error_type: safeError(error).error_type } };
  }
}
export class QQBotAPI {
  #base: string;
  #token = '';
  #expiry = 0;
  #flight?: Promise<string>;
  #closed = new AbortController();
  readonly #request: BotRequest;
  readonly #observer: BotObserver;
  readonly #clock: () => number;
  readonly #hosts: readonly string[];
  readonly #timeout: number;
  constructor(
    private readonly config: Pick<BotConfig, 'appId' | 'appSecret' | 'apiBase' | 'legacyApiBase'>,
    options: {
      request?: BotRequest;
      observer?: BotObserver;
      now?: () => number;
      tokenHosts?: readonly string[];
      timeoutMs?: number;
    } = {},
  ) {
    this.#base = config.apiBase;
    this.#request = options.request ?? fetchBotJSON;
    this.#observer = options.observer ?? createBotObserver();
    this.#clock = options.now ?? Date.now;
    this.#hosts = options.tokenHosts ?? ['https://api.bot.qq.com', 'https://bots.qq.com'];
    this.#timeout = options.timeoutMs ?? 15000;
  }
  get base() {
    return this.#base;
  }
  close() {
    this.#closed.abort();
    this.#token = '';
    this.#expiry = 0;
  }
  async #http(
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    body: unknown,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ) {
    const parent = AbortSignal.any([this.#closed.signal, ...(signal ? [signal] : [])]);
    try {
      return await within(this.#timeout, parent, (combined) => this.#request(method, url, body, headers, combined));
    } catch (error) {
      aborted(this.#closed.signal);
      aborted(signal);
      return { status: 0, data: { error_type: safeError(error).error_type } };
    }
  }

  async token(force = false, signal?: AbortSignal): Promise<string> {
    aborted(this.#closed.signal);
    aborted(signal);
    if (!force && this.#token && this.#clock() < this.#expiry) return this.#token;
    if (!this.#flight) {
      const flight = this.#refresh();
      this.#flight = flight;
      void flight.then(
        () => {
          if (this.#flight === flight) this.#flight = undefined;
        },
        () => {
          if (this.#flight === flight) this.#flight = undefined;
        },
      );
    }
    return withAbort(this.#flight, signal);
  }
  async #refresh() {
    let status = 0,
      code: number | null = null;
    for (const host of this.#hosts) {
      aborted(this.#closed.signal);
      try {
        const response = await this.#http(
            'POST',
            host + '/app/getAppAccessToken',
            { appId: this.config.appId, clientSecret: this.config.appSecret },
            {},
          ),
          data = response.data;
        status = response.status;
        code = apiCode(data);
        if (object(data) && typeof data.access_token === 'string' && /^\S{1,8192}$/.test(data.access_token)) {
          const raw =
              typeof data.expires_in === 'number' || typeof data.expires_in === 'string'
                ? Number(data.expires_in)
                : NaN,
            lifetime = Number.isFinite(raw) ? raw : 7200;
          this.#token = data.access_token;
          this.#expiry = this.#clock() + Math.max(lifetime - 120, 60) * 1000;
          this.#observer.event('token_refreshed', { expires_in_seconds: lifetime });
          return this.#token;
        }
      } catch (error) {
        if (this.#closed.signal.aborted) throw error;
        this.#observer.event('token_refresh_transport_failed', safeError(error));
      }
      this.#observer.event('token_refresh_failed', { http_status: status, api_code: code });
    }
    throw new BotTransportError();
  }
  async auth(signal?: AbortSignal) {
    return 'QQBot ' + (await this.token(false, signal));
  }
  async gateway(signal?: AbortSignal) {
    for (const base of [...new Set([this.#base, this.config.legacyApiBase])]) {
      try {
        const response = await this.#http(
          'GET',
          base + '/gateway',
          null,
          { Authorization: await this.auth(signal) },
          signal,
        );
        if (object(response.data) && typeof response.data.url === 'string') {
          const url = new URL(response.data.url);
          if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash)
            throw new BotTransportError();
          this.#base = base;
          this.#observer.event('gateway_resolved', { api_host: new URL(base).hostname });
          return url.href;
        }
        this.#observer.event('gateway_failed', {
          http_status: response.status,
          api_code: apiCode(response.data),
          api_host: new URL(base).hostname,
        });
      } catch (error) {
        aborted(signal);
        aborted(this.#closed.signal);
        this.#observer.event('gateway_failed', safeError(error));
      }
    }
    this.#base = this.config.legacyApiBase;
    return 'wss://api.bot.qq.com/websocket/';
  }
  async post(path: string, payload: APIObject, signal?: AbortSignal, beforeSend?: () => void | Promise<void>): Promise<BotAPIResult> {
    return this.#observer.scope({ trace_id: this.#observer.traceId() }, async () => {
      for (const attempt of [1, 2]) {
        if (!path.startsWith('/') || path.startsWith('//')) throw new BotTransportError();
        const token = await this.token(false, signal),
          started = this.#clock(),
          fields = {
            endpoint: endpoint(path),
            method: 'POST',
            api_attempt: attempt,
            request_ref: reference(randomUUID()),
          };
        // Revalidate after token acquisition, including an authorization retry.
        await beforeSend?.();
        aborted(signal);
        this.#observer.event('api_request', fields);
        let response: HTTPResult;
        try {
          response = await this.#http('POST', this.#base + path, payload, { Authorization: 'QQBot ' + token }, signal);
        } catch (error) {
          this.#observer.event('api_exception', { ...fields, ...safeError(error) });
          throw error;
        }
        const status = response.status,
          code = apiCode(response.data),
          data: APIObject = object(response.data) ? { ...response.data } : { raw: true },
          trace = platformTrace(data.trace_id) ?? platformTrace(response.trace);
        const malformed = !object(response.data) || 'raw' in data || 'error_type' in data,
          unconfirmed = status >= 200 && status < 300 && status !== 200;
        if (unconfirmed) data._unconfirmed_http = status;
        else if (status !== 200) data._http_status = status;
        const ok = status === 200 && (code === null || code === 0) && !malformed,
          kind = ok ? ('ok' as const) : classifyAPIError(code, status, data);
        this.#observer.event('api_result', {
          ...fields,
          http_status: status,
          api_code: code,
          ok,
          error_kind: kind,
          platform_trace: trace,
          sent_ref: reference(data.id),
          transport_error: status === 0 ? data.error_type : null,
          elapsed_ms: this.#clock() - started,
        });
        if (attempt === 1 && (status === 401 || (code !== null && AUTH_CODES.has(code)))) {
          this.#observer.event('api_auth_retry', { http_status: status, api_code: code });
          if (this.#token === token) await this.token(true, signal);
          continue;
        }
        return { ok, code, data, status, kind, platformTrace: trace };
      }
      throw new BotTransportError();
    });
  }
  async put(path: string, payload: APIObject, signal?: AbortSignal): Promise<BotAPIResult> {
    if (!path.startsWith('/') || path.startsWith('//')) throw new BotTransportError();
    return this.#observer.scope({ trace_id: this.#observer.traceId() }, async () => {
      const response = await this.#http(
          'PUT',
          this.#base + path,
          payload,
          { Authorization: await this.auth(signal) },
          signal,
        ),
        code = apiCode(response.data),
        data = object(response.data) ? response.data : { raw: true };
      const ok =
          [200, 204].includes(response.status) &&
          (code === null || code === 0) &&
          object(response.data) &&
          !('raw' in data) &&
          !('error_type' in data),
        trace = platformTrace(data.trace_id) ?? platformTrace(response.trace);
      this.#observer.event('interaction_ack', {
        endpoint: endpoint(path),
        method: 'PUT',
        api_attempt: 1,
        ok,
        http_status: response.status,
        api_code: code,
        platform_trace: trace,
      });
      return {
        ok,
        code,
        data,
        status: response.status,
        kind: ok ? 'ok' : classifyAPIError(code, response.status, data),
        platformTrace: trace,
      };
    });
  }
  async ackInteraction(id: unknown, code = 0, signal?: AbortSignal) {
    if (!validPlatformId(id)) {
      this.#observer.event('interaction_ack_skipped', { reason: 'invalid_interaction_id' });
      return { ok: false, code: null, data: {}, status: 0, kind: 'permanent' as const, platformTrace: null };
    }
    return this.put('/interactions/' + id, { code }, signal);
  }
  sendGroup(id: string, payload: APIObject, signal?: AbortSignal, beforeSend?: () => void | Promise<void>) {
    if (!validPlatformId(id)) throw new BotTransportError();
    return this.post('/v2/groups/' + id + '/messages', payload, signal, beforeSend);
  }
  replyGroup(
    id: string,
    text: string,
    options: {
      msgId?: string;
      eventId?: string;
      seq?: number;
      keyboard?: APIObject;
      markdown?: string;
      signal?: AbortSignal;
      beforeSend?: () => void | Promise<void>;
    } = {},
  ) {
    const body: APIObject = options.markdown
      ? { msg_type: 2, markdown: { content: options.markdown } }
      : { msg_type: 0, content: text };
    if (options.msgId) {
      body.msg_id = options.msgId;
      body.msg_seq = options.seq ?? 1;
    } else if (options.eventId) body.event_id = options.eventId;
    if (options.keyboard) body.keyboard = options.keyboard;
    return this.sendGroup(id, body, options.signal, options.beforeSend);
  }
  async setupPanels(commands: { name: string; desc: string }[], group = '', signal?: AbortSignal) {
    try {
      const response = await this.#http(
        'GET',
        this.#base + '/v2/panels?scope=group&limit=50',
        null,
        { Authorization: await this.auth(signal) },
        signal,
      );
      if (
        object(response.data) &&
        Array.isArray(response.data.records) &&
        response.data.records.some((record) => object(record) && record.scope === 'group')
      ) {
        this.#observer.event('panels_existing', { count: response.data.records.length });
        return true;
      }
    } catch (error) {
      aborted(signal);
      this.#observer.event('panels_query_failed', safeError(error));
    }
    if (group && !validPlatformId(group)) throw new BotTransportError();
    const items = commands.slice(0, 20).map(({ name, desc }) => ({ type: 'command', name, desc })),
      body: APIObject = { scope: 'group', panel: { items } };
    if (group) {
      body.target_type = 'specific';
      body.group_openids = [group];
    }
    const result = await this.post('/v2/panels', body, signal);
    this.#observer.event('panels_result', {
      ok: result.ok,
      api_code: result.code,
      items: items.length,
      panel_ref: reference(result.data.panel_id),
    });
    return result.ok;
  }
}
