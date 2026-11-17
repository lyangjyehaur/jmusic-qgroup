import type { DB } from '@qgroup/database';
export const catalogProfiles={alice:'m_'+'a'.repeat(32),bob:'m_'+'b'.repeat(32),orphan:'m_'+'c'.repeat(32)};
export function adminCatalogFixture(db:DB){
  for(const [key,user] of [['alice','alice'],['bob','bob'],['orphan',null]] as const){
    const id=catalogProfiles[key];db.prepare("INSERT INTO music_profiles VALUES(?,?,0,'synthetic',NULL)").run(id,user);
    db.prepare("INSERT INTO music_profile_fields VALUES(?,?,'不可匯出留言',0,'不可匯出性別',0,0,'synthetic')").run(id,'詞庫'+key);
  }
  db.prepare("INSERT INTO music_entry_details VALUES('sub-0','歌手',?,?,123,'null')").run(JSON.stringify(['源別名','Yoru','\ufeff保留']),catalogProfiles.alice);
  db.prepare("INSERT INTO music_entry_details VALUES('sub-1','歌手',?,'10002',456,'null')").run(JSON.stringify(['Yoru','  原別名  ']));
  db.prepare("INSERT INTO music_legacy_profiles VALUES(?,'10002','詞庫bob',1,'private','10002','{}',?,'oauth')").run(catalogProfiles.bob,JSON.stringify(['sub-1','sub-0','main-0']));
  db.prepare("INSERT INTO music_legacy_profiles VALUES(?,'10003','詞庫orphan',1,'private','10003','{}',?,'unlinked')").run(catalogProfiles.orphan,JSON.stringify(['sub-0']));
  for(const [key,items] of [['alice',[['sub-0',1],['main-0',4],['sub-1',4]]],['bob',[['sub-1',4],['sub-0',1]]],['orphan',[['main-0',3],['sub-0',2]]]] as const)
    items.forEach(([id,level],index)=>db.prepare('INSERT INTO music_selections VALUES(?,?,?,?)').run(catalogProfiles[key],id,level,index));
}
