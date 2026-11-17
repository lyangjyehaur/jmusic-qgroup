import Database from 'better-sqlite3';
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isMainThread } from 'node:worker_threads';
const registry=globalThis as typeof globalThis & {[key:symbol]:unknown};
const activeOwners=(registry[Symbol.for('qgroup.bot.ownership.v1')]??=new Set<string>()) as Set<string>;
/** A separate SQLite file holds an OS lock without holding the business DB writer.
 * Never unlink this file. All participating entry points must use this protocol.
 */
export class BotOwnership {
  readonly database:string;readonly path:string;readonly #db:Database.Database;readonly #inode:bigint;readonly #device:bigint;readonly #sourceInode:bigint;readonly #sourceDevice:bigint;#closed=false;
  constructor(database:string){
    if(!isMainThread)throw Error('Bot ownership must be acquired in the main thread');
    this.database=realpathSync(database);
    const source=lstatSync(this.database,{bigint:true});if(!source.isFile()||source.nlink!==1n)throw Error('Invalid bot database file');
    this.#sourceInode=source.ino;this.#sourceDevice=source.dev;
    this.path=join(dirname(this.database),'.bot-owner.sqlite3');
    if(activeOwners.has(this.path))throw Error('Bot ownership already held in this process');
    activeOwners.add(this.path);
    let fd:number;
    try{fd=openSync(this.path,constants.O_RDWR|constants.O_CREAT|constants.O_NOFOLLOW,0o600);}catch(error){activeOwners.delete(this.path);throw error;}
    try{
      const stat=fstatSync(fd,{bigint:true});if(!stat.isFile()||stat.nlink!==1n)throw Error('Invalid bot owner file');
      fchmodSync(fd,0o600);this.#inode=stat.ino;this.#device=stat.dev;
    }catch(error){activeOwners.delete(this.path);throw error;}finally{closeSync(fd);}
    try{this.#db=new Database(this.path,{fileMustExist:true,timeout:0});}catch(error){activeOwners.delete(this.path);throw error;}
    try{this.#db.pragma('busy_timeout = 0');this.#db.pragma('journal_mode = DELETE');this.#db.exec('BEGIN EXCLUSIVE');this.assert();}
    catch{this.#db.close();activeOwners.delete(this.path);throw Error('Bot ownership unavailable; another delivery owner or unsafe lock file');}
  }
  assert(){
    if(this.#closed)throw Error('Bot ownership closed');
    const source=lstatSync(this.database,{bigint:true});
    if(!source.isFile()||source.nlink!==1n||source.ino!==this.#sourceInode||source.dev!==this.#sourceDevice)throw Error('Bot database file replaced');
    const stat=lstatSync(this.path,{bigint:true});
    if(!stat.isFile()||stat.nlink!==1n||stat.ino!==this.#inode||stat.dev!==this.#device)throw Error('Bot ownership file replaced');
  }
  close(){if(this.#closed)return;this.#closed=true;this.#db.close();activeOwners.delete(this.path);}
}
