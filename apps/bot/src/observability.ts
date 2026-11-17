import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import type { BotConfig } from './config';
import { reference } from './protocol';
export type LogFields = Record<string, unknown>;
export interface BotObserver {
  event: (name: string, fields?: LogFields) => void;
  scope: <T>(fields: LogFields, work: () => T) => T;
  traceId: () => string;
}
export function safeError(error: unknown) {
  const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,60}$/.test(error.name) ? error.name : 'Error';
  const stack =
    error instanceof Error
      ? (error.stack ?? '')
          .split('\n')
          .slice(1)
          .flatMap((line) => {
            const match = line.match(/(?:\(|\s)([^\s()]+\.[cm]?[jt]s):([0-9]+):([0-9]+)\)?$/);
            return match ? [basename(match[1]!) + ':' + match[2] + ':' + match[3]] : [];
          })
          .slice(-8)
      : [];
  return { error_type: name, stack };
}
export function createBotObserver(emit: (row: LogFields) => void = () => {}, now = () => new Date()): BotObserver {
  const context = new AsyncLocalStorage<LogFields>();
  return {
    scope: (fields, work) => context.run({ ...context.getStore(), ...fields }, work),
    traceId: () => String(context.getStore()?.trace_id ?? randomUUID().replaceAll('-', '')),
    event: (event, fields = {}) => {
      try {
        emit({ ...context.getStore(), ...fields, ts: now().toISOString().replace(/Z$/, '+00:00'), event });
      } catch {
        /* Diagnostics must not become a second send attempt. */
      }
    },
  };
}
export function textFields(value: unknown, config: Pick<BotConfig, 'appSecret' | 'logContent' | 'logContentLimit'>) {
  const text = typeof value === 'string' ? value : '',
    fields: LogFields = { text_chars: Array.from(text).length, text_hash: reference(text) };
  if (config.logContent) {
    let preview = text;
    if (config.appSecret) preview = preview.split(config.appSecret).join('[redacted]');
    preview = preview
      .replace(/https?:\/\/[^\s<>"\[\]{}]+/gi, '[url]')
      .replace(/<@!?[^>]*>|<qqbot-at-[^>]*>/gi, '[mention]')
      .replace(/(?:QQBot|Bearer)\s+[^\s,;]+/gi, '[authorization]')
      .replace(
        /((?:access_token|clientSecret|app_secret|password|authorization|invite_token|preview_token|account_link)["']?\s*[=:]\s*["']?)[^\s,;"']+/gi,
        '$1[redacted]',
      );
    const limit = Math.max(
      80,
      Math.min(Number.isSafeInteger(config.logContentLimit) ? config.logContentLimit : 500, 2000),
    );
    fields.text_preview = Array.from(preview).slice(0, limit).join('');
    fields.text_truncated = Array.from(text).length > limit;
  }
  return fields;
}
function privateDirectory(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Invalid diagnostic directory');
}
/** Same filenames, retention and JSON metadata as Python; only one bot may own this directory. */
export function persistentBotObserver(
  config: Pick<BotConfig, 'logDirectory' | 'logContent'>,
  options: { console?: (row: LogFields) => void; rotationBytes?: number; now?: () => Date } = {},
) {
  const consoleSink = options.console ?? ((row) => process.stderr.write(JSON.stringify(row) + '\n')),
    max = options.rotationBytes ?? 5 * 1024 * 1024;
  let persistent = true;
  const path = join(config.logDirectory, 'bot-events.jsonl');
  const observer = createBotObserver((row) => {
    try {
      consoleSink(row);
    } catch {
      /* Keep the file if the console pipe is unavailable. */
    }
    if (!persistent) return;
    try {
      const bytes = Buffer.from(JSON.stringify(row) + '\n');
      if (existsSync(path)) {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error('Invalid diagnostic file');
      }
      if (existsSync(path) && lstatSync(path).size + bytes.length > max) {
        for (let index = 4; index >= 1; index--) {
          const from = index === 1 ? path : path + '.' + (index - 1),
            to = path + '.' + index;
          if (index === 4 && existsSync(to)) unlinkSync(to);
          if (existsSync(from)) {
            if (!lstatSync(from).isFile() || lstatSync(from).isSymbolicLink() || lstatSync(from).nlink !== 1)
              throw Error('Invalid diagnostic file');
            renameSync(from, to);
          }
        }
      }
      const fd = openSync(
        path,
        constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1) throw Error('Invalid diagnostic file');
        fchmodSync(fd, 0o600);
        appendFileSync(fd, bytes);
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      persistent = false;
      try {
        consoleSink({
          event: 'log_storage_unavailable',
          ts: (options.now?.() ?? new Date()).toISOString(),
          ...safeError(error),
        });
      } catch {
        /* No raw exception text. */
      }
    }
  }, options.now);
  try {
    privateDirectory(config.logDirectory);
  } catch (error) {
    persistent = false;
    observer.event('log_storage_unavailable', safeError(error));
  }
  observer.event('logging_ready', {
    persistent,
    log_content: config.logContent,
    rotation_bytes: max,
    retained_files: 5,
  });
  return observer;
}
export interface BotHealth {
  dry_run: boolean;
  deployment_dry_run: boolean;
  policy_resolved: boolean;
  last_ack: number | null;
  last_ready: number | null;
  last_poll: number | null;
  reconnects: number;
}
export function writeBotHealth(directory: string, health: BotHealth, observer: BotObserver, now = () => Date.now()) {
  let stage: string | undefined;
  try {
    privateDirectory(directory);
    stage = join(directory, '.bot-health-' + randomUUID() + '.tmp');
    writeFileSync(stage, JSON.stringify({ ...health, updated_at: now() / 1000 }), { flag: 'wx', mode: 0o600 });
    const fd = openSync(stage, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(stage, join(directory, 'bot-health.json'));
    stage = undefined;
    return true;
  } catch (error) {
    observer.event('health_state_unavailable', safeError(error));
    return false;
  } finally {
    if (stage)
      try {
        unlinkSync(stage);
      } catch {
        /* Preserve the diagnostic failure without throwing. */
      }
  }
}
