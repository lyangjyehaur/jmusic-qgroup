import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { botEnvironment, describeBotConfig, loadBotConfig, validateBotConfig } from './config';
import {
  apiCode,
  classifyAPIError,
  endpoint,
  gatewayCloseAction,
  platformTrace,
  reference,
  validPlatformId,
} from './protocol';

describe('bot configuration and QQ protocol parity', () => {
  it('parses only allowed environment keys without executing values, preserving caller precedence', () => {
    const input = { KANBAN_BOT_ENV: '/synthetic/env', QQBOT_APP_ID: 'caller', KANBAN_BOT_DRY_RUN: '' };
    const env = botEnvironment(
      input,
      () =>
        `# ignored\nQQBOT_APP_ID=file\nQQBOT_APP_SECRET='$(touch NEVER_EXECUTED)'\nKANBAN_BOT_DRY_RUN=0\nPATH=/bad\nexport QQBOT_BAD=yes\nQQBOT_FILE="quoted"\nnot-a-line`,
    );
    expect(env).toEqual({ ...input, QQBOT_APP_SECRET: '$(touch NEVER_EXECUTED)', QQBOT_FILE: 'quoted' });
    expect(input).not.toHaveProperty('QQBOT_APP_SECRET');
    expect(
      botEnvironment(input, () => {
        throw Error('private path');
      }),
    ).toEqual(input);
  });
  it('matches Python defaults and configured environment semantics without loading real credentials', () => {
    const environments = [
      {},
      {
        QQBOT_APP_ID: 'synthetic',
        QQBOT_APP_SECRET: 'synthetic-secret',
        QQBOT_SANDBOX: '1',
        KANBAN_DB: './synthetic.sqlite3',
        KANBAN_BOT_GROUP: 'synthetic-group',
        KANBAN_BOT_DRY_RUN: '0',
        KANBAN_BOT_MARKDOWN: '1',
        KANBAN_BOT_API_BASE: 'http://127.0.0.1:1234///',
        KANBAN_BOT_ALLOWED_HOSTS: ' A.example, b.example , ',
        KANBAN_BOT_POLL_INTERVAL: '1.25',
        KANBAN_BOT_BATCH: '0',
        KANBAN_BOT_CLAIM_TIMEOUT: '2',
        KANBAN_BOT_INTENTS: '0',
        KANBAN_BOT_LOG_CONTENT_LIMIT: '9000',
        KANBAN_BOT_ABBREVIATION_PAGE_BYTES: '1',
      },
    ];
    const fields: Record<string, string> = {
      appId: 'app_id',
      appSecret: 'app_secret',
      group: 'group',
      sandbox: 'sandbox',
      dryRun: 'dry_run',
      markdownReplies: 'markdown_replies',
      apiBase: 'api_base',
      legacyApiBase: 'legacy_api_base',
      allowedLinkHosts: 'allowed_link_hosts',
      pollInterval: 'poll_interval',
      maxAttempts: 'max_attempts',
      batch: 'batch',
      claimTimeout: 'claim_timeout',
      setupPanels: 'setup_panels',
      intents: 'intents',
      verboseEvents: 'verbose_events',
      logContent: 'log_content',
      logContentLimit: 'log_content_limit',
      abbreviationPageBytes: 'abbreviation_page_bytes',
    };
    const expected = JSON.parse(
      execFileSync(
        'python3',
        [
          '-c',
          `import json,os,sys
from qgroup_bot.config import Config
rows,fields=json.load(sys.stdin)
result=[]
for row in rows:
 for key in list(os.environ):
  if key.startswith(('KANBAN_','QQBOT_')):del os.environ[key]
 os.environ.update(row)
 config=Config()
 result.append({key:getattr(config,value) for key,value in fields.items()})
print(json.dumps(result))`,
        ],
        {
          encoding: 'utf8',
          input: JSON.stringify([environments, fields]),
          env: { PATH: process.env.PATH, PYTHONPATH: process.cwd() },
        },
      ),
    );
    expect(
      environments.map((env) => {
        const config = loadBotConfig(env);
        return Object.fromEntries(Object.keys(fields).map((key) => [key, config[key as keyof typeof config]]));
      }),
    ).toEqual(expected);
    const bad = loadBotConfig({
      KANBAN_BOT_BATCH: '3.5',
      KANBAN_BOT_INTENTS: 'Infinity',
      KANBAN_BOT_POLL_INTERVAL: 'NaN',
    });
    expect([bad.batch, bad.intents, bad.pollInterval]).toEqual([10, 100663296, 5]);
    expect(describeBotConfig(loadBotConfig(environments[1]))).not.toHaveProperty('appSecret');
  });
  it('validates an actual isolated SQLite header and reports errors without exposing credential or path errors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bot-config-'));
    try {
      const database = join(dir, 'state.sqlite3');
      writeFileSync(database, 'SQLite format 3\0');
      const config = loadBotConfig({ QQBOT_APP_ID: 'synthetic', QQBOT_APP_SECRET: 'secret', KANBAN_DB: database });
      expect(validateBotConfig(config)).toEqual([]);
      writeFileSync(database, 'bad');
      expect(validateBotConfig(config)).toContain('KANBAN_DB 不是 SQLite 檔案');
      expect(validateBotConfig({ ...config, apiBase: 'https://secret:password@invalid/?token=private' })).toContain(
        'bot API 網址格式不正確',
      );
      expect(JSON.stringify(validateBotConfig({ ...config, database: join(dir, 'private-token') }))).not.toContain(
        'private-token',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('differentially preserves Python error-code precedence and every existing API error classification', () => {
    const values: unknown[] = [
      null,
      [],
      {},
      { code: 0 },
      { code: 0, err_code: 40054010 },
      { code: 11241, err_code: 40054010 },
      { code: true, err_code: '11241' },
      { code: 1.5 },
      ...[
        11241, 11242, 40034100, 304049, 304050, 100001, 304061, 40054010, 40054007, 40054005, 40034005, 40034128,
        40034024, 100007, 100016, 10004, 22006, 304036, 40034008, 40034009, 40034011, 40034124, 40034127, 40034105,
        40034101, 40054003, 40054016, 40054002, 304064, 304031, 1100104, 50055001, 0,
      ].map((err_code) => ({ err_code })),
    ];
    const cases = values.flatMap((data) => [200, 202, 429, 503, 0].map((status) => ({ data, status })));
    const expected = JSON.parse(
      execFileSync(
        'python3',
        [
          '-c',
          `import json,sys
from qgroup_bot.observability import api_code
from qgroup_bot.api import classify_error
print(json.dumps([[api_code(r['data']),classify_error(api_code(r['data']),r['status'],r['data'])] for r in json.load(sys.stdin)]))`,
        ],
        { encoding: 'utf8', input: JSON.stringify(cases), env: { PATH: process.env.PATH, PYTHONPATH: process.cwd() } },
      ),
    );
    expect(cases.map(({ data, status }) => [apiCode(data), classifyAPIError(apiCode(data), status, data)])).toEqual(
      expected,
    );
    expect(classifyAPIError(null, 202, { _unconfirmed_http: 202 })).toBe('unconfirmed');
    expect(endpoint('/v2/groups/private-group/messages?token=secret')).toBe('/v2/groups/:target/messages');
    expect(endpoint('/interactions/private-event')).toBe('/interactions/:interaction');
    expect(reference('synthetic')).toHaveLength(20);
    expect(reference('')).toBeNull();
    expect(platformTrace('trace:01')).toBe('trace:01');
    expect(platformTrace('secret\nheader')).toBeNull();
    expect(['group_1', 'bad/path', 'x'.repeat(129), ''].map(validPlatformId)).toEqual([true, false, false, false]);
  });
  it('uses the QQ official close-code Resume/Identify permissions including internal and permanent errors', () => {
    for (const code of [4001, 4002, 4010, 4011, 4012, 4013, 4014, 4914, 4915])
      expect(gatewayCloseAction(code)).toBe('stop');
    for (const code of [4006, 4007, ...Array.from({ length: 14 }, (_, i) => 4900 + i)])
      expect(gatewayCloseAction(code)).toBe('identify');
    for (const code of [1000, 1006, 4008, 4009, 4999]) expect(gatewayCloseAction(code)).toBe('resume');
  });
});
