import { seedMusicShouts,type DB } from '@qgroup/database';
export function musicShoutFixture(db:DB,time=new Date()){
  const stamp=time.getTime()/1000,profiles=db.prepare('SELECT id,user_id FROM music_profiles WHERE erased_at IS NULL ORDER BY rowid').all() as {id:string;user_id:string|null}[];
  // Ordinary preview/fixture has no profiles: make two distinct saved music identities.
  for(const user of ['alice','bob'])if(!profiles.some(p=>p.user_id===user)){
    const id='m_'+(user==='alice'?'a':'b').repeat(32);db.prepare("INSERT INTO music_profiles VALUES(?,?,1,'synthetic',NULL)").run(id,user);
    db.prepare("INSERT INTO music_profile_fields VALUES(?,?,'不可匯出留言',0,'不可匯出性別',0,0,'synthetic')").run(id,user==='alice'?'找搭子甲':'找搭子乙');
    db.prepare("INSERT INTO music_profile_contacts VALUES(?,?,'self_reported',0,'synthetic')").run(id,user==='alice'?'123456':'234567');
    db.prepare("INSERT INTO music_selections VALUES(?,'sub-2',3,0)").run(id);
  }
  const id=(user:string)=>(db.prepare('SELECT id FROM music_profiles WHERE user_id=?').get(user) as {id:string}).id;
  db.prepare("INSERT INTO music_documents VALUES('shouts',0,?)").run(JSON.stringify({id:'shout-bob',qq:id('bob'),name:'發布時乙',text:'週末一起聽音樂',createdAt:stamp-60}));
  db.prepare("INSERT INTO music_documents VALUES('shouts',1,?)").run(JSON.stringify({id:'shout-expired',qq:id('bob'),name:'發布時乙',text:'剛好過期的內容',createdAt:stamp-30*86400}));
  for(let i=0;i<23;i++)db.prepare("INSERT INTO music_documents VALUES('shoutHistory',?,?)").run(i,JSON.stringify({id:'shout-history-'+i,qq:id('bob'),name:'發布時乙',text:'歷史找搭子 '+i,createdAt:stamp-(31+i)*86400,archivedAt:stamp-100}));
  db.prepare("INSERT INTO music_documents VALUES('shoutHistory',23,?)").run(JSON.stringify({id:'shout-orphan',qq:'已不存在的私人識別',name:'舊發布者',text:'未關聯舊發布內容',createdAt:stamp-100*86400,archivedAt:stamp-50}));
  seedMusicShouts(db);
}
