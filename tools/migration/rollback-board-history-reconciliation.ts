import Database from 'better-sqlite3';
import type {DB} from '@qgroup/database';
import {createPrivacy} from '../../apps/api/src/privacy';
import {digest} from './music-codec';
import type {RollbackPackage} from './rollback-package-codec';
import {verifyRollbackBoard} from './rollback-board-reconciliation';
import {historicalBoardImages,openRollbackBoardHistory} from './rollback-board-history-source';
import {historicalClosures,type HistoricalClosure,type RollbackBoardHistory} from './rollback-board-history';
const same=(a:unknown,b:unknown)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw Error('Historical board reconciliation differs');};
// Independent old-board specification. Do not call the history projector or
// derive permitted changes from its report. Shared records are queried before
// closure as in the unmodified old privacy module, including immutable history.
const shared:Record<string,string[]>={events:['owner_id'],registrations:['user_id'],roster_parties:['manager_id'],attendees:['user_id','manager_id'],event_audit:['actor_id'],attendee_consents:['actor_id'],event_roles:['user_id'],management_invitations:['recipient_id','initiator_id','accepted_by'],settlement_history:['actor_id'],finance_reports:['reporter_id'],finance_report_actions:['actor_id'],finance_entries:['actor_id'],attendee_claims:['issuer_id','requester_id'],attendee_payment_origins:['payer_user_id'],time_polls:['owner_id'],time_poll_history:['actor_id']};
function expectedClosures(db:DB,entries:HistoricalClosure[],stamp:string){
  db.transaction(()=>{for(const entry of entries){const user=entry.user_id;
    if(!db.prepare('SELECT 1 FROM users WHERE id=?').get(user)||db.prepare('SELECT 1 FROM privacy_requests WHERE user_id=?').get(user))continue;
    const hasShared=Object.entries(shared).some(([table,columns])=>(db.prepare('SELECT count(*) AS n FROM '+table+' WHERE '+columns.map(column=>column+'=?').join(' OR ')).get(...columns.map(()=>user)) as {n:number}).n>0);
    db.prepare("UPDATE time_polls SET vote_revision=vote_revision+1 WHERE status IN ('open','closed') AND EXISTS(SELECT 1 FROM time_poll_ballots b WHERE b.poll_id=time_polls.id AND b.user_id=?)").run(user);
    db.prepare('DELETE FROM time_poll_votes WHERE user_id=?').run(user);db.prepare('DELETE FROM time_poll_ballots WHERE user_id=?').run(user);
    db.prepare("DELETE FROM login_attempts WHERE provider='qq' AND EXISTS(SELECT 1 FROM external_identities i WHERE i.user_id=? AND i.provider='qq' AND i.client_id=login_attempts.app_id AND i.subject=login_attempts.openid)").run(user);
    for(const table of ['login_attempts','auth_requests','browser_accounts','visitor_sessions'])db.prepare('DELETE FROM '+table+' WHERE token_hash IN (SELECT token_hash FROM browser_sessions WHERE user_id=?)').run(user);
    db.prepare('DELETE FROM browser_accounts WHERE user_id=?').run(user);db.prepare('DELETE FROM browser_sessions WHERE user_id=?').run(user);
    for(const table of ['external_profiles','external_identities','qq_accounts','qq_attempts','login_attempts','privacy_consents','user_payment_codes','notifications','request_results','device_links','admin_user_metadata','event_access'])db.prepare('DELETE FROM '+table+' WHERE user_id=?').run(user);
    db.exec('DELETE FROM image_assets WHERE digest NOT IN (SELECT digest FROM user_payment_codes UNION SELECT digest FROM settlement_code_images UNION SELECT digest FROM settlement_receipt_images)');
    const role=db.prepare('SELECT revision FROM user_admin_roles WHERE user_id=? AND is_admin=1').safeIntegers(true).get(user) as {revision:bigint}|undefined;
    if(role){db.prepare('UPDATE user_admin_roles SET is_admin=0,revision=revision+1,updated_at=? WHERE user_id=?').run(stamp,user);db.prepare("INSERT INTO admin_role_history(user_id,actor_ref,before_value,after_value,revision,created_at) VALUES(?,'account_closure',1,0,?,?)").run(user,role.revision+1n,stamp);}
    db.prepare("UPDATE users SET nickname='已注销用户',token_hash=? WHERE id=?").run('history-reference-revoked:'+user,user);
    db.prepare('INSERT INTO privacy_requests(id,user_id,status,created_at,updated_at) VALUES(?,?,?,?,?)').run(entry.request_id,user,hasShared?'shared_review':'completed',entry.created_at,stamp);
  }}).immediate();
}
function assertClosed(db:DB,entries:HistoricalClosure[]){
  for(const user of new Set(entries.map(row=>row.user_id))){const row=db.prepare('SELECT nickname,token_hash FROM users WHERE id=?').get(user) as {nickname:string;token_hash:string}|undefined;if(!row)continue;
    const request=db.prepare('SELECT status FROM privacy_requests WHERE user_id=?').get(user) as {status:string}|undefined;if(!request||!['completed','shared_review'].includes(request.status)||row.nickname!=='已注销用户'||!/^[a-f0-9]{64}$/.test(row.token_hash)||db.prepare('SELECT 1 FROM user_admin_roles WHERE user_id=? AND is_admin=1').get(user))throw Error('Historical account closure is not effective');
    for(const table of ['browser_sessions','browser_accounts','external_profiles','external_identities','qq_accounts','qq_attempts','login_attempts','privacy_consents','user_payment_codes','notifications','request_results','device_links','admin_user_metadata','event_access','time_poll_votes','time_poll_ballots'])if(db.prepare('SELECT 1 FROM '+table+' WHERE user_id=? LIMIT 1').get(user))throw Error('Historical account proof or private data survived');
  }
}
/** Reopen separately retained original history and latest-authority bytes.
 * Compare all 59 board tables, signed rowids/storage classes, schema, indexes,
 * triggers, metadata and sequence high watermarks. Random revoked tokens are
 * checked for freshness before normalization solely in a disposable copy. */
