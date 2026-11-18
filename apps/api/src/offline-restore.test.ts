import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type DB } from '@qgroup/database';
import { fixture } from '../testsupport/fixture';
import { adminCatalogFixture, catalogProfiles } from '../testsupport/admin-catalog-fixture';
import { createApp, hash } from './app';
import { erasureJournal, type StoredIntent } from './erasure-journal';
import { createPairedBackups, openPairedBackup } from './paired-backups';
import { putPaymentImage } from './payment-media';
import { createPrivacy } from './privacy';
import { restorePairedBackup } from './offline-restore';
const stamp='2026-11-17T08:00:00.000Z', cleanup:(()=>void)[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const close of cleanup.splice(0).reverse())close();});
const digest=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
function walk(root:string,prefix=''):Record<string,string>{return Object.fromEntries(readdirSync(root,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry=>{const path=join(root,entry.name),key=prefix+entry.name;return entry.isDirectory()?Object.entries(walk(path,key+'/')):[[key,digest(readFileSync(path))]];}));}
function setup(){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'qgroup-restore-')));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  const db=openDatabase(join(root,'state.sqlite3'));cleanup.push(()=>db.close());fixture(db);adminCatalogFixture(db);
  const journal=erasureJournal(db);writeFileSync(join(root,'state.erasures.jsonl'),'');
  const backups=createPairedBackups(db,journal,()=>new Date(stamp))!,capture=()=>join(root,'paired-backups',backups.capture().id);
  const evidence=join(root,'evidence');mkdirSync(evidence);
  const blocked=JSON.stringify({push_authorized:false,code:40034105,recorded_at:stamp});
  for(const name of ['bot-group-state.json','bot-group-state-'+hash('synthetic-group').slice(0,20)+'.json'])writeFileSync(join(evidence,name),blocked);
  writeFileSync(join(evidence,'bot-events.jsonl'),'{"event":"outbox_sent","state_persisted":false}\n');writeFileSync(join(evidence,'bot-health.json'),'{"old":true}');
  const backup=capture(),destination=join(root,'candidate');
  const input={backup,checkpoint:backup,latestLedger:join(root,'state.erasures.jsonl'),botEvidence:evidence,destination,quiescent:true as const};
  return{root,db,journal,backups,capture,evidence,input};
}
function rewrite(base:string,change:(db:DB)=>void,version1=false){
  const manifestPath=join(base,'manifest.json'),manifest=JSON.parse(readFileSync(manifestPath,'utf8')),db=new Database(readFileSync(join(base,'state.sqlite3')));
  let bytes:Buffer;try{change(db);bytes=db.serialize();bytes[18]=1;bytes[19]=1;}finally{db.close();}writeFileSync(join(base,'state.sqlite3'),bytes);
  const file=manifest.files.find((f:{path:string})=>f.path==='state.sqlite3');file.size=bytes.length;file.sha256=digest(bytes);
  if(version1){manifest.version=1;manifest.schema=13;delete manifest.lineageId;}writeFileSync(manifestPath,JSON.stringify(manifest)+'\n');
}
function candidate(path:string){return new Database(join(path,'unified.sqlite3'),{readonly:true,fileMustExist:true});}
function appendErasure(s:ReturnType<typeof setup>,kind:'music'|'account'|'reset'='music',pending=false){
  const entry:StoredIntent=kind==='reset'?{version:2,kind:'admin_music',command:'reset_music',actorRef:'account:alice',profiles:Object.values(catalogProfiles).map(id=>({id,userId:id===catalogProfiles.alice?'alice':id===catalogProfiles.bob?'bob':null})),entries:(s.db.prepare('SELECT id FROM music_entries').all() as {id:string}[]).map(row=>row.id),requestId:randomUUID(),createdAt:stamp,secretHash:hash('private-receipt'),signature:hash('synthetic-reset')}:
    {version:1,kind,userId:'bob',profileId:catalogProfiles.bob,requestId:randomUUID(),createdAt:stamp,secretHash:hash('private-receipt'),signature:hash('synthetic-erase')};
  s.journal.append(entry);if(!pending)createPrivacy(s.db,s.journal);return entry;
}
describe('offline paired recovery candidates',()=>{
  it('creates a private blocked candidate, retains all data/images/wallpapers, revokes proofs and preserves raw bot evidence without mutating any inputs',()=>{
    const s=setup(),raw=Buffer.from('synthetic-image'),key=s.db.transaction(()=>putPaymentImage(s.db,raw,new Date(stamp))).immediate();
    s.db.prepare("INSERT INTO user_payment_codes VALUES('code','bob','wechat','合成',?,1,'now')").run(key);
    const wall=Buffer.from('wall');s.db.prepare("INSERT INTO wallpaper_assets VALUES(?,'image/png',?,?)").run(digest(wall),wall,wall.length);
    s.db.exec("INSERT INTO admin_sessions VALUES('admin-proof','credential','future','before'); INSERT INTO music_legacy_identity VALUES('sessions',9,'{\"token_hash\":\"private-old\"}'); INSERT INTO request_results VALUES('alice','business-request','signature','{}',200,'before')");
    s.input.backup=s.input.checkpoint=s.capture();const prior={backup:walk(s.input.backup),ledger:readFileSync(s.input.latestLedger),evidence:walk(s.evidence)};
    const result=restorePairedBackup(s.input);expect(result).toEqual({status:'candidate_created',schema:15,recoveryRequired:true,releaseEligible:false});
    expect(walk(s.input.backup)).toEqual(prior.backup);expect(readFileSync(s.input.latestLedger)).toEqual(prior.ledger);expect(walk(s.evidence)).toEqual(prior.evidence);
    const db=candidate(s.input.destination);try{
      expect(db.prepare('SELECT count(*) n FROM browser_sessions').get()).toEqual({n:0});expect(db.prepare('SELECT count(*) n FROM admin_sessions').get()).toEqual({n:0});expect(db.prepare("SELECT count(*) n FROM music_legacy_identity WHERE table_name='sessions'").get()).toEqual({n:0});
      expect(db.prepare('SELECT token_hash FROM users WHERE id=\'alice\'').get()).not.toEqual(s.db.prepare('SELECT token_hash FROM users WHERE id=\'alice\'').get());expect(db.prepare('SELECT * FROM request_results').all()).toEqual(s.db.prepare('SELECT * FROM request_results').all());
      expect(db.prepare('SELECT data FROM wallpaper_assets').get()).toEqual({data:wall});expect(db.prepare('SELECT * FROM external_identities').all()).toEqual(s.db.prepare('SELECT * FROM external_identities').all());
      expect(()=>createApp({db,origin:'https://example.test'})).toThrow('offline review');
    }finally{db.close();}
    expect(()=>openDatabase(join(s.input.destination,'unified.sqlite3'))).toThrow('offline review');
    const locked=new Database(join(s.input.destination,'unified.sqlite3'));try{expect(()=>locked.exec('UPDATE rebuild_storage SET recovery_required=0')).toThrow('immutable');expect(()=>locked.exec("INSERT OR REPLACE INTO rebuild_storage(id,lineage_id) SELECT id,lineage_id FROM rebuild_storage")).toThrow('immutable');}finally{locked.close();}
    expect(readFileSync(join(s.input.destination,'images',key.slice(0,2),key+'.png'))).toEqual(raw);
    expect(walk(join(s.input.destination,'bot-evidence'))).toEqual(prior.evidence);expect(readFileSync(join(s.input.destination,'bot-logs','bot-group-state.json'))).toEqual(readFileSync(join(s.evidence,'bot-group-state.json')));expect(existsSync(join(s.input.destination,'bot-logs','bot-health.json'))).toBe(false);
    expect(statSync(s.input.destination).mode&0o777).toBe(0o700);for(const path of Object.keys(walk(s.input.destination)))expect(statSync(join(s.input.destination,path)).mode&0o777).toBe(0o600);
    const authorization=execFileSync('python3',['-c',`from pathlib import Path
from types import SimpleNamespace
from qgroup_bot.worker import OutboxWorker
import sys
worker=OutboxWorker(SimpleNamespace(db=Path(sys.argv[1]).parent/'unified.sqlite3',log_dir=Path(sys.argv[1]),group='synthetic-default'),None)
assert worker._read_authorization_block('synthetic-default')
assert worker._read_authorization_block('synthetic-group')
print('authorization-blocks-preserved')`,join(s.input.destination,'bot-logs')],{encoding:'utf8'});expect(authorization.trim()).toBe('authorization-blocks-preserved');
    const saved=walk(s.input.destination);expect(()=>restorePairedBackup(s.input)).toThrow('existing');expect(walk(s.input.destination)).toEqual(saved);
  });
  it('retains latest nonempty bot tables, IDs/sequences, frozen deliveries, retry/simulated/uncertain states and Python bot semantics',()=>{
    const s=setup();
    for(const [index,status]of ['pending','sending','sent','failed','skipped','skipped'].entries())s.db.prepare(`INSERT INTO bot_outbox(event_id,kind,dedupe_key,target,payload_json,status,attempts,last_error,claimed_at,claim_token,sent_at,retry_at,simulated_at,delivered_payload_json,created_at) VALUES('listen','synthetic',?,'synthetic','{"v":1}',?,2,?,?,?,?,?,?,?,'before')`).run(String(index),status,index===5?'平台返回异步结果，未确认送出，需人工核对':'',status==='sending'?'claim-time':null,status==='sending'?'claim-token':'',status==='sent'?'sent-time':null,status==='failed'?'retry-time':null,index===4?'dry-run-time':null,['sent','skipped'].includes(status)?'{"frozen":true}':null);
    s.db.exec("UPDATE bot_settings SET revision=1,config_json='{}',updated_at='before'; INSERT INTO bot_settings_history VALUES(1,'{}','before','synthetic','save'); INSERT OR REPLACE INTO bot_runtime VALUES(1,1,'before','before','synthetic'); INSERT INTO bot_groups VALUES('synthetic','before','before','join','joined'); INSERT INTO bot_group_ignores(group_id,reason,created_at) VALUES('synthetic','paused','before')");
    s.input.backup=s.capture();s.db.exec("UPDATE bot_outbox SET status='sent',sent_at='now',delivered_payload_json='{\"frozenLatest\":true}',attempts=3 WHERE dedupe_key='0'; INSERT INTO bot_outbox(event_id,kind,dedupe_key,target,payload_json,created_at) VALUES('listen','new','new','synthetic','{}','now'); UPDATE sqlite_sequence SET seq=9000 WHERE name='bot_outbox'; UPDATE bot_settings SET revision=2; INSERT INTO bot_settings_history VALUES(2,'{}','now','synthetic','save')");
    s.input.checkpoint=s.capture();const before=walk(s.input.backup),latest=walk(s.input.checkpoint);restorePairedBackup(s.input);
    const db=candidate(s.input.destination);try{
      for(const table of ['bot_outbox','bot_settings','bot_settings_history','bot_runtime','bot_groups','bot_group_ignores'])expect(db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all(),table).toEqual(s.db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all());expect(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='bot_outbox'").get()).toEqual({seq:9000});
    }finally{db.close();}
    const probe=(path:string)=>execFileSync('python3',['tools/rebuild/probe-auth-bot.py',path],{encoding:'utf8'});expect(probe(join(s.input.destination,'unified.sqlite3'))).toBe(probe(s.db.name));
    const report=JSON.parse(readFileSync(join(s.input.destination,'recovery-manifest.json'),'utf8'));expect(report.botDeliveryReview.map((row:{status:string})=>row.status)).toEqual(['sending','failed','skipped']);expect(JSON.stringify(report)).not.toContain('claim-token');expect(walk(s.input.backup)).toEqual(before);expect(walk(s.input.checkpoint)).toEqual(latest);
  });
  it.each(['music','account','reset'] as const)('replays a latest pending %s intent before publishing and preserves its receipt without reviving old data',kind=>{
    const s=setup(),entry=appendErasure(s,kind,true),prior=walk(s.input.backup);restorePairedBackup(s.input);const db=candidate(s.input.destination);
    try{expect(db.prepare('SELECT request_id FROM erasure_applied').all()).toEqual([{request_id:'requestId'in entry?entry.requestId:''}]);expect(db.prepare('SELECT secret_hash,signature FROM privacy_receipts').get()).toEqual({secret_hash:'secretHash'in entry?entry.secretHash:'',signature:'signature'in entry?entry.signature:''});if(kind==='account'){expect(db.prepare("SELECT nickname FROM users WHERE id='bob'").get()).toEqual({nickname:'已注销用户'});}else{expect(db.prepare('SELECT user_id,erased_at FROM music_profiles WHERE id=?').get(catalogProfiles.bob)).toEqual({user_id:null,erased_at:stamp});}if(kind==='reset')expect(db.prepare('SELECT * FROM music_entries').all()).toEqual([]);}finally{db.close();}expect(walk(s.input.backup)).toEqual(prior);
  });
  it.each(['music','account','reset'] as const)('replays committed %s erasures against both checkpoints before comparing domain state',kind=>{
    const s=setup();appendErasure(s,kind);s.input.checkpoint=s.capture();restorePairedBackup(s.input);const db=candidate(s.input.destination);try{if(kind==='account')expect(db.prepare("SELECT nickname FROM users WHERE id='bob'").get()).toEqual({nickname:'已注销用户'});else expect(db.prepare('SELECT * FROM music_legacy_profiles WHERE profile_id=?').get(catalogProfiles.bob)).toBeUndefined();}finally{db.close();}
  });
  it.each(['events','roster','finance','music','settings'] as const)('refuses a selected backup that would lose newer %s data',kind=>{
    const s=setup();const commands={events:"UPDATE events SET title='new-title' WHERE id='listen'",roster:"INSERT INTO roster_parties(id,event_id,manager_id,queue_mode,created_at) VALUES('new-party','listen','bob','individual','now')",finance:"INSERT INTO settlements(event_id,total_cents,headcount,updated_at) VALUES('listen',50,1,'now')",music:"UPDATE music_entries SET name='new-name' WHERE id='main-0'",settings:"UPDATE site_settings SET revision=revision+1"};s.db.exec(commands[kind]);s.input.checkpoint=s.capture();const before=walk(s.input.checkpoint);expect(()=>restorePairedBackup(s.input)).toThrow('newer business data');expect(existsSync(s.input.destination)).toBe(false);expect(walk(s.input.checkpoint)).toEqual(before);expect(readdirSync(s.root).filter(name=>name.startsWith('.qgroup-recovery-'))).toEqual([]);
  });
  it('refuses losing newer policy consent and preserves exact receipts in a blocked recovery candidate',()=>{
    const s=setup();
    s.db.exec("INSERT INTO unified_privacy_consents VALUES('bob','historical-policy','original-time','explicit'); INSERT INTO unified_privacy_receipts VALUES('bob','00000000-0000-4000-8000-000000000123','historical-policy','original-signature')");
    s.input.checkpoint=s.capture();
    expect(()=>restorePairedBackup(s.input)).toThrow('newer business data'); expect(existsSync(s.input.destination)).toBe(false);
    s.input.backup=s.input.checkpoint; restorePairedBackup(s.input); const db=candidate(s.input.destination);
    try {
      expect(db.prepare('SELECT * FROM unified_privacy_consents').all()).toEqual(s.db.prepare('SELECT * FROM unified_privacy_consents').all());
      expect(db.prepare('SELECT * FROM unified_privacy_receipts').all()).toEqual(s.db.prepare('SELECT * FROM unified_privacy_receipts').all());
      expect(db.prepare('SELECT recovery_required FROM rebuild_storage').get()).toEqual({recovery_required:1});
    }finally{db.close();}
  });
  it('replays account erasure against a consent-bearing backup without restoring consent or receipts',()=>{
    const s=setup();
    s.db.exec("INSERT INTO unified_privacy_consents VALUES('bob','historical-policy','original-time','explicit'); INSERT INTO unified_privacy_receipts VALUES('bob','00000000-0000-4000-8000-000000000123','historical-policy','original-signature')");
    s.input.backup=s.input.checkpoint=s.capture(); appendErasure(s,'account',true); restorePairedBackup(s.input); const db=candidate(s.input.destination);
    try { expect(db.prepare('SELECT * FROM unified_privacy_consents').all()).toEqual([]); expect(db.prepare('SELECT * FROM unified_privacy_receipts').all()).toEqual([]); expect(db.pragma('foreign_key_check')).toEqual([]); }
    finally{db.close();}
  });
  it('continues reading v1 archives for historical export, but refuses their unprovable recovery lineage',()=>{
    const s=setup();rewrite(s.input.backup,db=>db.exec('DROP TRIGGER unified_privacy_erasure; DROP TABLE unified_privacy_receipts; DROP TABLE unified_privacy_consents; DROP TRIGGER rebuild_storage_no_insert; DROP TRIGGER rebuild_storage_no_update; DROP TRIGGER rebuild_storage_no_delete; DROP TABLE rebuild_storage; UPDATE rebuild_schema SET version=13'),true);
    const legacy=openPairedBackup(s.input.backup);try{expect(legacy.manifest.version).toBe(1);expect(legacy.db.prepare('SELECT version FROM rebuild_schema').get()).toEqual({version:15});}finally{legacy.db.close();}
    expect(()=>restorePairedBackup(s.input)).toThrow('version 2 storage lineage');expect(existsSync(s.input.destination)).toBe(false);
  });
  it('rejects a different storage lineage or checkpoint order without publishing',()=>{
    const s=setup(),t=setup();s.input.checkpoint=t.input.checkpoint;expect(()=>restorePairedBackup(s.input)).toThrow('matching version 2');s.input.checkpoint=s.input.backup;s.input.backup=s.capture();expect(()=>restorePairedBackup(s.input)).toThrow('predates');expect(existsSync(s.input.destination)).toBe(false);
  });
  it.each(['lost','conflict','partial'])('rejects a %s latest erasure ledger',kind=>{
    const s=setup();appendErasure(s);s.input.backup=s.input.checkpoint=s.capture();if(kind==='lost')writeFileSync(s.input.latestLedger,'');if(kind==='conflict'){const value=JSON.parse(readFileSync(s.input.latestLedger,'utf8'));value.signature=hash('changed');writeFileSync(s.input.latestLedger,JSON.stringify(value)+'\n');}if(kind==='partial')writeFileSync(s.input.latestLedger,'{');expect(()=>restorePairedBackup(s.input)).toThrow();expect(existsSync(s.input.destination)).toBe(false);
  });
  it.each(['missing','identity','sent','simulated','sending'])('rejects checkpoint bot %s loss/regression',kind=>{
    const s=setup();s.db.exec("INSERT INTO bot_outbox(event_id,kind,dedupe_key,target,payload_json,status,attempts,created_at) VALUES('listen','synthetic','one','synthetic','{}','pending',2,'before')");if(kind==='sent')s.db.exec("UPDATE bot_outbox SET status='sent',sent_at='before'");if(kind==='simulated')s.db.exec("UPDATE bot_outbox SET simulated_at='before'");if(kind==='sending')s.db.exec("UPDATE bot_outbox SET status='sending'");s.input.backup=s.capture();
    if(kind==='missing')s.db.exec('DELETE FROM bot_outbox');if(kind==='identity')s.db.exec("UPDATE bot_outbox SET target='changed'");if(kind==='sent'||kind==='sending')s.db.exec("UPDATE bot_outbox SET status='pending'");if(kind==='simulated')s.db.exec('UPDATE bot_outbox SET simulated_at=NULL');s.input.checkpoint=s.capture();expect(()=>restorePairedBackup(s.input)).toThrow('bot delivery');expect(existsSync(s.input.destination)).toBe(false);
  });
  it.each(['checksum','symlink','unknown','bad-state','destination','lock'])('rejects unsafe %s inputs and preserves evidence',kind=>{
    const s=setup();if(kind==='checksum')writeFileSync(join(s.input.backup,'state.sqlite3'),'corrupt');if(kind==='symlink'){s.input.latestLedger=join(s.root,'linked-ledger');symlinkSync(join(s.root,'state.erasures.jsonl'),s.input.latestLedger);}if(kind==='unknown')writeFileSync(join(s.input.backup,'operator-note'),'retain');if(kind==='bad-state')writeFileSync(join(s.evidence,'bot-group-state.json'),'{}');if(kind==='destination')mkdirSync(s.input.destination);if(kind==='lock')writeFileSync(s.input.destination+'.recovery-lock','retain');const evidence=walk(s.evidence),backup=walk(s.input.backup);expect(()=>restorePairedBackup(s.input)).toThrow();expect(walk(s.evidence)).toEqual(evidence);expect(walk(s.input.backup)).toEqual(backup);expect(existsSync(s.input.destination)).toBe(kind==='destination');expect(readdirSync(s.root).filter(name=>name.startsWith('.qgroup-recovery-'))).toEqual([]);
  });
  it.each(['archive','ledger','evidence'])('detects late %s changes and removes the unpublished stage',kind=>{
    const s=setup(),now=new Date(stamp);vi.spyOn(now,'toISOString').mockImplementation(()=>{if(kind==='archive')writeFileSync(join(s.input.backup,'manifest.json'),readFileSync(join(s.input.backup,'manifest.json'),'utf8')+' ');if(kind==='ledger')writeFileSync(s.input.latestLedger,'\n');if(kind==='evidence')writeFileSync(join(s.evidence,'bot-events.jsonl'),'changed');return stamp;});expect(()=>restorePairedBackup(s.input,now)).toThrow('changed');expect(existsSync(s.input.destination)).toBe(false);expect(readdirSync(s.root).filter(name=>name.startsWith('.qgroup-recovery-'))).toEqual([]);
  });
  it('exposes the CLI without printing source records or secrets',()=>{
    const s=setup(),result=execFileSync(process.execPath,['--import','tsx','tools/rebuild/restore-backup.ts',s.input.backup,s.input.checkpoint,s.input.latestLedger,s.input.botEvidence,s.input.destination,'--quiescent-copy'],{encoding:'utf8'});expect(JSON.parse(result)).toEqual({status:'candidate_created',schema:15,recoveryRequired:true,releaseEligible:false});expect(result).not.toMatch(/alice|bob|claim|private/);
  });
});
