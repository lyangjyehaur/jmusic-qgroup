import Database from 'better-sqlite3';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {forwardSourceRebaseFixture} from './forward-source-rebase-fixture';
import {createApp} from '../src/app';
import {hash} from '../src/security';
import {getProfile} from '../src/repositories';
import {erasureJournal,erasureJournalPath} from '../src/erasure-journal';
import {rebaseForwardSources} from '../../../tools/migration/forward-source-rebase';
import {captureRollbackMedia} from '../../../tools/migration/rollback-media';
import {projectRollbackStateFromCheckpoint} from '../../../tools/migration/rollback-state';
import {projectRollbackHistory} from '../../../tools/migration/rollback-history';
import {assembleRollbackPackage,pinRollbackPackageSource} from '../../../tools/migration/rollback-package-codec';
import {writeRollbackPackage} from '../../../tools/migration/rollback-package';
import {writeRollbackErasureAuthority,readRollbackErasureAuthority} from '../../../tools/migration/rollback-erasure-authority';
import {proofPin} from './forward-proof-fixture';
import type {ForwardBoardAccountInput} from '../../../tools/migration/forward-board-account-source';

/** Real local native HTTP writes followed by the original Python closure. All
 * databases/credentials/delivery targets are synthetic and disposable. */
export async function forwardBoardAccountFixture(userId:'claimant'|'fresh-native'='claimant'){
  const s=await forwardSourceRebaseFixture();let latest:Database.Database|undefined;
  try{
    const origin='https://rebuild.example',raw=userId==='claimant'?'synthetic-proof-claimant':'synthetic-reference-fresh';
    if(userId==='fresh-native')s.db.prepare('INSERT INTO browser_sessions VALUES(?,?,?)').run(hash(raw),userId,'2026-11-20T03:00:00Z');
    const app=createApp({db:s.db,origin,now:()=>new Date('2026-11-20T03:00:00Z')});
    const receiptKeys=[randomUUID(),randomUUID()];
    try{
      await app.ready();const cookie='kanban_session='+raw,session=(await app.inject({url:'/api/v2/session',headers:{cookie}})).json();
      if(session.authenticated!==true)throw Error('Synthetic reference account did not authenticate');
      const headers={cookie,origin,'x-account-scope':session.scope,'x-csrf-token':session.csrf},profile=getProfile(s.db,userId)!;
      const save=await app.inject({method:'PUT',url:'/api/v2/me/music',headers:{...headers,'idempotency-key':receiptKeys[0]!},payload:{profileId:profile.id,musicEpoch:session.musicEpoch,revision:profile.revision,selections:[{entryId:'e',level:3}]}});
      if(save.statusCode!==200)throw Error('Synthetic reference selection failed: '+save.body);
      const fields=(await app.inject({url:'/api/v2/me/music/fields',headers})).json();
      const write=await app.inject({method:'PUT',url:'/api/v2/me/music/fields',headers:{...headers,'idempotency-key':receiptKeys[1]!},payload:{profileId:profile.id,musicEpoch:session.musicEpoch,revision:fields.revision,name:userId+' ref',note:'synthetic private receipt',gender:'',genderPublic:false}});
      if(write.statusCode!==200)throw Error('Synthetic reference fields failed: '+write.body);
    }finally{await app.close();}
    for(const [i,status] of ['pending','sending','sent','failed','skipped'].entries())s.db.prepare("INSERT INTO bot_outbox(event_id,kind,dedupe_key,target,payload_json,status,claim_token,retry_at,simulated_at,delivered_payload_json,created_at,recipient_user_id) VALUES('listen','account-reference',?,'synthetic','{\"frozen\":true}',?,?,?,?,?,'original',?)").run('account-reference-'+i,status,status==='sending'?'uncertain':'',status==='failed'?'retry':null,status==='skipped'?'simulation':null,status==='sent'?'saved-original-payload':null,userId);
    const rebased=rebaseForwardSources(s.rebaseInput()),data=join(s.fixtureRoot,'account-reference-private');mkdirSync(data,{mode:0o700});mkdirSync(join(data,'paired-backups'),{mode:0o700});
    const database=join(data,'unified.sqlite3');writeFileSync(database,rebased.nativeImage,{mode:0o600});writeFileSync(erasureJournalPath(database),rebased.nativeJournal,{mode:0o600});latest=new Database(database);latest.pragma('foreign_keys=ON');
    const media=captureRollbackMedia(latest,erasureJournal(latest)),state=projectRollbackStateFromCheckpoint(media.checkpointImage,media.journal),history=projectRollbackHistory(state,{capture:s.captureConfig,native:{root:join(data,'paired-backups'),manifests:[]}});
    const pkg=assembleRollbackPackage(state,media,history,pinRollbackPackageSource(media,{captureManifestSha256:s.captureConfig.manifestSha256,native:[]})),stamp=new Date('2026-11-20T05:00:00Z'),packageRoot=join(s.fixtureRoot,'account-reference-package');
    const packagePin=writeRollbackPackage(pkg,packageRoot,[s.captureRoot,data],stamp).manifestSha256,authorityRoot=join(s.fixtureRoot,'account-reference-authority');
    const pin=writeRollbackErasureAuthority(packageRoot,packagePin,authorityRoot,stamp,undefined,{database,sha256:proofPin(rebased.nativeJournal).sha256}).manifestSha256;
    const oldRoot=join(s.fixtureRoot,'account-reference-original');mkdirSync(oldRoot,{mode:0o700});const oldDatabase=join(oldRoot,'board.sqlite3');writeFileSync(oldDatabase,state.boardImage,{mode:0o600});
    const bindings:Record<string,string>={};for(const domain of ['board','music','unified'] as const){const path=join(oldRoot,domain+'.erasures.jsonl');writeFileSync(path,readRollbackErasureAuthority(authorityRoot,pin).ledgers[domain],{mode:0o600});bindings[domain]=path;}
    const closure=JSON.parse(execFileSync('python3',['-c',`import json,sqlite3,sys
from pathlib import Path
from tools.migration.rollback_erasure_authority import ErasureAuthority
from tools.migration.rollback_erasure_runtime import install_legacy_erasure_authority
from qgroup_core import privacy
root,pin,bindings,path,uid=sys.argv[1:];a=ErasureAuthority(root,pin,json.loads(bindings));undo=install_legacy_erasure_authority(a,board_privacy=privacy,board_database=Path(path))
try:
 with sqlite3.connect(path) as db:
  db.row_factory=sqlite3.Row;db.execute('PRAGMA foreign_keys=ON');db.execute('BEGIN IMMEDIATE');result=privacy.close(db,db.execute('SELECT * FROM users WHERE id=?',(uid,)).fetchone(),{'confirm_close':True})
 assert result['ok'];print(json.dumps(result))
finally:undo();a.close()`,authorityRoot,pin,JSON.stringify(bindings),oldDatabase,userId],{encoding:'utf8',stdio:'pipe',timeout:10000})) as {request_id:string;status:string};
    const sources={checkpoint:proofPin(media.checkpointImage),baselineBoard:proofPin(state.boardImage),baselineJournal:proofPin(rebased.nativeJournal),nativeImage:proofPin(media.checkpointImage),nativeJournal:proofPin(rebased.nativeJournal),oldBoard:proofPin(readFileSync(oldDatabase))};
    const input:ForwardBoardAccountInput={sources,authorityRoot,manifestSha256:pin};
    return {...s,input,receiptKeys,closure,userId,profileId:userId==='claimant'?s.id:s.native.id,latest,state,close(){latest!.close();s.close();}};
  }catch(error){latest?.close();s.close();throw error;}
}
