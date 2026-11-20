// Only fresh private volumes; imports resolve to the built image database.
export const syntheticImageFixture=String.raw`
import fs from 'node:fs';import path from 'node:path';import Database from 'better-sqlite3';import {createHash,randomBytes} from 'node:crypto';import {openDatabase} from './.rebuild-dist/api/database.mjs';
const [database,authority,checkpoint,accounts]=process.argv.slice(1),roots=[path.dirname(database),authority,checkpoint],digest=b=>createHash('sha256').update(b).digest('hex');
if(roots.length!==3||roots.some(p=>!path.isAbsolute(p)||path.resolve(p)!==p)||new Set(roots).size!==3)throw Error('Explicit synthetic fixture roots required');
for(const [i,p] of roots.entries()){const stat=fs.lstatSync(p);if(!stat.isDirectory()||fs.realpathSync(p)!==p||stat.uid!==process.getuid()||(stat.mode&0o7777)!==0o700||fs.readdirSync(p).length)throw Error('Synthetic fixture root must already be private and empty');for(const other of roots.slice(i+1))if(p.startsWith(other+'/')||other.startsWith(p+'/'))throw Error('Fixture roots overlap');}
if(accounts!==undefined&&accounts!=='retained-python')throw Error('Unknown synthetic account fixture');
const checkpointPath=path.join(checkpoint,'unified.sqlite3'),db=openDatabase(database);try{
if(accounts==='retained-python')for(const id of ['alice','bob']){const token=digest('synthetic-retained-'+id),stamp=new Date().toISOString();db.prepare('INSERT INTO users(id,token_hash,nickname,created_at) VALUES(?,?,?,?)').run(id,token,id,stamp);db.prepare('INSERT INTO browser_sessions VALUES(?,?,?)').run(token,id,stamp);}
await db.backup(checkpointPath);}finally{db.close();}const fixed=new Database(checkpointPath);try{fixed.pragma('journal_mode = DELETE');}finally{fixed.close();}fs.chmodSync(checkpointPath,0o600);const bytes=fs.readFileSync(checkpointPath),write=(p,b)=>fs.writeFileSync(p,b,{flag:'wx',mode:0o600}),encode=v=>Buffer.from(JSON.stringify(v)+'\n');
write(database.replace(/\.[^/.]+$/,'')+'.erasures.jsonl','');fs.mkdirSync(path.join(authority,'baseline'),{mode:0o700});fs.mkdirSync(path.join(authority,'records'),{mode:0o700});
const domains=['board','music','unified'],baseline=domains.map(domain=>({domain,path:'baseline/'+domain+'.erasures.jsonl',size:0,sha256:digest('')}));
for(const row of baseline)write(path.join(authority,row.path),'');write(path.join(authority,'.authority.lock'),'');
const manifest={version:1,kind:'qgroup-private-erasure-authority',authorityId:randomBytes(16).toString('hex'),createdAt:new Date().toISOString(),sourcePackageSha256:digest('synthetic-empty-image-fixture'),checkpointSha256:digest(bytes),journalSha256:digest('[]'),baseline,rollbackEligible:false},raw=encode(manifest),pin=digest(raw);
write(path.join(authority,'authority-manifest.json'),raw);write(path.join(authority,'authority-head.json'),encode({version:1,authoritySha256:pin,sequence:0,recordSha256:null,ledgers:Object.fromEntries(baseline.map(row=>[row.domain,{size:row.size,sha256:row.sha256}]))}));
console.log(JSON.stringify({manifestSha256:pin,checkpointSha256:manifest.checkpointSha256,uid:process.getuid(),gid:process.getgid(),synthetic:true}));
`;
