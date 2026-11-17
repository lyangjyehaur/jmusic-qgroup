import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DB } from '@qgroup/database';
import { MusicCatalog, MyMusicEntries, MusicEntryCommand, MusicEntryResult, MusicEntryMembers } from '@qgroup/contracts';
import { DomainError, musicEntryKey, musicText } from '@qgroup/domain';
import { z } from 'zod';
import { hash, type Security } from './security';
import { getProfile } from './repositories';
import { musicNameJoins, musicNameSQL } from './music-fields';
export const entryCategories = [
  '歌手',
  '乐队',
  '组合',
  '偶像',
  'Vocaloid P',
  '作曲家',
  '社团',
  '企划',
  '其他',
];
type Row = {
  id: string;
  name: string;
  kind: 'main' | 'sub';
  category: string;
  aliases_json: string;
  created_by: string;
  created_at_json: string;
  updated_at_json: string;
  count: number;
};
const rows = (db: DB) =>
  db
    .prepare(
      `SELECT e.*,COALESCE(d.category,CASE WHEN e.kind='main' THEN '领域' ELSE '其他' END) AS category,COALESCE(d.aliases_json,'[]') AS aliases_json,COALESCE(d.created_by,'') AS created_by,COALESCE(d.created_at_json,'0') AS created_at_json,COALESCE(d.updated_at_json,'null') AS updated_at_json,
 COALESCE(c.n,0) AS count
 FROM music_entries e LEFT JOIN music_entry_details d ON d.entry_id=e.id
 LEFT JOIN (SELECT s.entry_id,count(*) AS n FROM music_selections s JOIN music_profiles p ON p.id=s.profile_id WHERE p.erased_at IS NULL GROUP BY s.entry_id) c ON c.entry_id=e.id ORDER BY e.rowid`,
    )
    .all() as Row[];
const revision = (row: Row) =>
  hash(
    JSON.stringify([
      row.id,
      row.name,
      row.kind,
      row.category,
      row.aliases_json,
      row.created_by,
      row.created_at_json,
      row.updated_at_json,
    ]),
  );
