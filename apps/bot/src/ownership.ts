import Database from 'better-sqlite3';
import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isMainThread } from 'node:worker_threads';
const registry=globalThis as typeof globalThis & {[key:symbol]:unknown};
const activeOwners=(registry[Symbol.for('qgroup.bot.ownership.v1')]??=new Set<string>()) as Set<string>;
const activeInodes=(registry[Symbol.for('qgroup.bot.ownership.inodes.v1')]??=new Set<string>()) as Set<string>;
const inodeKey=(stat:{dev:bigint;ino:bigint})=>String(stat.dev)+':'+String(stat.ino);
function ownerStat(path:string){try{return lstatSync(path,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}}
/** A separate SQLite file holds an OS lock without holding the business DB writer.
 * Never unlink this file. All participating entry points must use this protocol.
 */
export class BotOwnership {
  readonly database:string;readonly path:string;readonly #db:Database.Database;readonly #inode:bigint;readonly #device:bigint;readonly #sourceInode:bigint;readonly #sourceDevice:bigint;#closed=false;readonly #reserved:string[]=[];
  constructor(database:string){
    if(!isMainThread)throw Error('Bot ownership must be acquired in the main thread');
    this.database=realpathSync(database);
    const source=lstatSync(this.database,{bigint:true});if(!source.isFile()||source.nlink!==1n)throw Error('Invalid bot database file');
    this.#sourceInode=source.ino;this.#sourceDevice=source.dev;
    this.path=join(dirname(this.database),'.bot-owner.sqlite3');
    if(activeOwners.has(this.path)||activeInodes.has(inodeKey(source)))throw Error('Bot ownership already held in this process');
    activeOwners.add(this.path);
    activeInodes.add(inodeKey(source));this.#reserved.push(inodeKey(source));
    try{
      let stat=ownerStat(this.path);
      if(!stat){
        // Only a newly created inode may use a raw FD. Closing an extra FD on
        // an existing SQLite/owner inode can drop this process's POSIX locks.
        try{const fd=openSync(this.path,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{stat=fstatSync(fd,{bigint:true});}finally{closeSync(fd);}}
        catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;stat=ownerStat(this.path);}
      }
      if(!stat?.isFile()||stat.nlink!==1n||(stat.mode&0o7777n)!==0o600n||activeInodes.has(inodeKey(stat)))throw Error('Invalid bot owner file');
      for(const suffix of ['-journal','-wal','-shm']){
        const sidecar=ownerStat(this.path+suffix);
        if(sidecar&&(!sidecar.isFile()||sidecar.nlink!==1n||activeInodes.has(inodeKey(sidecar))))throw Error('Invalid bot owner sidecar');
      }
      activeInodes.add(inodeKey(stat));this.#reserved.push(inodeKey(stat));this.#inode=stat.ino;this.#device=stat.dev;
      this.#db=new Database(this.path,{fileMustExist:true,timeout:0});
    }catch(error){activeOwners.delete(this.path);for(const key of this.#reserved)activeInodes.delete(key);throw error;}
    try{this.#db.pragma('busy_timeout = 0');this.#db.pragma('journal_mode = DELETE');this.#db.exec('BEGIN EXCLUSIVE');this.assert();}
    catch{this.#db.close();activeOwners.delete(this.path);for(const key of this.#reserved)activeInodes.delete(key);throw Error('Bot ownership unavailable; another delivery owner or unsafe lock file');}
  }
  assert(){
    if(this.#closed)throw Error('Bot ownership closed');
    const source=lstatSync(this.database,{bigint:true});
    if(!source.isFile()||source.nlink!==1n||source.ino!==this.#sourceInode||source.dev!==this.#sourceDevice)throw Error('Bot database file replaced');
    const stat=lstatSync(this.path,{bigint:true});
    if(!stat.isFile()||stat.nlink!==1n||stat.ino!==this.#inode||stat.dev!==this.#device)throw Error('Bot ownership file replaced');
  }
  close(){if(this.#closed)return;this.#closed=true;this.#db.close();activeOwners.delete(this.path);for(const key of this.#reserved)activeInodes.delete(key);}
}