export function verifyRollbackBoardHistory(pkg:RollbackPackage,result:RollbackBoardHistory){
  if(result.version!==1||JSON.stringify(Object.keys(result).filter(key=>key!=='report').sort())!==JSON.stringify(['version','preparedAt','metadata','checkpointSha256','journalSha256','boardImage','boardJournal','images'].sort())||!Buffer.isBuffer(result.boardImage)||result.boardImage.length<100||result.boardImage[18]!==1||result.boardImage[19]!==1||new Date(result.preparedAt).toISOString()!==result.preparedAt)throw Error('Invalid historical board projection');
  if(result.checkpointSha256!==pkg.sourcePins.checkpointSha256||result.journalSha256!==digest(JSON.stringify(pkg.state.journal))||result.boardJournal!==pkg.state.erasures.boardJournal)throw Error('Historical board latest-authority pin differs');
  const opened=openRollbackBoardHistory(pkg,result.metadata.id);let actual:DB|undefined,latest:DB|undefined;
  try{
    actual=new Database(result.boardImage);latest=new Database(pkg.state.checkpointImage);
    same(result.metadata,opened.metadata);verifyRollbackBoard(actual,actual);const entries=historicalClosures(pkg.state.erasures.boardJournal);
    const before=new Map((opened.db.prepare('SELECT id,token_hash FROM users').all() as {id:string;token_hash:string}[]).map(row=>[row.id,row.token_hash]));
    const known=new Set([...before.values(),...(opened.db.prepare('SELECT token_hash FROM browser_sessions').all() as {token_hash:string}[]).map(row=>row.token_hash),...(latest.prepare('SELECT token_hash FROM users UNION SELECT token_hash FROM browser_sessions').all() as {token_hash:string}[]).map(row=>row.token_hash)]);
    if(opened.metadata.source==='native_board')createPrivacy(opened.db,{read:()=>structuredClone(pkg.state.journal),append(){throw Error('Read-only history verification');}});
    expectedClosures(opened.db,entries,result.preparedAt);assertClosed(actual,entries);
    const fresh=new Set<string>();
    for(const row of opened.db.prepare('SELECT id,token_hash FROM users').all() as {id:string;token_hash:string}[]){
      if(before.get(row.id)===row.token_hash)continue;
      const token=(actual.prepare('SELECT token_hash FROM users WHERE id=?').get(row.id) as {token_hash:string}|undefined)?.token_hash;
      if(!token||!/^[a-f0-9]{64}$/.test(token)||known.has(token)||fresh.has(token))throw Error('Historical revoked token was reused');fresh.add(token);actual.prepare('UPDATE users SET token_hash=? WHERE id=?').run(row.token_hash,row.id);
    }
    const board=verifyRollbackBoard(opened.db,actual);
    if(!Array.isArray(result.images)||result.images.some(row=>JSON.stringify(Object.keys(row).sort())!==JSON.stringify(['bytes','path'])||!Buffer.isBuffer(row.bytes))||new Set(result.images.map(row=>row.path)).size!==result.images.length)throw Error('Historical image output differs');
    const rows=opened.db.prepare('SELECT digest FROM image_assets ORDER BY digest').all() as {digest:string}[],expected=historicalBoardImages(opened.db,new Map(rows.map(row=>{const path='images/'+row.digest.slice(0,2)+'/'+row.digest+'.png',bytes=opened.images.get(path);if(!bytes)throw Error('Expected historical image missing');return [path,bytes];})));
    same(result.images.map(row=>({path:row.path,sha256:digest(row.bytes),size:row.bytes.length})),expected.map(row=>({path:row.path,sha256:digest(row.bytes),size:row.bytes.length})));
    return {version:1 as const,tableCount:board.tableCount,imageCount:result.images.length,revokedTokens:fresh.size,databaseSha256:digest(result.boardImage),latestBoardLedgerSha256:digest(result.boardJournal),rollbackEligible:false as const,historyOnly:true as const,remaining:['historical_legacy_schema_coverage','durable_post_restore_erasure_authority','fixed_old_web_music_bot_rehearsal','actual_candidate_version_pair','forward_restore_mapping']};
  }finally{opened.db.close();actual?.close();latest?.close();}
}
