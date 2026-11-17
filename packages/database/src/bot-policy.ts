import { createHash } from 'node:crypto';
import type { DB } from './index';
import type { BotPolicy } from '@qgroup/contracts';
import {
  botBroadcastTarget,
  botQuietUntil,
  defaultBotPolicy,
  resolvedBotGroups,
  validateBotPolicy,
  type BotPolicyDefaults,
} from '@qgroup/domain';
export function readBotPolicy(db: DB, defaults: BotPolicyDefaults = {}) {
  const row = db.prepare('SELECT revision,config_json,updated_at FROM bot_settings WHERE id=1').get() as
    | { revision: number; config_json: string; updated_at: string }
    | undefined;
  if (!row) throw Error('Bot policy row missing');
  const raw: unknown = JSON.parse(row.config_json);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Bot policy document invalid');
  return {
    revision: row.revision,
    config: validateBotPolicy({ ...defaultBotPolicy(defaults), ...raw }),
    updated_at: row.updated_at,
  };
}
export function deploymentBotGroup(db: DB, fallback = '') {
  const row = db.prepare('SELECT deployment_group FROM bot_runtime WHERE id=1').get() as
    | { deployment_group: string }
    | undefined;
  return row?.deployment_group || fallback.trim();
}
const valid = (id: string) => /^[A-Za-z0-9_-]{1,128}$/.test(id);
export function recordBotDeployment(db: DB, id: string) {
  id = valid(id) ? id : '';
  db.prepare('UPDATE bot_runtime SET deployment_group=? WHERE id=1 AND deployment_group<>?').run(id, id);
  if (id) db.prepare('INSERT OR IGNORE INTO bot_groups(group_id) VALUES(?)').run(id);
}
export function observeBotGroup(db: DB, id: string, event: string, stamp: string) {
  if (!valid(id)) return;
  const membership = event === 'GROUP_ADD_ROBOT' ? 'joined' : event === 'GROUP_DEL_ROBOT' ? 'removed' : 'seen';
  db.prepare(
    'INSERT INTO bot_groups(group_id,first_seen,last_seen,last_event,membership) VALUES(?,?,?,?,?) ON CONFLICT(group_id) DO UPDATE SET first_seen=COALESCE(bot_groups.first_seen,excluded.first_seen),last_seen=excluded.last_seen,last_event=excluded.last_event,membership=excluded.membership',
  ).run(id, stamp, stamp, Array.from(event).slice(0, 80).join(''), membership);
  db.prepare(
    'DELETE FROM bot_groups WHERE group_id NOT IN (SELECT group_id FROM bot_groups ORDER BY last_seen DESC LIMIT 500)',
  ).run();
}
export function recordBotIgnore(db: DB, id: string, reason: string, stamp: string) {
  if (!valid(id) || !['group_not_allowed', 'replies_disabled', 'dry_run', 'bot_author', 'duplicate'].includes(reason))
    return;
  db.prepare('INSERT INTO bot_group_ignores(group_id,reason,created_at) VALUES(?,?,?)').run(id, reason, stamp);
  db.prepare(
    'DELETE FROM bot_group_ignores WHERE id NOT IN (SELECT id FROM bot_group_ignores ORDER BY id DESC LIMIT 100)',
  ).run();
}
export function botGroupStatus(db: DB, config: BotPolicy, fallback = '') {
  const deployment = deploymentBotGroup(db, fallback),
    configured = new Map(resolvedBotGroups(config, deployment).map((g) => [g.id, g]));
  type Seen = {
    group_id: string;
    first_seen: string | null;
    last_seen: string | null;
    last_event: string;
    membership: string;
  };
  const discovered = new Map(
    (db.prepare('SELECT * FROM bot_groups ORDER BY last_seen DESC LIMIT 200').all() as Seen[]).map((g) => [
      g.group_id,
      g,
    ]),
  );
  for (const id of configured.keys())
    if (!discovered.has(id))
      discovered.set(id, { group_id: id, first_seen: null, last_seen: null, last_event: '', membership: 'unknown' });
  return {
    inherited: config.groups === null,
    groups: [...discovered].map(([id, item]) => ({
      ...item,
      id,
      name: configured.get(id)?.name ?? '',
      replies: configured.get(id)?.replies ?? false,
      broadcast: configured.get(id)?.broadcast ?? false,
      configured: configured.has(id),
      reference: createHash('sha256').update(id).digest('hex').slice(0, 20),
      deployment_default: id === deployment,
    })),
    ignores: db.prepare('SELECT group_id,reason,created_at FROM bot_group_ignores ORDER BY id DESC LIMIT 20').all(),
  };
}
/** Caller owns BEGIN IMMEDIATE, covering pacing reservation and the corresponding outbox check. */
export function reserveBotSend(db: DB, config: BotPolicy, moment: Date): string | null {
  if (!db.inTransaction) throw Error('Bot pacing requires a write transaction');
  let due = botQuietUntil(config, moment)?.getTime() ?? null;
  const last = (
    db.prepare('SELECT last_attempt_at FROM bot_runtime WHERE id=1').get() as { last_attempt_at: string | null }
  ).last_attempt_at;
  if (last && config.min_interval_seconds) {
    const next = Date.parse(last) + config.min_interval_seconds * 1000;
    if (!Number.isFinite(next)) throw Error('Invalid last bot attempt');
    if (next > moment.getTime()) due = Math.max(due ?? next, next);
  }
  if (due !== null)
    return new Date(due)
      .toISOString()
      .replace(/\.000Z$/, '+00:00')
      .replace(/Z$/, '000+00:00');
  db.prepare('UPDATE bot_runtime SET last_attempt_at=? WHERE id=1').run(
    moment.toISOString().replace(/Z$/, '000+00:00'),
  );
  return null;
}
export function markBotPolicyApplied(db: DB, revision: number, stamp: string) {
  db.prepare('UPDATE bot_runtime SET applied_revision=?,checked_at=? WHERE id=1').run(revision, stamp);
}
export function currentBotTarget(db: DB, config: BotPolicy, fallback = '') {
  return botBroadcastTarget(config, deploymentBotGroup(db, fallback));
}
