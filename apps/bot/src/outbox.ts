import {
  assertDatabaseUsable,
  markBotPolicyApplied,
  readBotPolicy,
  recordBotDeployment,
  reserveBotSend,
  type DB,
} from '@qgroup/database';
import { botBroadcastTarget, botDryRun, botQuietUntil, type BotPolicyDefaults } from '@qgroup/domain';
import type { ActivityBotDefaults } from '../../api/src/activity-bot';
import { readPaymentImage } from '../../api/src/payment-media';
import {
  apiErrorHint,
  classifyAPIError,
  MARKDOWN_REJECTION_CODES,
  object,
  reference,
  type APIObject,
} from './protocol';
import type { BotAPIResult } from './api';
import type { BotConfig } from './config';
import { createBotObserver, safeError, textFields, type BotObserver } from './observability';
import { readBotAuthorizationBlock, recordBotAuthorizationRejection } from './group-state';
import {
  claimOutbox,
  markOutbox,
  ownsOutbox,
  outboxStamp,
  renewOutbox,
  type OutboxRow,
} from './outbox-store';
import { outboxBody, outboxSkipReason, prepareOutboxPayload } from './outbox-planning';
import { checkAbort, within } from './lifecycle';

export type DeliveryResult = 'sent' | 'simulated' | 'skipped' | 'failed' | 'deferred' | 'pending';
export interface OutboxAPI {
  post(path: string, payload: APIObject, signal?: AbortSignal, beforeSend?: () => void): Promise<BotAPIResult>;
}
export class OutboxSendSuppressed extends Error {
  constructor(readonly result: DeliveryResult) {super('Outbox policy changed before request');}
}
export interface OutboxOptions {
  now?: () => Date;
  observer?: BotObserver;
  policyDefaults?: BotPolicyDefaults;
  composition?: ActivityBotDefaults;
  requestTimeoutMs?: number;
}
/** Explicitly constructed library. Importing it never starts a bot, opens a DB or polls. */
export class BotOutboxWorker {
  readonly #now: () => Date;
  readonly #observer: BotObserver;
  readonly #blocks = new Map<string, string | null>();
  #polling = false;
  constructor(
    readonly db: DB,
    readonly config: BotConfig,
    readonly api: OutboxAPI,
    readonly options: OutboxOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#observer = options.observer ?? createBotObserver();
    if (
      ![config.batch, config.maxAttempts, config.claimTimeout].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      )
    )
      throw Error('Invalid outbox limits');
    if (
      options.requestTimeoutMs !== undefined &&
      (!Number.isFinite(options.requestTimeoutMs) || options.requestTimeoutMs <= 0)
    )
      throw Error('Invalid outbox request timeout');
  }
  claim() {
    return claimOutbox(this.db, this.#now(), this.config.claimTimeout, this.config.batch);
  }
  #policy() {
    assertDatabaseUsable(this.db);
    const settings = readBotPolicy(this.db, this.options.policyDefaults);
    markBotPolicyApplied(this.db, settings.revision, outboxStamp(this.#now()));
    return settings;
  }
  #mark(row: OutboxRow, status: string, error = '', options: Parameters<typeof markOutbox>[5] = {}) {
    const persisted = markOutbox(this.db, row, this.#now(), status, error, options);
    this.#observer.event('outbox_state', {
      status,
      state_persisted: persisted,
      reason: error || null,
      retry_at: options.retryAt ?? null,
      failed_attempts: row.attempts + Number(!!options.failure),
    });
    return persisted;
  }
  #failed(row: OutboxRow, error: string): DeliveryResult {
    const attempts = row.attempts + 1,
      status = attempts >= this.config.maxAttempts ? 'failed' : 'pending';
    const retryAt =
      status === 'pending'
        ? outboxStamp(
            new Date(this.#now().getTime() + Math.min(15 * 2 ** Math.min(attempts - 1, 6), 900) * 1000),
          )
        : null;
    this.#mark(row, status, error, { retryAt, failure: true });
    this.#observer.event(status === 'pending' ? 'outbox_retry_scheduled' : 'outbox_failed', {
      failed_attempts: attempts,
      reason: error,
      retry_at: retryAt,
    });
    return status;
  }
  #skip(row: OutboxRow, reason: string): DeliveryResult {
    this.#mark(row, 'skipped', reason);
    return 'skipped';
  }
  #lost(row: OutboxRow) {
    if (ownsOutbox(this.db, row)) return false;
    this.#observer.event('outbox_skipped', { reason: 'claim_lost' });
    return true;
  }
  #refresh(row: OutboxRow, revision: number, enforceQuiet = false): DeliveryResult | null {
    return this.db.transaction(() => this.#refreshLocked(row, revision, enforceQuiet)).immediate();
  }
  #refreshLocked(row: OutboxRow, revision: number, enforceQuiet: boolean): DeliveryResult | null {
    if (this.#lost(row)) return 'skipped';
    const settings = this.#policy();
    if (settings.revision !== revision) {
      this.#mark(row, 'pending', '群通知设置已变更，重新核对后发送', { retryAt: outboxStamp(this.#now()) });
      return 'deferred';
    }
    const reason = outboxSkipReason(this.db, row, settings.config, this.config.group, this.#now());
    if(reason)return this.#skip(row,reason);
    const quiet=enforceQuiet?botQuietUntil(settings.config,this.#now()):null;
    if(quiet){this.#mark(row,'pending','等待允许发送的时间',{retryAt:outboxStamp(quiet)});return 'deferred';}
    return null;
  }
  async #request(row: OutboxRow, path: string, body: APIObject, signal?: AbortSignal, beforeSend?: () => void) {
    checkAbort(signal);
    if (!renewOutbox(this.db, row, this.#now())) throw new DOMException('Claim lost', 'AbortError');
    const lease = new AbortController();
    const timer = setInterval(
      () => {
        try {
          if (!renewOutbox(this.db, row, this.#now())) lease.abort();
        } catch {
          lease.abort();
        }
      },
      Math.max(50, Math.floor((this.config.claimTimeout * 1000) / 3)),
    );
    timer.unref();
    try {
      return await within(
        this.options.requestTimeoutMs ?? 120000,
        AbortSignal.any([lease.signal, ...(signal ? [signal] : [])]),
        (combined) => this.api.post(path, body, combined, () => {checkAbort(combined);beforeSend?.();}),
      );
    } finally {
      clearInterval(timer);
    }
  }
  async deliver(row: OutboxRow, signal?: AbortSignal): Promise<DeliveryResult> {
    assertDatabaseUsable(this.db);
    return this.#observer.scope(
      {
        trace_id: this.#observer.traceId(),
        outbox_id: row.id,
        kind: row.kind,
        activity_ref: reference(row.event_id),
        attempt: row.attempts + 1,
      },
      async () => {
        const started = Date.now();
        this.#observer.event('outbox_claimed', {
          reclaimed: row.status === 'sending',
          channel: row.channel,
          due_at: row.due_at,
          intent_hash: reference(row.payload_json),
        });
        let networkStarted = false;
        let confirmedPayload: APIObject | undefined;
        try {
          const result = await this.#deliver(
            row,
            signal,
            () => {
              networkStarted = true;
            },
            (payload) => {
              confirmedPayload = payload;
            },
          );
          this.#observer.event('outbox_result', { result, elapsed_ms: Date.now() - started });
          return result;
        } catch (error) {
          if (error instanceof OutboxSendSuppressed) return error.result;
          this.#observer.event('outbox_exception', safeError(error));
          if (confirmedPayload) {
            this.#observer.event('outbox_confirmation_not_recorded');
            this.#mark(row, 'skipped', '平台已确认送出，但本机结果保存失败，需人工核对；禁止自动重送', {
              payload: confirmedPayload,
            });
            return 'skipped';
          }
          if (
            (error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name)) ||
            signal?.aborted
          ) {
            if (networkStarted) return this.#skip(row, '请求已中断，未确认送出，需人工核对');
            this.#mark(row, 'pending', '投递已停止，尚未开始请求', { retryAt: outboxStamp(this.#now()) });
            return 'deferred';
          }
          return this.#failed(row, '请求异常：' + safeError(error).error_type);
        }
      },
    );
  }
  async #deliver(
    row: OutboxRow,
    signal: AbortSignal | undefined,
    starting: () => void,
    confirmed: (payload: APIObject) => void,
  ): Promise<DeliveryResult> {
    checkAbort(signal);
    if (this.#lost(row)) return 'skipped';
    const settings = this.db.transaction(() => this.#policy()).immediate(),
      policy = settings.config;
    const group = botBroadcastTarget(policy, this.config.group);
    this.#observer.event('outbox_destination', { group_ref: reference(group) });
    if (!this.#blocks.has(group))
      this.#blocks.set(group, readBotAuthorizationBlock(this.config.logDirectory, group, this.config.group));
    const block = this.#blocks.get(group);
    if (block) return this.#skip(row, block);
    const reason = outboxSkipReason(this.db, row, policy, this.config.group, this.#now());
    if (reason) return this.#skip(row, reason);
    const payload = prepareOutboxPayload(this.db, row, policy, this.#now(), this.options.composition ?? {});
    if (!payload) return this.#skip(row, row.poll_id ? '投票已不适用' : '提醒已不适用');
    const prepared = outboxBody(payload, this.config.markdownReplies, this.config.allowedLinkHosts);
    if (prepared.problem !== undefined) {
      this.#mark(row, 'failed', prepared.problem);
      return 'failed';
    }
    let body = prepared.body;
    this.#observer.event('outbox_prepared', {
      msg_type: body.msg_type,
      keyboard: !!body.keyboard,
      ...textFields(body.content ?? (object(body.markdown) ? body.markdown.content : ''), this.config),
    });
    const recorded = { ...body, _config_revision: settings.revision, _group_ref: reference(group) };
    if (botDryRun(policy, this.config.dryRun)) {
      this.#mark(row, 'skipped', 'dry-run', { simulated: true, payload: recorded });
      this.#observer.event('outbox_simulated', { sent: false });
      return 'simulated';
    }
    if (row.attempts >= this.config.maxAttempts) {
      this.#mark(row, 'failed', '超过最大重试次数');
      return 'failed';
    }
    checkAbort(signal);
    const reserved = this.db
      .transaction(() => {
        if (this.#lost(row)) return 'lost';
        const latest = this.#policy();
        return latest.revision !== settings.revision
          ? outboxStamp(this.#now())
          : reserveBotSend(this.db, policy, this.#now());
      })
      .immediate();
    if (reserved === 'lost') return 'skipped';
    if (reserved) {
      this.#mark(row, 'pending', '等待允许发送的时间', { retryAt: reserved });
      return 'deferred';
    }
    const beforeSend = () => {const changed=this.#refresh(row,settings.revision,true);if(changed)throw new OutboxSendSuppressed(changed);};
    let result: BotAPIResult;
    if (object(payload._settlement_image)) {
      const image = payload._settlement_image;
      const parents = this.db
        .prepare(
          "SELECT status,payload_json FROM bot_outbox WHERE event_id=? AND kind='settlement_updated' ORDER BY id DESC",
        )
        .all(row.event_id) as { status: string; payload_json: string }[];
      const parent = parents.find((parent) => {
        const p: unknown = JSON.parse(parent.payload_json);
        return object(p) && p._settlement_version === payload._settlement_version && !p._settlement_image;
      });
      if (!parent || ['failed', 'skipped'].includes(parent.status)) {
        this.#mark(row, 'failed', '结算文字尚未确认送出，请先重送文字，再重送此图片');
        return 'failed';
      }
      if (parent.status !== 'sent') {
        this.#mark(row, 'pending', '等待结算文字送出', {
          retryAt: outboxStamp(new Date(this.#now().getTime() + 10000)),
        });
        return 'deferred';
      }
      const raw = readPaymentImage(this.db, String(image.digest));
      const refreshed = this.#refresh(row, settings.revision);
      if (refreshed) return refreshed;
      checkAbort(signal);
      starting();
      result = await this.#request(
        row,
        '/v2/groups/' + group + '/files',
        {
          file_type: 1,
          file_name: 'payment-code.png',
          file_data: raw.toString('base64'),
          srv_send_msg: false,
        },
        signal,
        beforeSend,
      );
      if (result.ok) {
        if (typeof result.data.file_info !== 'string' || !result.data.file_info)
          return this.#failed(row, '平台上传响应缺少 file_info，未发送图片');
        body = { msg_type: 7, media: { file_info: result.data.file_info } };
        const refreshed = this.#refresh(row, settings.revision);
        if (refreshed) return refreshed;
        checkAbort(signal);
        result = await this.#request(row, '/v2/groups/' + group + '/messages', body, signal, beforeSend);
      }
    } else {
      const refreshed = this.#refresh(row, settings.revision);
      if (refreshed) return refreshed;
      checkAbort(signal);
      starting();
      result = await this.#request(row, '/v2/groups/' + group + '/messages', body, signal, beforeSend);
    }
    if (result.ok) confirmed(recorded);
    this.#observer.event('outbox_sending');
    if (result.ok) {
      const persisted = this.#mark(row, 'sent', '', { sent: true, payload: recorded });
      this.#observer.event('outbox_sent', {
        sent_ref: reference(result.data.id),
        state_persisted: persisted,
      });
      return 'sent';
    }
    const message = 'code=' + (result.code === null ? 'None' : result.code) + ' ' + apiErrorHint(result.code),
      kind = classifyAPIError(result.code, result.status, result.data);
    this.#observer.event('outbox_send_rejected', {
      api_code: result.code,
      http_status: result.status,
      error_kind: kind,
    });
    if (body.msg_type === 2 && result.code !== null && MARKDOWN_REJECTION_CODES.has(result.code))
      this.#observer.event('outbox_markdown_rejected', { api_code: result.code });
    if (kind === 'unconfirmed') {
      this.#observer.event('outbox_unconfirmed');
      return this.#skip(row, '平台返回异步结果，未确认送出，需人工核对：' + message);
    }
    if (kind === 'permanent') {
      this.#mark(row, 'failed', '内容被永久拒绝，停止重试：' + message, { failure: true });
      return 'failed';
    }
    if (kind === 'authorization')
      recordBotAuthorizationRejection(
        this.config.logDirectory,
        group,
        result.code,
        this.#now(),
        this.#observer,
      );
    if (kind === 'rate_limit') {
      this.#mark(row, 'pending', '频控，等待配额恢复：' + message, {
        retryAt: outboxStamp(new Date(this.#now().getTime() + 60000)),
      });
      return 'deferred';
    }
    return this.#failed(row, message);
  }
  async pollOnce(signal?: AbortSignal) {
    if (this.#polling) throw Error('Outbox poll already running');
    checkAbort(signal);
    this.#polling = true;
    let rows: OutboxRow[] = [],
      next = 0;
    const counts = { claimed: 0, sent: 0, simulated: 0, skipped: 0, failed: 0, deferred: 0 };
    try {
      this.db
        .transaction(() => {
          recordBotDeployment(this.db, this.config.group);
          this.#policy();
        })
        .immediate();
      this.#blocks.clear(); // Snapshot persisted refusals once for this batch; a refusal never drops its other rows.
      rows = this.claim();
      counts.claimed = rows.length;
      for (; next < rows.length;) {
        checkAbort(signal);
        const result = await this.deliver(rows[next++]!, signal);
        if (result !== 'pending') counts[result]++;
      }
      return counts;
    } finally {
      try {
        for (; next < rows.length; next++)
          this.#mark(rows[next]!, 'pending', '投递已停止，尚未开始请求', {
            retryAt: outboxStamp(this.#now()),
          });
      } finally {
        this.#polling = false;
      }
    }
  }
}
