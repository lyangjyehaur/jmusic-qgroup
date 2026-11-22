import {cloneJson,stringifyJson} from '../../../tools/migration/music-codec';
import Database from 'better-sqlite3';
import {forwardBoardAccountFixture} from './forward-board-account-fixture';
import {hash} from '../src/security';
import {accountPin} from '../../../tools/migration/forward-account-epoch';
import type {ForwardAccountBusinessInput} from '../../../tools/migration/forward-account-business';

export const accountRebasedAt='2026-11-20T05:03:00.000Z';
/** Original native HTTP receipts + real original Python closure, followed by
 * unrelated old-site changes and private proof rows. Entirely disposable. */
export async function forwardAccountBusinessFixture(userId:'claimant'|'fresh-native'='claimant'){
  const s=await forwardBoardAccountFixture(userId);let board:Database.Database|undefined,identity:Database.Database|undefined;
  try{
    board=new Database(s.input.sources.oldBoard.bytes);identity=new Database(s.state.identityImage);
    const old=cloneJson(s.state.music.data),key=s.state.music.keys.find(k=>k.profileId===s.profileId)!.legacyKey;
    const closedSession=hash(userId==='claimant'?'synthetic-proof-claimant':'synthetic-reference-fresh');
    const members=old.members as Record<string,Record<string,unknown>>;
    members[key]!.note='old closed profile content retained';members['10002']!.note='old open profile change';
    (old.entries as Record<string,Record<string,unknown>>).e!.text='old entry change';
    members['10006']={qq:'10006',name:'old new profile',consent:true,selection:[{id:'e',level:4}],created:[],boardUserId:'',contactQQ:'10006'};
    board.prepare("UPDATE events SET title='old independent activity' WHERE id='listen'").run();
    board.prepare("INSERT INTO notifications(user_id,event_id,kind,message,created_at) VALUES('bob','listen','old-change','old message','2026-11-20T04:59:00Z')").run();
    const notificationId=(board.prepare("SELECT id FROM notifications WHERE kind='old-change'").get() as {id:number}).id;
    identity.prepare('INSERT INTO link_overrides VALUES(?,?,7,1795147140)').run(key,userId);
    identity.prepare("INSERT INTO sessions(rowid,token_hash,qq,expires,source_session,pending_until) VALUES(40,'closed-key',?,9999999999,'unrelated-source',0),(41,'closed-device','10002',9999999999,?,0),(42,'open-device','10002',9999999999,'open-source',1.25)").run(key,closedSession);
    identity.prepare("INSERT INTO entry_intents(rowid,token_hash,qq,source_session,target_user_id,payload,expires) VALUES(50,'closed-key',?,'open-source','bob','{}',9999999999),(51,'closed-target','10002','open-source',?,'{}',9999999999),(52,'closed-device','10002',?,'bob','{}',9999999999),(53,'open-device','10002','open-source','bob','{\"retain\":true}',9999999999)").run(key,userId,closedSession);
    // The payload refers to the closed user; Bob still owns this profile.
    identity.prepare('INSERT INTO native_profiles(qq,payload) VALUES(?,?)').run('10002',JSON.stringify({...members['10002'],boardUserId:userId}));
    identity.prepare("INSERT INTO used_oauth(rowid,attempt,created) VALUES(30,'old-consumed',1795147140.25)").run();
    identity.prepare("INSERT INTO login_attempts(rowid,bucket,created) VALUES(31,?,1795147140.5)").run('ip:'+'c'.repeat(64));
    identity.prepare("INSERT INTO link_audit(id,qq,actor,before_user_id,after_user_id,created) VALUES(12,'10002','old-admin','bob','bob',1795147140.75)").run();
    identity.prepare("UPDATE sqlite_sequence SET seq=40 WHERE name='link_audit'").run();
    const input=():ForwardAccountBusinessInput=>({sources:{...s.input.sources,baselineMusic:accountPin(Buffer.from(stringifyJson({...s.state.music,identityAuditMappings:s.state.identityAuditMappings}))),baselineIdentity:accountPin(s.state.identityImage),oldMusic:accountPin(Buffer.from(stringifyJson(old))),oldIdentity:accountPin(identity!.serialize()),oldBoard:accountPin(board!.serialize())},authorityRoot:s.input.authorityRoot,manifestSha256:s.input.manifestSha256,preparedAt:'2026-11-20T05:00:00.000Z',reconstructedAt:'2026-11-20T05:01:00.000Z',reconciledAt:'2026-11-20T05:02:00.000Z'});
    return {...s,accountOldBoard:board,accountOldIdentity:identity,accountOld:old,accountKey:key,closedSession,notificationId,accountInput:input,close(){identity!.close();board!.close();s.close();}};
  }catch(error){identity?.close();board?.close();s.close();throw error;}
}
