import { execFileSync } from 'node:child_process';
import {
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createBotObserver,
  persistentBotObserver,
  safeError,
  textFields,
  writeBotHealth,
  type LogFields,
} from './observability';

describe('private bot diagnostics', () => {
  it('keeps async trace scopes independent and suppresses observer IO failures', async () => {
    const rows: LogFields[] = [],
      observer = createBotObserver((row) => rows.push(row));
    await Promise.all(
      ['one', 'two'].map((trace_id) =>
        observer.scope({ trace_id }, async () => {
          await new Promise((resolve) => setImmediate(resolve));
          observer.event('message', { ref: trace_id });
          expect(observer.traceId()).toBe(trace_id);
        }),
      ),
    );
    expect(rows.map((row) => [row.trace_id, row.ref])).toEqual([
      ['one', 'one'],
      ['two', 'two'],
    ]);
    expect(() =>
      createBotObserver(() => {
        throw Error('private');
      }).event('failed'),
    ).not.toThrow();
    const error = new Error('token=never-log-this');
    expect(JSON.stringify(safeError(error))).not.toContain('never-log-this');
    expect(safeError(error).error_type).toBe('Error');
  });
  it('matches Python codepoint metadata and opt-in redaction for content, URL credentials and mentions', () => {
    const strings = [
      '',
      'private message',
      '𠀀🧑‍🎤'.repeat(50),
      'https://private.example/?token=private <@!123> <qqbot-at-user id="2" /> QQBot private-token Bearer other-token',
      'access_token=private clientSecret="secret" password=other invite_token=invite preview_token=preview account_link=account',
    ];
    const config = { appSecret: 'secret', logContent: true, logContentLimit: 80 };
    const expected = JSON.parse(
      execFileSync(
        'python3',
        [
          '-c',
          `import json,sys,types
from qgroup_bot.observability import text_fields
rows=json.load(sys.stdin)
config=types.SimpleNamespace(app_secret='secret',log_content=True,log_content_limit=80)
print(json.dumps([text_fields(text,config) for text in rows]))`,
        ],
        {
          encoding: 'utf8',
          input: JSON.stringify(strings),
          env: { PATH: process.env.PATH, PYTHONPATH: process.cwd() },
        },
      ),
    );
    expect(strings.map((text) => textFields(text, config))).toEqual(expected);
    expect(textFields('private', { ...config, logContent: false })).not.toHaveProperty('text_preview');
  });
  it('creates private rotating JSON logs with four backups and reopens existing files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bot-log-')),
      rows: LogFields[] = [];
    try {
      const directory = join(dir, 'logs'),
        config = { logDirectory: directory, logContent: false };
      const observer = persistentBotObserver(config, { console: (row) => rows.push(row), rotationBytes: 230 });
      for (let index = 0; index < 10; index++) observer.event('synthetic', { index, padding: 'x'.repeat(80) });
      expect(readdirSync(directory).sort()).toEqual(
        ['bot-events.jsonl', ...Array.from({ length: 4 }, (_, i) => 'bot-events.jsonl.' + (i + 1))].sort(),
      );
      for (const name of readdirSync(directory)) {
        expect(statSync(join(directory, name)).mode & 0o777).toBe(0o600);
        for (const line of readFileSync(join(directory, name), 'utf8').trim().split('\n'))
          expect(JSON.parse(line).event).toBe('synthetic');
      }
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      persistentBotObserver(config, { console: () => {} }).event('reopened');
      expect(readFileSync(join(directory, 'bot-events.jsonl'), 'utf8')).toContain('reopened');
      expect(rows.some((row) => row.event === 'log_storage_unavailable')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('falls back to console on IO errors and refuses symlink/hardlink log targets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bot-log-'));
    try {
      for (const kind of ['symlink', 'hardlink', 'blocked']) {
        const folder = join(dir, kind),
          target = join(dir, kind + '-target');
        writeFileSync(target, 'private-original');
        if (kind === 'blocked') writeFileSync(folder, 'not a directory');
        else {
          const observer = persistentBotObserver({ logDirectory: folder, logContent: false }, { console: () => {} });
          observer.event('start');
          rmSync(join(folder, 'bot-events.jsonl'));
          if (kind === 'symlink') symlinkSync(target, join(folder, 'bot-events.jsonl'));
          else linkSync(target, join(folder, 'bot-events.jsonl'));
        }
        const rows: LogFields[] = [];
        const observer = persistentBotObserver(
          { logDirectory: folder, logContent: false },
          { console: (row) => rows.push(row) },
        );
        observer.event('after-failure');
        expect(readFileSync(target, 'utf8')).toBe('private-original');
        expect(rows.some((row) => row.event === 'log_storage_unavailable')).toBe(true);
        expect(rows.some((row) => row.event === 'after-failure')).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('atomically writes the Python/Compose health contract and cleans temporary files on failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bot-health-')),
      rows: LogFields[] = [],
      observer = createBotObserver((row) => rows.push(row));
    const health = {
      dry_run: true,
      deployment_dry_run: true,
      policy_resolved: false,
      last_ack: 1700000000,
      last_ready: 1700000000,
      last_poll: null,
      reconnects: 2,
    };
    try {
      expect(writeBotHealth(dir, health, observer, () => 1700000000000)).toBe(true);
      const path = join(dir, 'bot-health.json');
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const value = JSON.parse(readFileSync(path, 'utf8'));
      expect(value).toEqual({ ...health, updated_at: 1700000000 });
      expect(1700000000 - value.updated_at < 120 && 1700000000 - value.last_ack < 240).toBe(true);
      expect(writeBotHealth(dir, { ...health, last_poll: 1700000001 }, observer, () => 1700000001000)).toBe(true);
      expect(lstatSync(path).isSymbolicLink()).toBe(false);
      expect(readdirSync(dir)).toEqual(['bot-health.json']);
      writeFileSync(join(dir, 'blocked'), '');
      expect(writeBotHealth(join(dir, 'blocked'), health, observer)).toBe(false);
      expect(rows.at(-1)?.event).toBe('health_state_unavailable');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
