import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from './index';
import {
  botGroupStatus,
  markBotPolicyApplied,
  observeBotGroup,
  readBotPolicy,
  recordBotDeployment,
  recordBotIgnore,
  reserveBotSend,
} from './bot-policy';
import { defaultBotPolicy } from '@qgroup/domain';

describe('shared SQLite bot policy and pacing', () => {
  it('preserves bounded discovery/ignore records, deployment fallback, applied revision and content-free group view against Python', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bot-policy-')),
      path = join(dir, 'state.sqlite3'),
      db = openDatabase(path),
      stamp = '2026-11-17T10:00:00+00:00';
    try {
      recordBotDeployment(db, 'deployment');
      observeBotGroup(db, 'seen', 'GROUP_ADD_ROBOT', stamp);
      observeBotGroup(db, 'seen', 'GROUP_DEL_ROBOT', stamp);
      observeBotGroup(db, 'bad/path', 'ignored', stamp);
      recordBotIgnore(db, 'seen', 'group_not_allowed', stamp);
      recordBotIgnore(db, 'seen', 'raw-message', stamp);
      markBotPolicyApplied(db, 4, stamp);
      expect(botGroupStatus(db, defaultBotPolicy())).toMatchObject({
        inherited: true,
        groups: [
          { id: 'seen', membership: 'removed' },
          { id: 'deployment', deployment_default: true },
        ],
        ignores: [{ reason: 'group_not_allowed' }],
      });
      db.pragma('wal_checkpoint(TRUNCATE)');
      const expected = JSON.parse(
        execFileSync(
          'python3',
          [
            '-c',
            `import json,sqlite3,sys
from qgroup_core import bot_groups,bot_settings
c=sqlite3.connect(sys.argv[1]);c.row_factory=sqlite3.Row
print(json.dumps(bot_groups.view(c,bot_settings.defaults())))`,
            path,
          ],
          { encoding: 'utf8', env: { PATH: process.env.PATH, PYTHONPATH: process.cwd() } },
        ),
      );
      expect(botGroupStatus(db, defaultBotPolicy())).toEqual(expected);
      for (let i = 0; i < 600; i++) {
        observeBotGroup(db, 'group-' + i, 'GROUP_AT_MESSAGE_CREATE', stamp);
        recordBotIgnore(db, 'group-' + i, 'duplicate', stamp);
      }
      expect(db.prepare('SELECT count(*) n FROM bot_groups').get()).toEqual({ n: 500 });
      expect(db.prepare('SELECT count(*) n FROM bot_group_ignores').get()).toEqual({ n: 100 });
      expect(botGroupStatus(db, defaultBotPolicy()).ignores).toHaveLength(20);
      expect(db.prepare('SELECT applied_revision,checked_at FROM bot_runtime').get()).toEqual({
        applied_revision: 4,
        checked_at: stamp,
      });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('serializes pacing across connections/restarts and combines quiet hours without modifying last attempt on deferral', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bot-pacing-')),
      path = join(dir, 'state.sqlite3'),
      db = openDatabase(path),
      second = openDatabase(path),
      config = defaultBotPolicy({ min_interval_seconds: 60 }),
      now = new Date('2026-11-17T15:00:00.125Z');
    try {
      expect(() => reserveBotSend(db, config, now)).toThrow('transaction');
      expect(db.transaction(() => reserveBotSend(db, config, now)).immediate()).toBeNull();
      expect(second.transaction(() => reserveBotSend(second, config, new Date(now.getTime() + 1000))).immediate()).toBe(
        '2026-11-17T15:01:00.125000+00:00',
      );
      const last = db.prepare('SELECT last_attempt_at FROM bot_runtime').get();
      expect(
        second.transaction(() => reserveBotSend(second, { ...config, quiet_enabled: true }, now)).immediate(),
      ).toBe('2026-11-18T00:00:00+00:00');
      expect(db.prepare('SELECT last_attempt_at FROM bot_runtime').get()).toEqual(last);
      second.close();
      const restarted = openDatabase(path);
      try {
        expect(
          restarted.transaction(() => reserveBotSend(restarted, config, new Date(now.getTime() + 60000))).immediate(),
        ).toBeNull();
      } finally {
        restarted.close();
      }
    } finally {
      if (second.open) second.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('merges legacy partial documents, validates stored policy and does not mutate settings/runtime/outbox on reads', () => {
    const db = openDatabase(':memory:');
    try {
      db.prepare('UPDATE bot_settings SET config_json=?').run(JSON.stringify({ dry_run: false, groups: [] }));
      const tables = ['bot_settings', 'bot_settings_history', 'bot_runtime', 'bot_outbox'],
        before = tables.map((t) => db.prepare('SELECT * FROM ' + t).all());
      expect(readBotPolicy(db, { enabled: true }).config).toMatchObject({ enabled: true, dry_run: false, groups: [] });
      expect(tables.map((t) => db.prepare('SELECT * FROM ' + t).all())).toEqual(before);
      db.prepare("UPDATE bot_settings SET config_json='[]'").run();
      expect(() => readBotPolicy(db)).toThrow();
    } finally {
      db.close();
    }
  });
});
