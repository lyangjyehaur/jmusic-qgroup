import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { openDatabase } from '@qgroup/database';
import { legacyHistoryFixture } from '../testsupport/legacy-history-fixture';
import { fixture } from '../testsupport/fixture';
import { projectRollbackMusic } from '../../../tools/migration/rollback-music';
import { verifyRollbackMusic } from '../../../tools/migration/rollback-music-reconciliation';
import { erasureJournal, readVerifiedErasureJournal, type ErasureIntent } from './erasure-journal';
import { createPrivacy } from './privacy';
import { saveProfile } from './repositories';
import { hash } from './security';
import { profileId } from '../../../tools/migration/music-codec';
const cleanup:(()=>void)[]=[];afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
async function imported(){const s=await legacyHistoryFixture();cleanup.push(()=>s.close());const journal=erasureJournal(s.db);return {...s,journal,project:()=>projectRollbackMusic(s.db,journal)};}
function submit(s:Awaited<ReturnType<typeof imported>>,fields:Record<string,unknown>){const privacy=createPrivacy(s.db,s.journal);s.db.transaction(()=>privacy.submit({...fields,requestId:randomUUID(),secretHash:hash('secret'),signature:hash('command'),createdAt:'2026-11-20T00:00:00.000Z'} as ErasureIntent)).immediate();privacy.guard();}
it('retains unchanged source shape, duplicate selections and timestamps instead of exporting a normalized administrative copy',async()=>{
  const s=await imported(),before=s.db.prepare('SELECT * FROM music_documents ORDER BY kind,position').all(),result=s.project();
  expect(result.report.rollbackEligible).toBe(false);expect(result.data.members).toMatchObject({'10002':{qq:'10002',selection:[{id:'e',level:4},{id:'e',level:'2'}],note:'歷史私人留言',created:['e'],pinHash:'CURRENT-PIN',boardUserId:'bob',contactQQ:'10002'}});
  const member=(result.data.members as Record<string,Record<string,unknown>>)['10002']!;expect(Object.hasOwn(member,'gender')).toBe(false);expect(Object.hasOwn(member,'noteAt')).toBe(false);
  expect(result.data.entries).toEqual(s.data.entries);expect(result.data.shouts).toEqual(s.data.shouts);expect(result.data.shoutHistory).toEqual(s.data.shoutHistory);expect(result.data.trend).toEqual(s.data.trend);expect(result.data.settings).toEqual({});
  expect(s.db.prepare('SELECT * FROM music_documents ORDER BY kind,position').all()).toEqual(before);expect(verifyRollbackMusic(s.db,result,[]).dataDigest).toBe(result.report.dataDigest);
});
it('projects newer selections, fields, ownership, PIN, explicit empty contacts and created terms while retaining untouched source fields',async()=>{
  const s=await imported(),id=profileId('10002');
  s.db.prepare("INSERT INTO music_entries VALUES('new','新詞條','sub')").run();s.db.prepare("INSERT INTO music_entry_details VALUES('new','歌手','[]',?,'456','null')").run(id);
  s.db.prepare("INSERT INTO music_entry_creations VALUES(?,'new',0)").run(id);
  saveProfile(s.db,'bob',{profileId:id,revision:0,musicEpoch:0,selections:[{entryId:'new',level:1},{entryId:'e',level:2}]},new Date('2026-11-20T00:00:00Z'));
  s.db.prepare("UPDATE music_profile_fields SET name='目前稱呼',note='目前留言',note_at=500,gender='custom',gender_public=1 WHERE profile_id=?").run(id);
  s.db.prepare("UPDATE music_profiles SET user_id=NULL WHERE id=?").run(id);s.db.prepare("UPDATE music_legacy_profiles SET pin_hash='latest-pin' WHERE profile_id=?").run(id);s.db.prepare("UPDATE music_profile_contacts SET contact_qq='' WHERE profile_id=?").run(id);
  const result=s.project(),members=result.data.members as Record<string,Record<string,unknown>>,entries=result.data.entries as Record<string,Record<string,unknown>>;
  expect(members['10002']).toMatchObject({name:'目前稱呼',note:'目前留言',noteAt:500,gender:'custom',genderPublic:true,pinHash:'latest-pin',boardUserId:'',contactQQ:'',selection:[{id:'new',level:1},{id:'e',level:2}],created:['e','new']});expect(entries.new).toMatchObject({createdBy:'10002',text:'新詞條',createdAt:456});
  expect(entries.e).toEqual(s.data.entries.e);
});
it('assigns deterministic reversible old-format keys to new profiles and retains their creation, term and shout author references',()=>{
  const db=openDatabase(':memory:');cleanup.push(()=>{db.close();});fixture(db);const journal=erasureJournal(db);
  const profile=saveProfile(db,'alice',{profileId:null,revision:0,musicEpoch:0,selections:[{entryId:'sub-0',level:3}]},new Date('2026-11-20T00:00:00Z'));
  db.prepare("INSERT INTO music_entry_details VALUES('sub-0','歌手','[]',?,'123','null')").run(profile.id);
  db.prepare("INSERT INTO music_shouts VALUES('native',?,'','原稱呼','新喊話',123,NULL,0)").run(profile.id);
  const result=projectRollbackMusic(db,journal),key=result.keys.find(row=>row.profileId===profile.id)!;
  expect(key).toMatchObject({mode:'generated',erased:false});expect(key.legacyKey).toMatch(/^m_[a-f0-9]{24}$/);expect(key.legacyKey).not.toBe(profile.id);
  expect((result.data.members as Record<string,unknown>)[key.legacyKey]).toMatchObject({qq:key.legacyKey,name:'小青',boardUserId:'alice',contactQQ:'',createdAt:1795132800,selection:[{id:'sub-0',level:3}],created:['sub-0']});
  expect((result.data.entries as Record<string,unknown>)['sub-0']).toMatchObject({createdBy:key.legacyKey});expect(result.data.shouts).toMatchObject([{qq:key.legacyKey}]);expect(projectRollbackMusic(db,journal).keys).toEqual(result.keys);
});
it.each(['music','both','account'] as const)('keeps latest %s deletion scope rather than reviving original profile bodies',async(kind)=>{
  const s=await imported(),id=profileId('10002');submit(s,{version:1,kind,userId:'bob',profileId:id});const result=s.project();
  if(kind==='account')expect(result.data.members).toHaveProperty('10002.boardUserId','');
  else{expect(result.data.members).not.toHaveProperty('10002');expect((result.data.entries as Record<string,unknown>).e).toMatchObject({createdBy:''});expect(result.data.shouts).toEqual([]);expect(result.keys.find(row=>row.profileId===id)).toMatchObject({legacyKey:'10002',erased:true});}
});
it('does not erase post-reset data when the latest journal has already been applied',async()=>{
  const s=await imported();submit(s,{version:2,kind:'admin_music',command:'reset_music',actorRef:'account:alice',profiles:s.db.prepare('SELECT id,user_id AS userId FROM music_profiles WHERE erased_at IS NULL').all(),entries:['e']});
  s.db.prepare("INSERT INTO music_entries VALUES('after','保留新寫入','sub')").run();saveProfile(s.db,'bob',{profileId:null,revision:0,musicEpoch:(s.db.prepare("SELECT epoch FROM music_account_epochs WHERE user_id='bob'").get() as {epoch:number}).epoch,selections:[{entryId:'after',level:4}]},new Date('2026-11-20T01:00:00Z'));
  const result=s.project();expect(result.data.entries).toHaveProperty('after.text','保留新寫入');expect(Object.keys(result.data.members as object)).toHaveLength(1);expect(result.keys.filter(row=>row.erased)).toHaveLength(3);
});
it.each(['member','choice','identity','contact','PIN','creator','timestamp','source shape','creation list','mapping','erasure'])('independently rejects modified %s projection evidence',async(kind)=>{
  const s=await imported(),result=s.project();result.data=structuredClone(result.data);const members=result.data.members as Record<string,Record<string,unknown>>,entries=result.data.entries as Record<string,Record<string,unknown>>;
  if(kind==='member')delete members['10002'];if(kind==='choice')members['10002']!.selection=[{id:'e',level:1}];if(kind==='identity')members['10002']!.boardUserId='alice';if(kind==='contact')members['10002']!.contactQQ='99999';if(kind==='PIN')members['10002']!.pinHash='old-pin';if(kind==='creator')entries.e!.createdBy='10001';if(kind==='timestamp')entries.e!.createdAt=999;
  if(kind==='source shape')members['10002']!.selection=[{id:'e',level:4}];if(kind==='mapping')result.keys[0]!.legacyKey='88888';if(kind==='erasure')result.keys[0]!.erased=true;
  if(kind==='creation list')members['10002']!.created=['e','e'];
  expect(()=>verifyRollbackMusic(s.db,result,readVerifiedErasureJournal(s.db,s.journal))).toThrow('reconciliation failed');
});
it('rejects a generated key colliding with an erased legacy key, missing erasure evidence, ambiguous aliases and nested transactions',async()=>{
  const s=await imported();s.db.prepare("INSERT INTO music_profiles VALUES('m_0123456789abcdef0123456789abcdef',NULL,0,'source',NULL)").run();s.db.prepare("INSERT INTO music_profile_fields VALUES('m_0123456789abcdef0123456789abcdef','新資料','',0,'',0,0,'source')").run();
  const key='m_'+createHash('sha256').update('qgroup:rollback-music-key:v1:m_0123456789abcdef0123456789abcdef').digest('hex').slice(0,24);s.db.prepare('INSERT INTO music_legacy_erasures VALUES(?,?)').run(key,'123');expect(()=>s.project()).toThrow('collision');
  s.db.prepare('DELETE FROM music_legacy_erasures WHERE legacy_key=?').run(key);s.db.transaction(()=>expect(()=>s.project()).toThrow('standalone')).deferred();
  submit(s,{version:1,kind:'music',userId:'bob',profileId:profileId('10002')});expect(()=>projectRollbackMusic(s.db,{read:()=>[],append(){throw Error();}})).toThrow('markers differ');
  s.db.prepare("INSERT INTO migration_map VALUES('music','profile','55555',?,'','','preserved')").run(profileId('10001'));expect(()=>s.project()).toThrow('Ambiguous');
});
it('retains primitive shout timestamp representations and uses latest author limits over stale legacy fields',async()=>{
  const s=await imported(),id=profileId('10002');s.db.prepare("UPDATE music_documents SET payload_json=json_set(payload_json,'$.createdAt','123') WHERE kind='shouts'").run();
  s.db.prepare("UPDATE music_legacy_profiles SET fields_json=json_set(fields_json,'$.lastShoutAt',120) WHERE profile_id=?").run(id);
  s.db.prepare('INSERT INTO music_shout_authors VALUES(?,500)').run(id);s.db.prepare('UPDATE music_shouts SET archived_at=600,ordinal=9 WHERE id=?').run('old');
  const result=s.project();expect((result.data.members as Record<string,Record<string,unknown>>)['10002']).toMatchObject({lastShoutAt:500});
  const body=(result.data.shoutHistory as Record<string,unknown>[]).find(row=>row.id==='old')!;expect(body).toMatchObject({createdAt:'123',archivedAt:600});
  body.createdAt=123;expect(()=>verifyRollbackMusic(s.db,result,[])).toThrow('reconciliation failed');
});
it('preserves duplicate original creation-list entries and appends newly created terms without replacing their provenance',async()=>{
  const s=await imported(),id=profileId('10002');s.db.prepare("UPDATE music_legacy_profiles SET created_entries_json='[\"e\",\"e\"]' WHERE profile_id=?").run(id);
  s.db.prepare("UPDATE music_documents SET payload_json=json_set(payload_json,'$.member.created',json('[\"e\",\"e\"]')) WHERE kind='profile_source' AND json_extract(payload_json,'$.profileId')=?").run(id);
  s.db.prepare("INSERT INTO music_entries VALUES('new','新詞','sub')").run();s.db.prepare("INSERT INTO music_entry_creations VALUES(?,'new',0)").run(id);
  const result=s.project();expect((result.data.members as Record<string,Record<string,unknown>>)['10002']!.created).toEqual(['e','e','new']);
});
it('keeps absent optional selection and creation fields absent when their effective lists remain empty',async()=>{
  const s=await imported(),id=profileId('10002');
  s.db.prepare('DELETE FROM music_selections WHERE profile_id=?').run(id);
  s.db.prepare("UPDATE music_legacy_profiles SET created_entries_json='[]' WHERE profile_id=?").run(id);
  s.db.prepare("UPDATE music_documents SET payload_json=json_remove(payload_json,'$.member.selection','$.member.created') WHERE kind='profile_source' AND json_extract(payload_json,'$.profileId')=?").run(id);
  const result=s.project(),member=(result.data.members as Record<string,Record<string,unknown>>)['10002']!;
  expect(Object.hasOwn(member,'selection')).toBe(false);expect(Object.hasOwn(member,'created')).toBe(false);
  member.selection=[];expect(()=>verifyRollbackMusic(s.db,result,[])).toThrow('reconciliation failed');
});
it('retains the original last-shout representation when the current limit matches it despite stale metadata',async()=>{
  const s=await imported(),id=profileId('10002');
  s.db.prepare("UPDATE music_documents SET payload_json=json_set(payload_json,'$.member.lastShoutAt','500') WHERE kind='profile_source' AND json_extract(payload_json,'$.profileId')=?").run(id);
  s.db.prepare("UPDATE music_legacy_profiles SET fields_json=json_set(fields_json,'$.lastShoutAt',120) WHERE profile_id=?").run(id);
  s.db.prepare('INSERT INTO music_shout_authors VALUES(?,500)').run(id);
  expect((s.project().data.members as Record<string,Record<string,unknown>>)['10002']!.lastShoutAt).toBe('500');
});
it('rejects an unclassified native profile identifier instead of deriving an old identity from it',async()=>{
  const s=await imported();s.db.prepare("INSERT INTO music_profiles VALUES('unknown-profile',NULL,0,'source',NULL)").run();
  expect(()=>s.project()).toThrow('profile ID');
});
it('preserves native trend samples and rejects duplicate or unclassified source JSON fields',async()=>{
  const s=await imported();s.db.prepare("INSERT INTO music_documents VALUES('trend_sample',500,?)").run(JSON.stringify({t:500,counts:{e:3}}));
  expect(s.project().data.trend).toEqual([...s.data.trend,{t:500,counts:{e:3}}]);
  s.db.prepare("UPDATE music_documents SET payload_json=? WHERE kind='trend_sample'").run('{"t":500,"t":600,"counts":{}}');expect(()=>s.project()).toThrow('Duplicate JSON');
  s.db.prepare("UPDATE music_documents SET payload_json=? WHERE kind='trend_sample'").run('{"t":500,"counts":{},"unknown":true}');expect(()=>s.project()).toThrow('Unclassified fields');
});
it.each(['BLOB field','nonfinite time','unclassified output'])('rejects %s rather than silently translating it into JSON',async(kind)=>{
  const s=await imported();
  if(kind==='BLOB field'){s.db.prepare('UPDATE music_profile_fields SET note=? WHERE profile_id=?').run(Buffer.from('unrepresentable'),profileId('10002'));expect(()=>s.project()).toThrow('storage');}
  if(kind==='nonfinite time'){s.db.prepare('UPDATE music_shouts SET created_at=? WHERE id=?').run(Infinity,'old');expect(()=>s.project()).toThrow('time');}
  if(kind==='unclassified output'){const result=s.project();result.data.credential='must not pass';expect(()=>verifyRollbackMusic(s.db,result,[])).toThrow('reconciliation failed');}
});
it('matches the original Python term-kind and selection normalizers without importing its service or loading its data files',async()=>{
  const s=await imported(),result=s.project();
  const response=execFileSync('python3',['-c',`import ast,json,pathlib,sys
tree=ast.parse(pathlib.Path('music_site/upstream.py').read_text())
functions=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in ('norm_selection','entry_kind')]
scope={'KINDS':('main','sub')}
exec(compile(ast.Module(body=functions,type_ignores=[]),'<frozen-normalizers>','exec'),scope)
data=json.load(sys.stdin)
print(json.dumps({'entries':{key:scope['entry_kind'](value) for key,value in data['entries'].items()},'selections':{key:scope['norm_selection'](value.get('selection',[])) for key,value in data['members'].items()}}))`],{input:JSON.stringify(result.data),encoding:'utf8'});
  const body=JSON.parse(response);expect(body.entries).toEqual({e:'sub'});expect(body.selections['10002']).toEqual([{id:'e',level:4}]);
});
