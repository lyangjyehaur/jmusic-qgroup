import { mkdtempSync,rmSync,existsSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach,it,expect } from 'vitest';
import { openDatabase,openServiceDatabase } from './index';
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
it('requires prepared current storage and cannot create a missing database or migrate legacy/old/recovery storage on service startup',()=>{
 const root=mkdtempSync(join(tmpdir(),'qgroup-service-start-'));roots.push(root);const missing=join(root,'missing.db');expect(()=>openServiceDatabase(missing)).toThrow();expect(existsSync(missing)).toBe(false);
 const legacy=join(root,'legacy.db'),raw=new Database(legacy);raw.exec('CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES(\'original\')');raw.close();const bytes=readFileSync(legacy);expect(()=>openServiceDatabase(legacy)).toThrow();expect(readFileSync(legacy)).toEqual(bytes);
 const path=join(root,'prepared.db');let db=openDatabase(path);db.close();db=openServiceDatabase(path);expect(db.pragma('foreign_keys',{simple:true})).toBe(1);db.prepare('UPDATE rebuild_storage SET recovery_required=1 WHERE id=1').run();db.close();expect(()=>openServiceDatabase(path)).toThrow(/offline review/);
 const old=join(root,'old.db');db=openDatabase(old);db.exec('UPDATE rebuild_schema SET version=13');db.close();expect(()=>openServiceDatabase(old)).toThrow(/offline migration/);db=new Database(old);expect(db.prepare('SELECT version FROM rebuild_schema').get()).toEqual({version:13});db.close();
});
