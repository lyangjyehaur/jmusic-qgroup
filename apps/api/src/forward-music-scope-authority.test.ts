import {openDatabase} from '@qgroup/database';
import {afterEach,expect,it} from 'vitest';
import {readForwardMusicScopeKeys} from '../../../tools/migration/forward-music-scope-authority';
import {digest} from '../../../packages/runtime/src/strict-json';
const cleanup:(()=>void)[]=[];afterEach(()=>cleanup.splice(0).reverse().forEach(close=>close()));
const first='m_'+'a'.repeat(32),second='m_'+'b'.repeat(40),generated=(id:string)=>'m_'+digest('qgroup:rollback-music-key:v1:'+id).slice(0,24);
function setup(){const db=openDatabase(':memory:');cleanup.push(()=>db.close());db.prepare("INSERT INTO music_profiles VALUES(?,NULL,0,'before',NULL),(?,NULL,0,'before',NULL)").run(first,second);return db;}

it('derives distinct generated keys from original 32/40-character IDs without creating profiles',()=>{
  const db=setup(),before=db.serialize();expect(readForwardMusicScopeKeys(db,[])).toEqual([{legacyKey:generated(first),profileId:first,erased:false},{legacyKey:generated(second),profileId:second,erased:false}]);expect(db.serialize()).toEqual(before);
});
it('retains an erased original alias without surviving private profile content',()=>{
  const db=setup();db.prepare("UPDATE music_profiles SET erased_at='2026-11-20T00:00:00Z' WHERE id=?").run(first);db.prepare("INSERT INTO migration_map VALUES('music','profile','10001',?,'','original','erased')").run(first);db.exec("INSERT INTO music_legacy_erasures VALUES('10001','{\"opaque\":true}')");
  const before=db.serialize();expect(readForwardMusicScopeKeys(db,[])[0]).toEqual({legacyKey:'10001',profileId:first,erased:true});expect(db.serialize()).toEqual(before);
});
it.each(['ambiguous alias','duplicate key','generated collision','active erased key','unsupported alias','unsupported profile','unsupported erased key','unbound rebase','unbound retirement'])('rejects an unsafe independently read binding: %s',change=>{
  const db=setup();
  if(change==='ambiguous alias'){db.prepare("INSERT INTO migration_map VALUES('music','profile','10001',?,'','original','imported'),('music','profile','10002',?,'','original','imported')").run(first,first);}
  if(change==='duplicate key'){db.prepare("INSERT INTO migration_map VALUES('music','profile','10001',?,'','original','imported')").run(second);db.prepare("INSERT INTO music_legacy_profiles VALUES(?,'10001','原名',1,'','','{}','[]','legacy')").run(first);}
  if(change==='generated collision')db.prepare("INSERT INTO migration_map VALUES('music','profile',?,?,'','original','imported')").run(generated(first),second);
  if(change==='active erased key'){db.prepare("INSERT INTO migration_map VALUES('music','profile','10001',?,'','original','imported')").run(first);db.exec("INSERT INTO music_legacy_erasures VALUES('10001','123')");}
  if(change==='unsupported alias')db.prepare("INSERT INTO migration_map VALUES('music','profile','invalid',?,'','original','imported')").run(first);
  if(change==='unsupported profile'){db.pragma('foreign_keys = OFF');db.prepare('UPDATE music_profiles SET id=? WHERE id=?').run('unrecognized',first);}
  if(change==='unsupported erased key')db.exec("INSERT INTO music_legacy_erasures VALUES('invalid','123')");
  if(change==='unbound rebase')db.exec("INSERT INTO migration_runs VALUES('original','{\"kind\":\"forward_source_rebase\"}','{}','before')");
  if(change==='unbound retirement')db.exec("INSERT INTO music_documents VALUES('profile_retirement',0,'{}')");
  const before=db.serialize();expect(()=>readForwardMusicScopeKeys(db,[])).toThrow();expect(db.serialize()).toEqual(before);
});
