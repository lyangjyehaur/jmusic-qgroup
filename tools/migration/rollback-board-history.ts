import {randomBytes} from 'node:crypto';
import type {DB} from '@qgroup/database';
import {createPrivacy} from '../../apps/api/src/privacy';
import {digest,parseJson} from './music-codec';
import type {RollbackPackage} from './rollback-package-codec';
import {projectRollbackBoard} from './rollback-board';
import {historicalBoardImages,openRollbackBoardHistory,type BoardHistoryMetadata} from './rollback-board-history-source';
import {verifyRollbackBoardHistory} from './rollback-board-history-reconciliation';

export type HistoricalClosure={user_id:string;request_id:string;created_at:string};
export type RollbackBoardHistory={version:1;preparedAt:string;metadata:BoardHistoryMetadata;checkpointSha256:string;journalSha256:string;boardImage:Buffer;boardJournal:string;images:{path:string;bytes:Buffer}[]};
export function historicalClosures(text:string){
  if(text&&!text.endsWith('\n'))throw Error('Incomplete board history ledger');const rows:HistoricalClosure[]=[],ids=new Map<string,string>();
  for(const line of text.split('\n').slice(0,-1)){const row=parseJson(line);if(!row||typeof row!=='object'||Array.isArray(row)||JSON.stringify(Object.keys(row).sort())!==JSON.stringify(['created_at','request_id','user_id'])||Object.values(row).some(value=>typeof value!=='string'||value===''))throw Error('Invalid board history closure');const key=row.request_id as string,encoded=JSON.stringify(row);if(ids.has(key)&&ids.get(key)!==encoded)throw Error('Conflicting board history closure');ids.set(key,encoded);rows.push(row as HistoricalClosure);}return rows;
}
const originalShared:Record<string,string[]>={events:['owner_id'],registrations:['user_id'],roster_parties:['manager_id'],attendees:['user_id','manager_id'],event_audit:['actor_id'],attendee_consents:['actor_id'],event_roles:['user_id'],management_invitations:['recipient_id','initiator_id','accepted_by'],settlement_history:['actor_id'],finance_reports:['reporter_id'],finance_report_actions:['actor_id'],finance_entries:['actor_id'],attendee_claims:['issuer_id','requester_id'],attendee_payment_origins:['payer_user_id'],time_polls:['owner_id'],time_poll_history:['actor_id']};
/** Latest account closures only, with the original old privacy.erase semantics.
 * Music/reset intents never become account closures. Historical shared business
 * rows and all old outbox work stay historical data, not runnable work. */
function replayBoardClosures(db:DB,rows:HistoricalClosure[],now:string){
  if(db.inTransaction)throw Error('History replay requires a standalone transaction');
  db.transaction(()=>{for(const {user_id:user,request_id:id,created_at:created} of rows){
    if(!db.prepare('SELECT 1 FROM users WHERE id=?').get(user)||db.prepare('SELECT 1 FROM privacy_requests WHERE user_id=?').get(user))continue;
    const role=db.prepare('SELECT revision FROM user_admin_roles WHERE user_id=? AND is_admin=1').safeIntegers(true).get(user) as {revision:bigint}|undefined;
    if(role){db.prepare('UPDATE user_admin_roles SET is_admin=0,revision=revision+1,updated_at=? WHERE user_id=?').run(now,user);db.prepare("INSERT INTO admin_role_history(user_id,actor_ref,before_value,after_value,revision,created_at) VALUES(?,'account_closure',1,0,?,?)").run(user,role.revision+1n,now);}
    const shared=Object.entries(originalShared).some(([table,columns])=>!!db.prepare('SELECT 1 FROM '+table+' WHERE '+columns.map(column=>column+'=?').join(' OR ')+' LIMIT 1').get(...columns.map(()=>user)));
    db.prepare("UPDATE time_polls SET vote_revision=vote_revision+1 WHERE status IN ('open','closed') AND id IN (SELECT poll_id FROM time_poll_ballots WHERE user_id=?)").run(user);
    db.prepare('DELETE FROM time_poll_votes WHERE user_id=?').run(user);db.prepare('DELETE FROM time_poll_ballots WHERE user_id=?').run(user);
    db.prepare("DELETE FROM login_attempts WHERE provider='qq' AND EXISTS(SELECT 1 FROM external_identities x WHERE x.user_id=? AND x.provider='qq' AND x.client_id=login_attempts.app_id AND x.subject=login_attempts.openid)").run(user);
    for(const {token_hash:token} of db.prepare('SELECT token_hash FROM browser_sessions WHERE user_id=?').all(user) as {token_hash:string}[])for(const table of ['login_attempts','auth_requests','browser_accounts','browser_sessions','visitor_sessions'])db.prepare('DELETE FROM '+table+' WHERE token_hash=?').run(token);
    db.prepare('DELETE FROM browser_accounts WHERE user_id=?').run(user);
    for(const table of ['external_profiles','external_identities','qq_accounts','qq_attempts','login_attempts','privacy_consents','user_payment_codes','notifications','request_results','device_links','admin_user_metadata','event_access'])db.prepare('DELETE FROM '+table+' WHERE user_id=?').run(user);
    db.exec('DELETE FROM image_assets WHERE NOT EXISTS(SELECT 1 FROM user_payment_codes WHERE digest=image_assets.digest) AND NOT EXISTS(SELECT 1 FROM settlement_code_images WHERE digest=image_assets.digest) AND NOT EXISTS(SELECT 1 FROM settlement_receipt_images WHERE digest=image_assets.digest)');
    db.prepare("UPDATE users SET nickname='已注销用户',token_hash=? WHERE id=?").run(randomBytes(32).toString('hex'),user);
    db.prepare('INSERT INTO privacy_requests(id,user_id,status,created_at,updated_at) VALUES(?,?,?,?,?)').run(id,user,shared?'shared_review':'completed',created,now);
  }}).immediate();
}
/** An inactive private history artifact. It does not replace current data,
 * activate a worker, restore credentials into a service or certify rollback. */
export function projectRollbackBoardHistory(pkg:RollbackPackage,id:string,now=new Date()){
  const opened=openRollbackBoardHistory(pkg,id);let board:DB|undefined;
  try{
    if(opened.metadata.source==='native_board'){
      createPrivacy(opened.db,{read:()=>structuredClone(pkg.state.journal),append(){throw Error('Read-only historical journal');}});
      board=projectRollbackBoard(opened.db).db;
    }else board=opened.db;
    const preparedAt=now.toISOString(),boardJournal=pkg.state.erasures.boardJournal;replayBoardClosures(board,historicalClosures(boardJournal),preparedAt);
    const wanted=board.prepare('SELECT digest FROM image_assets ORDER BY digest').all() as {digest:string}[],images=historicalBoardImages(board,new Map(wanted.map(row=>{const path='images/'+row.digest.slice(0,2)+'/'+row.digest+'.png',bytes=opened.images.get(path);if(!bytes)throw Error('Missing history image after erasure');return [path,bytes];})));
    const result:RollbackBoardHistory={version:1,preparedAt,metadata:opened.metadata,checkpointSha256:pkg.sourcePins.checkpointSha256,journalSha256:digest(JSON.stringify(pkg.state.journal)),boardImage:board.serialize(),boardJournal,images};
    const report=verifyRollbackBoardHistory(pkg,result);return {...result,report};
  }finally{if(board&&board!==opened.db)board.close();opened.db.close();}
}