function labels(db: DB) {
  const result = new Map<string, string>([['admin', '管理員']]);
  for (const row of db
    .prepare(
      `SELECT p.id,l.legacy_key,${musicNameSQL} AS name FROM music_profiles p ${musicNameJoins} WHERE p.erased_at IS NULL`,
    )
    .all() as { id: string; legacy_key: string | null; name: string }[]) {
    result.set(row.id, row.name);
    if (row.legacy_key) result.set(row.legacy_key, row.name);
  }
  return result;
}
const serialize = (row: Row, names: Map<string, string>) => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  category: row.category || '其他',
  aliases: z
    .array(z.string())
    .parse(JSON.parse(row.aliases_json))
    .filter((v) => v.trim()),
  count: row.count,
  creatorName: names.get(row.created_by) ?? '',
  createdAt:
    typeof JSON.parse(row.created_at_json) === 'number' ? (JSON.parse(row.created_at_json) as number) : null,
});
// Python string order compares Unicode code points, independently of host locale.
function textOrder(a: string, b: string) {
  const x = Array.from(a),
    y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d) return d;
  }
  return x.length - y.length;
}
export function musicCatalog(db: DB) {
  const names = labels(db),
    entries = rows(db)
      .map((r) => serialize(r, names))
      .sort((a, b) => b.count - a.count || textOrder(a.name, b.name));
  return MusicCatalog.parse({
    entries,
    categories: [...new Set(entries.map((e) => e.category))].sort(textOrder),
  });
}
function ownership(db: DB, userId: string) {
  const profile = getProfile(db, userId),
    legacy = profile
      ? (db
          .prepare('SELECT legacy_key,created_entries_json FROM music_legacy_profiles WHERE profile_id=?')
          .get(profile.id) as { legacy_key: string; created_entries_json: string } | undefined)
      : undefined;
  const epoch =
    (
      db.prepare('SELECT epoch FROM music_account_epochs WHERE user_id=?').get(userId) as
        { epoch: number } | undefined
    )?.epoch ?? 0;
  return { profile, legacy, epoch };
}
export function myMusicEntries(db: DB, userId: string) {
  const { profile, legacy, epoch } = ownership(db, userId),
    all = rows(db),
    names = labels(db);
  const owned = profile
    ? all.filter((e) => e.created_by === profile.id || (!!legacy && e.created_by === legacy.legacy_key))
    : [];
  // The source's created list is authoritative for imported quota. Native entries use a stable profile ID.
  const created = new Set<string>(
    legacy ? z.array(z.string()).parse(JSON.parse(legacy.created_entries_json)) : [],
  );
  if (profile) for (const entry of all) if (entry.created_by === profile.id) created.add(entry.id);
  const counted = all.filter((e) => created.has(e.id));
  return MyMusicEntries.parse({
    profileId: profile?.id ?? null,
    musicEpoch: epoch,
    entries: owned.map((e) => ({ ...serialize(e, names), revision: revision(e) })),
    createdCounts: {
      main: counted.filter((e) => e.kind === 'main').length,
      sub: counted.filter((e) => e.kind === 'sub').length,
    },
    limits: { main: 2, sub: 8 },
    categories: entryCategories,
  });
}
function blankProfile(db: DB, user: { id: string; nickname: string }, stamp: string) {
  if (
    db
      .prepare(
        "SELECT 1 FROM music_claim_intents WHERE target_user_id=? AND stage!='completed' AND expires_at>?",
      )
      .get(user.id, stamp)
  )
    throw new DomainError('MUSIC_CLAIM_PENDING', '正在找回舊成分；請先完成或取消找回，再建立詞條', 409);
  const id = 'm_' + randomUUID().replaceAll('-', '');
  db.prepare('INSERT INTO music_profiles(id,user_id,revision,updated_at) VALUES(?,?,0,?)').run(
    id,
    user.id,
    stamp,
  );
  db.prepare("INSERT INTO music_profile_fields VALUES(?,?,'',0,'',0,0,?)").run(id, user.nickname, stamp);
  return id;
}
export function registerMusicCatalog(app: FastifyInstance, db: DB, security: Security, now: () => Date) {
  app.get('/api/v2/music/catalog', async () => db.transaction(() => musicCatalog(db))());
  app.get('/api/v2/music/entries/:id/members', async request => db.transaction(() => {
    const viewer = security.scopedMember(request);
    if (!getProfile(db, viewer.id))
      throw new DomainError('MUSIC_PROFILE_REQUIRED', '請先保存成分，再查看選取者', 403);
    const { id } = z.object({ id: z.string().min(1).max(80) }).parse(request.params);
    if (!db.prepare('SELECT 1 FROM music_entries WHERE id=?').get(id))
      throw new DomainError('ENTRY_NOT_FOUND', '詞條不存在或已刪除', 404);
    const members = db.prepare(`SELECT p.id,${musicNameSQL} AS name,
      COALESCE(c.contact_qq,'') AS contactQQ,
      CASE WHEN c.contact_qq!='' THEN c.source ELSE '' END AS contactSource
      FROM music_profiles p ${musicNameJoins}
      JOIN music_selections s ON s.profile_id=p.id
      LEFT JOIN music_profile_contacts c ON c.profile_id=p.id
      WHERE p.erased_at IS NULL AND s.entry_id=? ORDER BY p.rowid`).all(id) as z.infer<typeof MusicEntryMembers>['members'];
    // Stable sort retains profile insertion order for equal names, as in the source list.
    members.sort((a, b) => textOrder(a.name, b.name));
    return MusicEntryMembers.parse({ entryId: id, members });
  })());
  app.get('/api/v2/me/music/entries', async (request) =>
    db.transaction(() => myMusicEntries(db, security.scopedMember(request).id))(),
  );
  app.post(
    '/api/v2/me/music/entries',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) =>
      db
        .transaction(() => {
          const member = security.memberWrite(request),
            input = MusicEntryCommand.parse(request.body),
            key = z.string().uuid().parse(request.headers['idempotency-key']),
            signature = hash('v2:music-entries:' + JSON.stringify(input));
          const old = db
            .prepare(
              'SELECT signature,response_json,response_status FROM request_results WHERE user_id=? AND request_key=?',
            )
            .get(member.id, key) as
            { signature: string; response_json: string; response_status: number } | undefined;
          if (old) {
            if (old.signature !== signature)
              throw new DomainError('REQUEST_CONFLICT', '這個操作編號已用於另一份內容', 409);
            reply.code(old.response_status);
            return JSON.parse(old.response_json);
          }
          const { profile, legacy, epoch } = ownership(db, member.id);
          if (input.profileId !== (profile?.id ?? null) || input.musicEpoch !== epoch)
            throw new DomainError('PROFILE_ERASED', '成分已刪除、重建或移交，請重新核對目前成分', 409);
          const all = rows(db),
            before = input.command === 'create' ? undefined : all.find((e) => e.id === input.id);
          if (input.command !== 'create') {
            if (!before) throw new DomainError('ENTRY_NOT_FOUND', '詞條不存在或已刪除', 404);
            if (
              !profile ||
              (before.created_by !== profile.id && (!legacy || before.created_by !== legacy.legacy_key))
            )
              throw new DomainError('ENTRY_FORBIDDEN', '只能管理自己建立的詞條', 403);
            if (input.revision !== revision(before))
              throw new DomainError('ENTRY_CHANGED', '詞條已有更新；輸入保留，請核對目前版本後再保存', 409);
          }
          const stamp = now().toISOString();
          let id = before?.id ?? 'e_' + randomUUID().replaceAll('-', ''),
            changed = true,
            profileId = profile?.id;
          if (input.command === 'delete') {
            if (before!.count)
              throw new DomainError('ENTRY_SELECTED', '已有人選用此詞條，不能刪除；選擇與熟悉度會保留', 409);
            db.prepare('DELETE FROM music_entry_details WHERE entry_id=?').run(id);
            db.prepare('DELETE FROM music_entries WHERE id=?').run(id);
            for (const row of db
              .prepare('SELECT profile_id,created_entries_json FROM music_legacy_profiles')
              .all() as { profile_id: string; created_entries_json: string }[]) {
              const list = z.array(z.string()).parse(JSON.parse(row.created_entries_json));
              if (list.includes(id))
                db.prepare('UPDATE music_legacy_profiles SET created_entries_json=? WHERE profile_id=?').run(
                  JSON.stringify(list.filter((value) => value !== id)),
                  row.profile_id,
                );
            }
          } else {
            const name = musicText(input.name);
            if (!musicEntryKey(name) || Array.from(name).length > 24 || /[\x00-\x1f\x7f]/.test(name))
              throw new DomainError('ENTRY_NAME', '詞條名稱須為 1–24 字，不可包含控制字元');
            const duplicate = all.find(
              (e) =>
                e.id !== before?.id &&
                [e.name, ...z.array(z.string()).parse(JSON.parse(e.aliases_json))].some(
                  (alias) => musicEntryKey(alias) === musicEntryKey(name),
                ),
            );
            if (duplicate)
              throw new DomainError(
                'ENTRY_EXISTS',
                '已有「' + duplicate.name + '」詞條，請選用既有詞條',
                409,
              );
            let category =
              before && input.category === before.category
                ? before.category
                : entryCategories.includes(input.category.trim())
                  ? input.category.trim()
                  : '其他';
            if (input.command === 'create') {
              const mine = myMusicEntries(db, member.id);
              if (mine.createdCounts[input.kind] >= mine.limits[input.kind])
                throw new DomainError(
                  'ENTRY_LIMIT',
                  input.kind === 'main' ? '領域最多自建 2 個詞條' : '細分最多自建 8 個詞條',
                );
              if (input.kind === 'main') category = '领域';
              profileId ??= blankProfile(db, member, stamp);
              db.prepare('INSERT INTO music_entries VALUES(?,?,?)').run(id, name, input.kind);
              db.prepare('INSERT INTO music_entry_details VALUES(?,?,?,?,?,?)').run(
                id,
                category,
                '[]',
                profileId,
                JSON.stringify(Math.trunc(now().getTime() / 1000)),
                'null',
              );
              if (legacy) {
                const list = z.array(z.string()).parse(JSON.parse(legacy.created_entries_json));
                db.prepare('UPDATE music_legacy_profiles SET created_entries_json=? WHERE profile_id=?').run(
                  JSON.stringify([...list, id]),
                  profileId,
                );
              }
            } else {
              changed = name !== before!.name || input.kind !== before!.kind || category !== before!.category;
              if (changed) {
                db.prepare('UPDATE music_entries SET name=?,kind=? WHERE id=?').run(name, input.kind, id);
                db.prepare(
                  'UPDATE music_entry_details SET category=?,updated_at_json=? WHERE entry_id=?',
                ).run(category, JSON.stringify(Math.trunc(now().getTime() / 1000)), id);
              }
            }
          }
          const result = MusicEntryResult.parse({ id, command: input.command, changed });
          db.prepare('INSERT INTO request_results VALUES(?,?,?,?,200,?)').run(
            member.id,
            key,
            signature,
            JSON.stringify(result),
            stamp,
          );
          db.prepare('INSERT INTO music_profile_receipts VALUES(?,?,?)').run(member.id, key, profileId!);
          return result;
        })
        .immediate(),
  );
}
