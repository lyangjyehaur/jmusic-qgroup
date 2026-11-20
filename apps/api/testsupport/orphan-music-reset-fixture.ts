import type {DB} from '@qgroup/database';
/** Only used before the isolated preview starts. No production entry imports it. */
export function orphanMusicResetFixture(db:DB,mode:'shouts'|'trend'|'empty'){
  if((db.prepare('SELECT count(*) n FROM music_profiles').get() as {n:number}).n)throw Error('Orphan reset fixture requires no profiles');
  db.exec('DELETE FROM music_entries');
  db.prepare("INSERT INTO music_documents VALUES('settings',0,?)").run(JSON.stringify({theme:'dark',opaque:'retained-settings'}));
  if(mode==='empty')return;
  if(mode==='shouts'){
    db.exec("INSERT INTO music_shouts VALUES('orphan-active',NULL,'99999','合成匿名稱呼','目前留言',123.25,NULL,0),('orphan-history',NULL,'99998','合成歷史稱呼','歷史留言',122.5,123.75,1)");
    for(const kind of ['shouts','shoutHistory'])db.prepare('INSERT INTO music_documents VALUES(?,0,?)').run(kind,JSON.stringify({id:kind==='shouts'?'orphan-active':'orphan-history',opaque:'original-source'}));
  }
  for(const kind of ['trend','trend_sample']){
    db.prepare('INSERT INTO music_documents VALUES(?,0,?)').run(kind,JSON.stringify({t:123.5,counts:{},opaque:'original-history'}));
    db.prepare("INSERT INTO migration_map VALUES('music',?, '0','0','original-revision','original-digest','imported')").run(kind==='trend_sample'?'unrelated':'trend');
  }
}
