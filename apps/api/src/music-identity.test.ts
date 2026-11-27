import { afterEach, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { fixture } from '../testsupport/fixture';
import { musicMatchingFixture, matchId } from '../testsupport/music-matching-fixture';
import { createApp } from './app';
import { musicAvatars } from './music-identity';

const close: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of close.splice(0)) await fn(); });

it('exposes stored avatars through authorized music reads, scoped to the current QQ app', async () => {
  const db = openDatabase(':memory:'); fixture(db); musicMatchingFixture(db);
  db.exec(`INSERT INTO external_identities VALUES('qq','current','subject','bob','external','before');
    INSERT INTO external_profiles VALUES('qq','current','bob','http://q1.qlogo.cn/avatar');
    INSERT INTO external_identities VALUES('qq','other','subject','bob','external','before');
    INSERT INTO external_profiles VALUES('qq','other','bob','https://q1.qlogo.cn/wrong');`);
  const app = createApp({ db, origin: 'https://rebuild.example', qqProfileClientId: 'current', musicTrendSampling: false });
  await app.ready(); close.push(async () => { await app.close(); db.close(); });
  const cookie = 'kanban_session=fixture-alice';
  const viewer = (await app.inject({ url: '/api/v2/session', headers: { cookie } })).json();
  const headers = { cookie, origin: 'https://rebuild.example', 'x-account-scope': viewer.scope, 'x-csrf-token': viewer.csrf };
  const get = async (url: string) => { const result = await app.inject({ url, headers }); expect(result.statusCode).toBe(200); return result.json(); };
  expect((await get('/api/v2/music/profiles/' + matchId(2))).avatarUrl).toBe('https://q1.qlogo.cn/avatar');
  expect((await get('/api/v2/music/profiles/' + matchId(3))).avatarUrl).toBeUndefined();
  expect((await get('/api/v2/music/matches')).matches[0].member.avatarUrl).toBe('https://q1.qlogo.cn/avatar');
  expect((await get('/api/v2/music/profiles/' + matchId(2) + '/comparison')).other.avatarUrl).toBe('https://q1.qlogo.cn/avatar');
  expect((await get('/api/v2/music/entries/sub-2/members')).members.find((member: { id: string }) => member.id === matchId(2)).avatarUrl).toBe('https://q1.qlogo.cn/avatar');
  const circles = await get('/api/v2/music/circles');
  expect(circles.clusters.flatMap((cluster: { members: { id: string; avatarUrl?: string }[] }) => cluster.members).find((member: { id: string }) => member.id === matchId(2)).avatarUrl).toBe('https://q1.qlogo.cn/avatar');
  expect(JSON.stringify(circles)).not.toMatch(/contactQQ|234567|subject|external|留言/);
  const lookup = await app.inject({ method: 'POST', url: '/api/v2/music/profiles/lookup', headers, payload: { query: '234567' } });
  expect(lookup.json().avatarUrl).toBe('https://q1.qlogo.cn/avatar');
  db.prepare("INSERT INTO music_shouts VALUES('shout',?,'','name','content',100,NULL,0)").run(matchId(2));
  expect((await get('/api/v2/music/shouts/shout')).author.avatarUrl).toBe('https://q1.qlogo.cn/avatar');
  expect((await get('/api/v2/music/trend/members')).members.find((member: { id: string }) => member.id === matchId(2)).avatarUrl).toBe('https://q1.qlogo.cn/avatar');
  expect(JSON.stringify(await get('/api/v2/music/trend'))).not.toContain('avatarUrl');
  for (const url of ['/api/v2/music/matches', '/api/v2/music/profiles/' + matchId(2), '/api/v2/music/trend/members']) {
    const response = await app.inject({ url }); expect(response.statusCode).toBe(401); expect(response.body).not.toContain('qlogo');
  }
  db.exec("UPDATE external_profiles SET avatar_url='https://evil.example/avatar' WHERE client_id='current'");
  expect((await get('/api/v2/music/profiles/' + matchId(2))).avatarUrl).toBeUndefined();
  db.exec("DELETE FROM external_identities WHERE client_id='current'");
  expect(musicAvatars(db, 'current').size).toBe(0);
  expect(musicAvatars(db).size).toBe(0);
  db.exec("INSERT INTO external_identities VALUES('qq','current','subject','bob','external','before'); UPDATE external_profiles SET avatar_url='https://q1.qlogo.cn/avatar' WHERE client_id='current'");
  db.prepare("UPDATE music_profiles SET erased_at='now',user_id=NULL WHERE id=?").run(matchId(2));
  expect(musicAvatars(db, 'current').size).toBe(0);
});
