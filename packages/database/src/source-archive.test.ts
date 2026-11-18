import { describe, expect, it } from 'vitest';
import { openDatabase, eraseLegacyProfile, detachLegacyAccount } from './index';

describe('inactive music source archive privacy',()=>{
  it('removes profile evidence after an earlier replay has already removed its legacy projection',()=>{
    const db=openDatabase(':memory:');
    try{
      db.prepare('INSERT INTO music_documents VALUES(?,?,?)').run('profile_source',0,JSON.stringify({profileId:'erased',legacyKey:'10000',source:'json',member:{name:'private',pinHash:'private-proof'}}));
      db.prepare('INSERT INTO music_documents VALUES(?,?,?)').run('profile_source',1,JSON.stringify({profileId:'other',legacyKey:'10001',source:'json',member:{name:'retain'}}));
      eraseLegacyProfile(db,'erased','stamp');eraseLegacyProfile(db,'erased','stamp');
      const rows=db.prepare("SELECT payload_json FROM music_documents WHERE kind='profile_source'").all() as {payload_json:string}[];
      expect(rows).toHaveLength(1);expect(JSON.parse(rows[0]!.payload_json).profileId).toBe('other');expect(JSON.stringify(rows)).not.toContain('private-proof');
    }finally{db.close();}
  });
  it('redacts stable-ID creators from archived terms without a legacy profile and keeps other term fields',()=>{
    const db=openDatabase(':memory:');
    try{
      const entry={id:'entry',text:'原詞條',aliases:['原別名'],createdBy:'erased',createdAt:123,kind:'legacy-kind'};
      db.prepare('INSERT INTO music_documents VALUES(?,?,?)').run('entry_source',0,JSON.stringify({entryId:'entry',entry}));
      eraseLegacyProfile(db,'erased','stamp');
      const row=db.prepare("SELECT payload_json FROM music_documents WHERE kind='entry_source'").get() as {payload_json:string};
      expect(JSON.parse(row.payload_json)).toEqual({entryId:'entry',entry:{...entry,createdBy:''}});
    }finally{db.close();}
  });
  it('uses the retained migration mapping to erase legacy-key sources and proofs after the legacy projection is absent',()=>{
    const db=openDatabase(':memory:');
    try{
      db.prepare("INSERT INTO migration_map VALUES('music','profile','10000','erased','','original','preserved')").run();
      db.prepare('INSERT INTO music_documents VALUES(?,?,?)').run('entry_source',0,JSON.stringify({entryId:'entry',entry:{createdBy:'10000',text:'retain'}}));
      db.prepare('INSERT INTO music_legacy_identity VALUES(?,?,?)').run('sessions',0,JSON.stringify({qq:'10000',token_hash:'inactive-but-private'}));
      eraseLegacyProfile(db,'erased','stamp');
      expect(db.prepare("SELECT json_extract(payload_json,'$.entry.createdBy') AS creator FROM music_documents WHERE kind='entry_source'").get()).toEqual({creator:''});
      expect(db.prepare('SELECT * FROM music_legacy_identity').all()).toEqual([]);
      expect(db.prepare("SELECT status FROM migration_map WHERE source='music'").get()).toEqual({status:'erased'});
      expect(db.prepare('SELECT erased_at_json FROM music_legacy_erasures WHERE legacy_key=?').get('10000')).toEqual({erased_at_json:'"stamp"'});
    }finally{db.close();}
  });
  it('clears closed-account references from source evidence without deleting separate music or inactive PIN fields',()=>{
    const db=openDatabase(':memory:');
    try{
      const member={qq:'10000',boardUserId:'closed',name:'獨立稱呼',selection:[{id:'e',level:4}],pinHash:'music-only-proof',contactQQ:''};
      db.prepare('INSERT INTO music_documents VALUES(?,?,?)').run('profile_source',0,JSON.stringify({profileId:'legacy',legacyKey:'10000',source:'json',member}));
      db.prepare("INSERT INTO migration_map VALUES('music','profile','10000','legacy','','original-digest','preserved')").run();
      detachLegacyAccount(db,'closed');detachLegacyAccount(db,'closed');
      const row=db.prepare("SELECT payload_json FROM music_documents WHERE kind='profile_source'").get() as {payload_json:string};
      expect(JSON.parse(row.payload_json).member).toEqual({...member,boardUserId:''});
      expect(db.prepare("SELECT payload_digest,status FROM migration_map WHERE source='music'").get()).toEqual({payload_digest:'original-digest',status:'erasure_redacted'});
    }finally{db.close();}
  });
});
