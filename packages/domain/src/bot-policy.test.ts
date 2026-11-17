import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  defaultBotPolicy,
  botPolicyDefaults,
  validateBotPolicy,
  botQuietUntil,
  botDryRun,
  botReplyAllowed,
  botBroadcastTarget,
} from './bot-policy';
import { BOT_KINDS } from '@qgroup/contracts';
function python<T>(source: string, input: unknown): T {
  return JSON.parse(
    execFileSync('python3', ['-c', source], {
      encoding: 'utf8',
      input: JSON.stringify(input),
      env: { PATH: process.env.PATH, PYTHONPATH: process.cwd() },
    }),
  );
}
describe('shared bot policy compatibility', () => {
  it('matches Python deployment defaults, explicit groups, disabled routing and simulation overrides', () => {
    const environments = [
      {},
      {
        KANBAN_BOT_ENABLED: '1',
        KANBAN_BOT_SCHEDULE: '0',
        KANBAN_BOT_BROADCAST_KINDS: 'activity_published,unknown, time_poll_published',
      },
    ];
    const expected = python(
      `import json,os,sys
from qgroup_core import bot_settings
rows=json.load(sys.stdin)
result=[]
for row in rows:
 for key in list(os.environ):
  if key.startswith(('KANBAN_','QQBOT_')):del os.environ[key]
 os.environ.update(row)
 result.append([bot_settings.defaults(worker=False),bot_settings.defaults(worker=True)])
print(json.dumps(result))`,
      environments,
    );
    expect(
      environments.map((env) => [defaultBotPolicy(botPolicyDefaults(env)), defaultBotPolicy(botPolicyDefaults(env))]),
    ).toEqual(expected);
    const configs = [
      defaultBotPolicy(),
      defaultBotPolicy({ groups: [] }),
      defaultBotPolicy({
        groups: [
          { id: 'configured', name: '群', replies: true, broadcast: false },
          { id: 'push', name: '通知', replies: false, broadcast: true },
        ],
      }),
      defaultBotPolicy({ dry_run: false }),
      defaultBotPolicy({ dry_run: true }),
    ];
    const routing = python(
      `import json,sys
from qgroup_core import bot_groups
print(json.dumps([[bot_groups.reply_allowed(c,'legacy','legacy'),bot_groups.reply_allowed(c,'configured','legacy'),bot_groups.broadcast_target(c,'legacy')] for c in json.load(sys.stdin)]))`,
      configs,
    );
    expect(
      configs.map((c) => [
        botReplyAllowed(c, 'legacy', 'legacy'),
        botReplyAllowed(c, 'configured', 'legacy'),
        botBroadcastTarget(c, 'legacy'),
      ]),
    ).toEqual(routing);
    expect(configs.map((c) => [botDryRun(c, true), botDryRun(c, false)])).toEqual([
      [true, false],
      [true, false],
      [true, false],
      [false, false],
      [true, true],
    ]);
  });
  it('differentially rejects incomplete/extra policy, malformed groups, unsafe templates, duplicate kinds and invalid time boundaries', () => {
    const good = defaultBotPolicy(),
      patches: object[] = [
        {},
        { groups: [] },
        { groups: [{ id: 'A_1', name: '𠀀'.repeat(60), replies: false, broadcast: true }] },
        { timezone: 'UTC' },
        { timezone: 'Etc/GMT+8' },
        { timezone: '../UTC' },
        { timezone: 'No/SuchZone' },
        { enabled: 1 },
        { dry_run: 'false' },
        { broadcast_kinds: ['unknown'] },
        { broadcast_kinds: ['activity_published', 'activity_published'] },
        { deadline_hours: 0 },
        { deadline_hours: 721 },
        { deadline_hours: 1.5 },
        { deadline_hours: true },
        { estimated_over_delay_minutes: 1441 },
        { min_interval_seconds: 3601 },
        { quiet_enabled: true, quiet_start: '08:00', quiet_end: '08:00' },
        { quiet_start: '8:00' },
        { templates: { activity_published: '{title}' } },
        { templates: { 'activity_published@md': '{heading}\n{url}' } },
        { templates: { 'unknown@md': '{url}' } },
        { templates: { activity_published: '{title.__class__} {url}' } },
        { templates: { activity_published: '{url}{details}{details}' } },
        { groups: [{ id: 'a', name: 'bad\n', replies: true, broadcast: true }] },
        { groups: [{ id: 'bad/path', name: '', replies: true, broadcast: true }] },
        { groups: [{ id: 'a', name: '', replies: 1, broadcast: true }] },
        {
          groups: [
            { id: 'a', name: '', replies: true, broadcast: true },
            { id: 'b', name: '', replies: true, broadcast: true },
          ],
        },
        {
          groups: [
            { id: 'a', name: '', replies: true, broadcast: false },
            { id: 'a', name: '', replies: true, broadcast: false },
          ],
        },
        { extra: true },
      ];
    const cases: unknown[] = [
      null,
      [],
      ...patches.map((p) => ({ ...good, ...p })),
      Object.fromEntries(Object.entries(good).filter(([key]) => key !== 'dry_run')),
    ];
    const expected = python(
      `import json,sys
from qgroup_core import bot_settings
result=[]
for row in json.load(sys.stdin):
 try:bot_settings.validate(row);result.append(True)
 except Exception:result.append(False)
print(json.dumps(result))`,
      cases,
    );
    expect(
      cases.map((value) => {
        try {
          validateBotPolicy(value);
          return true;
        } catch {
          return false;
        }
      }),
    ).toEqual(expected);
    expect(Object.keys(BOT_KINDS)).toHaveLength(17);
    expect(() => validateBotPolicy({ ...good, timezone: 'asia/taipei' })).toThrow();
  });
  it('matches Python quiet periods across midnight, same-day windows, exact boundaries and DST folds/gaps', () => {
    const cases = [];
    for (const timezone of [
      'Asia/Taipei',
      'UTC',
      'America/New_York',
      'Australia/Lord_Howe',
      'Europe/London',
      'Pacific/Apia', 'Factory',
    ])
      for (const [quiet_start, quiet_end] of [
        ['23:00', '08:00'],
        ['01:00', '01:45'],
        ['01:00', '02:30'],
        ['08:00', '18:00'],
      ] as const)
        for (const at of [
          '2026-11-17T00:00:00.000Z',
          '2026-11-17T10:00:00.000Z',
          '2026-11-17T15:00:00.000Z',
          '2026-11-01T05:15:00.000Z',
          '2026-11-01T06:15:00.000Z',
          '2026-03-08T06:30:00.000Z',
          '2026-04-04T15:15:00.000Z',
          '2026-10-03T15:30:00.000Z',
        ])
          cases.push({ config: { ...defaultBotPolicy(), quiet_enabled: true, timezone, quiet_start, quiet_end }, at });
    const expected = python(
      `import json,sys,datetime
from qgroup_core import bot_settings
result=[]
for r in json.load(sys.stdin):
 value=bot_settings.quiet_until(r['config'],datetime.datetime.fromisoformat(r['at'].replace('Z','+00:00')))
 result.append(int(value.timestamp()*1000) if value else None)
print(json.dumps(result))`,
      cases,
    );
    expect(cases.map((r) => botQuietUntil(r.config, new Date(r.at))?.getTime() ?? null)).toEqual(expected);
    expect(botQuietUntil(defaultBotPolicy(), new Date())).toBeNull();
  });
});
