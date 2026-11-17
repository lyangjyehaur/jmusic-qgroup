import type { DB } from '@qgroup/database';
import { defaultBotPolicy } from '@qgroup/domain';
import { timePollFixture } from './time-poll-fixture';
/** Synthetic notices only. Never starts a consumer, Gateway or QQ request. */
export function botDeliveryFixture(db:DB){
  timePollFixture(db);db.exec("UPDATE events SET bot_enabled=1 WHERE id='listen'");
  db.prepare('UPDATE bot_settings SET config_json=?').run(JSON.stringify(defaultBotPolicy({enabled:true,dry_run:false,groups:[{id:'synthetic-group',name:'合成群',replies:true,broadcast:true}]})));
  for(const [status,error,simulated,text] of [
    ['failed','合成失敗',null,'合成失敗通知內容'],
    ['skipped','dry-run','before','合成模擬通知內容'],
    ['skipped','平台返回异步结果，未确认送出，需人工核对',null,'合成未確認通知內容'],
    ['sent','',null,'合成已送通知內容'],
    ['pending','',null,'合成待送通知內容'],
  ] as const)db.prepare("INSERT INTO bot_outbox(event_id,kind,dedupe_key,target,payload_json,status,last_error,simulated_at,sent_at,created_at) VALUES('listen','activity_published',?,'synthetic-group',?,?,?,?,?,'2026-11-18T00:00:00+00:00')").run(status+error,JSON.stringify({text,private_secret:'DO NOT EXPOSE PAYLOAD'}),status,error,simulated,status==='sent'?'before':null);
  db.prepare("INSERT INTO bot_outbox(event_id,poll_id,kind,dedupe_key,target,payload_json,status,created_at) VALUES(NULL,'poll-exact','time_poll_published','poll-notice','synthetic-group','{\"text\":\"合成投票原通知\"}','failed','before')").run();
}
