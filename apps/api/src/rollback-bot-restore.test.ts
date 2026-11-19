import * as fs from 'node:fs';
import {dirname,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {afterEach,expect,it} from 'vitest';
import {legacyHistoryFixture} from '../testsupport/legacy-history-fixture';
import {erasureJournal} from './erasure-journal';
import {captureRollbackMedia} from '../../../tools/migration/rollback-media';
import {projectRollbackStateFromCheckpoint} from '../../../tools/migration/rollback-state';
import {projectRollbackHistory} from '../../../tools/migration/rollback-history';
import {assembleRollbackPackage,assembleRollbackPackageV2,pinRollbackPackageSource,pinRollbackPackageSourceV2} from '../../../tools/migration/rollback-package-codec';
import {readRollbackPackage,writeRollbackPackage} from '../../../tools/migration/rollback-package';
import {captureRollbackBotState} from '../../../tools/migration/rollback-bot-state';
import {captureRollbackPackage} from '../../../tools/migration/capture-rollback-package';
import {rollbackJournalPath,type RollbackCaptureInputValue} from '../../../tools/migration/rollback-capture-boundary';
import {pinRollbackServiceEvidence,type RollbackServiceEvidenceValue} from '../../../tools/migration/rollback-service-evidence';
import {readRollbackBotRestore,writeRollbackBotRestore} from '../../../tools/migration/rollback-bot-restore';
import {digest} from '../../../tools/migration/music-codec';
import {BotOwnership} from '../../bot/src/ownership';
import type {BotAPIResult} from '../../bot/src/api';
import {classifyAPIError} from '../../bot/src/protocol';
import {AbbreviationDelivery} from '../../bot/src/abbreviation-delivery';
import {AbbreviationText} from '../../bot/src/abbreviation-text';
import {BotMaskLoader,BotWordMask} from '../../bot/src/word-mask';
import {GROUP_PUSH_BLOCK,readBotAuthorizationBlock} from '../../bot/src/group-state';

const cleanup:(()=>void)[]=[];afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
const stamp=new Date('2026-11-19T09:00:00Z'),token='a'.repeat(24),expired='b'.repeat(24),group='synthetic-group',groupHash=createHash('sha256').update(group).digest('hex'),body='已讀🙂續讀正文',revision='c'.repeat(12);
async function setup(options:{version?:1|2|3;absent?:boolean;empty?:boolean}={}){
  const s=await legacyHistoryFixture();cleanup.push(()=>s.close());const data=dirname(s.db.name),logs=join(data,'bot-logs'),results=join(data,'bot-abbreviation-results'),words=join(data,'sensitive-words.json'),packageRoot=join(s.root,'private-package'),destination=join(s.root,'restored-bot');
  function save(folder:string,name:string,text:string,time='1001000000123') {const path=join(folder,name);fs.writeFileSync(path,text,{mode:0o600});execFileSync('python3',['-I','-c','import os,sys; os.utime(sys.argv[1], ns=(int(sys.argv[2]),int(sys.argv[2])))',path,time]);}
  if(!options.absent){fs.mkdirSync(logs,{mode:0o700});fs.mkdirSync(results,{mode:0o700});if(!options.empty){
    save(logs,'bot-group-state.json','{"push_authorized":false,"code":40034105}');save(logs,'bot-group-state-'+'e'.repeat(20)+'.json','{"push_authorized":false}');save(logs,'bot-health.json','{"last_ack":1000,"runtime_state":"stopped"}');
    for(const suffix of ['','.1','.2','.3','.4'])save(logs,'bot-events.jsonl'+suffix,'{"private":"synthetic-history"}\n');save(logs,'.bot-health-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.tmp','{"incomplete":');
    save(results,token+'.json',JSON.stringify({group:groupHash,created:1000,offset:Buffer.byteLength('已讀🙂'),budget:2000,uncertain:true,body:token+'.'+revision+'.txt',section_ends:[Buffer.byteLength(body)]}));save(results,token+'.'+revision+'.txt',body);save(results,token+'.txt','inactive original body');save(results,token+'.json.'+'d'.repeat(12)+'.tmp','{"incomplete":');save(results,expired+'.json',JSON.stringify({group:groupHash,created:0,offset:0,budget:2000,uncertain:true}),'1000000001');save(results,expired+'.txt','expired body','1000000001');save(data,'sensitive-words.json','["合成屏蔽詞"]');
  }}
  const input={database:s.db.name,logDirectory:logs,sensitiveWordsFile:options.absent||options.empty?null:words},bot=captureRollbackBotState(input,stamp),native={root:join(data,'paired-backups'),manifests:[]},historyConfig={capture:s.config,native};let packageSha256:string;
  if(options.version===3){
    fs.writeFileSync(rollbackJournalPath(s.db.name),'',{mode:0o600});const owner=new BotOwnership(s.db.name);owner.close();
    const observed=(['web','bot'] as const).map((role,i)=>({Id:String(i+1).repeat(64),Image:'sha256:'+String(i+3).repeat(64),Revision:String.fromCharCode(97+i).repeat(40),Service:role,State:{Running:false,Paused:false,Restarting:false,Dead:false,Status:'exited',Pid:0,StartedAt:'original-start',FinishedAt:'original-stop'},RestartCount:0,Runtime:role==='web'?'native-api':'native-bot',EnvironmentMode:'production',NodeOptionsConfigured:false,WebDatabase:'/data/unified.sqlite3',BotDatabase:'/data/unified.sqlite3',BotLogDirectory:'/data/bot-logs',BotSensitiveWordsFile:input.sensitiveWordsFile?'/data/sensitive-words.json':'',BotEnvironmentFile:'',HistoryRoot:role==='web'?'/legacy':'',HistoryManifestSha256:role==='web'?s.config.manifestSha256:'',Mounts:[{Type:'bind',Source:data,Destination:'/data'},{Type:'bind',Source:s.capture,Destination:'/legacy'}]}) as RollbackServiceEvidenceValue);
    const capture:RollbackCaptureInputValue={database:s.db.name,expectedLineageId:(s.db.prepare('SELECT lineage_id FROM rebuild_storage WHERE id=1').get() as {lineage_id:string}).lineage_id,bot:{logDirectory:logs,sensitiveWordsFile:input.sensitiveWordsFile},history:historyConfig,destination:packageRoot,services:observed.map(row=>({role:row.Service as 'web'|'bot',runtime:'typescript',containerId:row.Id,imageId:row.Image,commit:row.Revision!,evidenceSha256:pinRollbackServiceEvidence(row)}))},raw=Buffer.from(JSON.stringify(capture)+'\n');
    packageSha256=captureRollbackPackage(raw,digest(raw),stamp,{inspect:id=>structuredClone(observed.find(row=>row.Id===id)!)}).manifestSha256;
  }else{
    const media=captureRollbackMedia(s.db,erasureJournal(s.db)),state=projectRollbackStateFromCheckpoint(media.checkpointImage,media.journal),history=projectRollbackHistory(state,historyConfig),historyPins={captureManifestSha256:s.config.manifestSha256,native:[]};
    const pkg=options.version===1?assembleRollbackPackage(state,media,history,pinRollbackPackageSource(media,historyPins)):assembleRollbackPackageV2(state,media,history,bot.state,pinRollbackPackageSourceV2(media,historyPins,bot.state));packageSha256=writeRollbackPackage(pkg,packageRoot,[s.capture,data],stamp).manifestSha256;
  }
  const restore=(guard?:()=>void)=>writeRollbackBotRestore(packageRoot,packageSha256,destination,stamp,guard);
  return {...s,data,logs,results,words,bot,packageRoot,packageSha256,destination,restore};
}
it.each([2,3] as const)('restores version %i latest bot bytes, all original nanosecond times and inactive evidence without renewing cursors or changing package/DB',async version=>{
  const s=await setup({version}),before=s.db.serialize(),source=readRollbackPackage(s.packageRoot,s.packageSha256),saved=s.restore(),read=readRollbackBotRestore(s.destination,saved.manifestSha256);expect(saved.status).toBe('restored_private_bot_evidence');expect(saved.rollbackEligible).toBe(false);expect(read.state).toEqual(s.bot.state);expect(read.manifest.sourcePackageSha256).toBe(s.packageSha256);expect(read.manifest.sourceBotStateSha256).toBe(s.bot.pin);expect(read.manifest.files).toHaveLength(16);
  for(const file of read.manifest.files){const path=join(s.destination,file.path);expect(fs.lstatSync(path,{bigint:true}).mtimeNs.toString()).toBe(file.mtimeNs);expect(fs.statSync(path).mode&0o7777).toBe(0o600);expect(fs.readFileSync(path)).toEqual(s.bot.state.files.find(row=>row.path===file.sourcePath)!.bytes);}
  expect(fs.statSync(s.destination).mode&0o7777).toBe(0o700);expect(fs.existsSync(join(s.destination,'.bot-owner.sqlite3'))).toBe(false);expect(fs.existsSync(join(s.destination,'unified.sqlite3'))).toBe(false);expect(fs.existsSync(join(s.destination,'incomplete.json'))).toBe(false);expect(fs.readFileSync(join(s.destination,'bot-abbreviation-results',token+'.json'),'utf8')).toContain('"uncertain":true');read.assertUnchanged();source.assertUnchanged();s.bot.assertUnchanged();expect(s.db.serialize()).toEqual(before);
});
it.each(['absent','empty'])('keeps %s directory and unconfigured word-list semantics',async shape=>{const s=await setup({absent:shape==='absent',empty:shape==='empty'}),saved=s.restore(),read=readRollbackBotRestore(s.destination,saved.manifestSha256);expect(read.manifest.files).toEqual([]);expect(read.state.directories.every(row=>row.exists)).toBe(shape==='empty');expect(fs.existsSync(join(s.destination,'bot-logs'))).toBe(shape==='empty');expect(fs.existsSync(join(s.destination,'bot-abbreviation-results'))).toBe(shape==='empty');expect(fs.existsSync(join(s.destination,'sensitive-words.json'))).toBe(false);});
it('actual TS and Python continuation readers retain group/expiry rules, original uncertainty and current authorization denial',async()=>{
  const s=await setup(),saved=s.restore(),read=readRollbackBotRestore(s.destination,saved.manifestSha256),results=join(s.destination,'bot-abbreviation-results'),logs=join(s.destination,'bot-logs'),delivery=new AbbreviationDelivery(results,{clock:()=>2000,loadMask:()=>new BotWordMask([])}),before=fs.readFileSync(join(results,token+'.json'));
  expect(String((await delivery.continuation(group,'繼續 '+token))?.text)).toBe('續讀正文');expect((await delivery.continuation('different-group','繼續 '+token))?.token).toBeUndefined();expect((await new AbbreviationDelivery(results,{clock:()=>4601,loadMask:()=>new BotWordMask([])}).continuation(group,'繼續 '+token))?.token).toBeUndefined();expect(fs.readFileSync(join(results,token+'.json'))).toEqual(before);expect(readBotAuthorizationBlock(logs,group,group)).toBe(GROUP_PUSH_BLOCK);
  const result=execFileSync('python3',['-c',`import json,sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from qgroup_bot.abbreviation_delivery import AbbreviationDelivery
from qgroup_bot.worker import OutboxWorker
root,logs,group,token=sys.argv[1:]
delivery=AbbreviationDelivery(root)
with patch('qgroup_bot.abbreviation_delivery.time.time',return_value=2000):
 page=delivery.continuation(group,'繼續 '+token); assert page.token==token and str(page.text)=='續讀正文'
 assert delivery.continuation('different-group','繼續 '+token).token==''
with patch('qgroup_bot.abbreviation_delivery.time.time',return_value=4601):assert delivery.continuation(group,'繼續 '+token).token==''
worker=OutboxWorker.__new__(OutboxWorker);worker.config=SimpleNamespace(log_dir=Path(logs),group=group,db='/unused')
assert worker._read_authorization_block(group) is not None
print(json.dumps({'continuation':True,'expiry':True,'authorizationBlocked':True}))
`,results,logs,group,token],{encoding:'utf8'});expect(JSON.parse(result)).toEqual({continuation:true,expiry:true,authorizationBlocked:true});read.assertUnchanged();s.bot.assertUnchanged();
});
it.each(['typescript','python'])('actual %s cleanup removes originally expired results after restore rather than extending their TTL',async runtime=>{
  const s=await setup(),saved=s.restore(),results=join(s.destination,'bot-abbreviation-results');expect(fs.existsSync(join(results,token+'.json'))).toBe(true);
  if(runtime==='python')execFileSync('python3',['-c',`import sys
from unittest.mock import patch
from qgroup_bot.abbreviation_delivery import AbbreviationDelivery
with patch('qgroup_bot.abbreviation_delivery.time.time',return_value=5000):AbbreviationDelivery(sys.argv[1])._cleanup()
`,results]);
  else{const delivery=new AbbreviationDelivery(results,{clock:()=>5000,loadMask:()=>new BotWordMask([])}),replyGroup=async():Promise<BotAPIResult>=>({ok:false,code:999,data:{},status:400,kind:classifyAPIError(999,400,{}),platformTrace:null});await delivery.send({replyGroup},group,{text:new AbbreviationText(['new synthetic result'])});}
  expect(fs.existsSync(join(results,token+'.json'))).toBe(false);expect(fs.existsSync(join(results,expired+'.json'))).toBe(false);expect(()=>readRollbackBotRestore(s.destination,saved.manifestSha256)).toThrow();s.bot.assertUnchanged();readRollbackPackage(s.packageRoot,s.packageSha256).assertUnchanged();
});
it('actual TS and Python loaders use the restored explicit custom dictionary without changing its original bytes or time',async()=>{const s=await setup(),saved=s.restore(),path=join(s.destination,'sensitive-words.json'),reader=readRollbackBotRestore(s.destination,saved.manifestSha256);expect(new BotMaskLoader({extraFile:path}).load().mask('前合成屏蔽詞後')).toBe('前[已遮蔽]後');const result=execFileSync('python3',['-c',`import os,sys
from unittest.mock import patch
from qgroup_bot.sensitive_words import load_mask
with patch.dict(os.environ,{'KANBAN_BOT_SENSITIVE_WORDS_FILE':sys.argv[1]}):assert load_mask().mask('前合成屏蔽詞後')=='前[已遮蔽]後'
print('masked')
`,path],{encoding:'utf8'});expect(result.trim()).toBe('masked');reader.assertUnchanged();s.bot.assertUnchanged();});
it.each(['version1','wrong pin','existing directory','existing file','symlink destination','source descendant','original data descendant','relative path','async guard'])('rejects %s without overwriting sources or creating a complete restore',async change=>{
  const s=await setup({version:change==='version1'?1:2}),before=s.db.serialize();let destination=s.destination,pin=s.packageSha256;
  if(change==='wrong pin')pin='0'.repeat(64);if(change==='existing directory'){fs.mkdirSync(destination,{mode:0o700});fs.writeFileSync(join(destination,'keep'),'other owner');}if(change==='existing file')fs.writeFileSync(destination,'other owner');if(change==='symlink destination')fs.symlinkSync(s.packageRoot,destination);if(change==='source descendant')destination=join(s.packageRoot,'bot-restore');if(change==='original data descendant')destination=join(s.data,'bot-restore');if(change==='relative path')destination='relative';
  expect(()=>writeRollbackBotRestore(s.packageRoot,pin,destination,stamp,change==='async guard'?async()=>{}:undefined)).toThrow();if(!['existing directory','existing file','symlink destination'].includes(change))expect(fs.existsSync(destination)).toBe(false);if(change==='existing directory')expect(fs.readFileSync(join(destination,'keep'),'utf8')).toBe('other owner');if(change==='existing file')expect(fs.readFileSync(destination,'utf8')).toBe('other owner');s.bot.assertUnchanged();expect(s.db.serialize()).toEqual(before);
});
it.each([1,2,3])('invalidates changed source evidence at restore guard %i, preserving incomplete output after reservation',async stage=>{
  const s=await setup();let calls=0;expect(()=>s.restore(()=>{if(++calls===stage)fs.appendFileSync(join(s.packageRoot,'private/latest/bot/logs/bot-health.json'),' ');})).toThrow();expect(calls).toBe(stage);if(stage===1)expect(fs.existsSync(s.destination)).toBe(false);else{expect(fs.existsSync(join(s.destination,'incomplete.json'))).toBe(true);expect(()=>readRollbackBotRestore(s.destination,'0'.repeat(64))).toThrow();}s.bot.assertUnchanged();
});
it('invalidates an output file changed by the final guard after the independent reader was created',async()=>{const s=await setup();let calls=0;expect(()=>s.restore(()=>{if(++calls===3)fs.utimesSync(join(s.destination,'bot-abbreviation-results',token+'.json'),2000,2000);})).toThrow();expect(fs.existsSync(join(s.destination,'incomplete.json'))).toBe(true);const path=join(s.destination,'bot-restore-manifest.json');expect(fs.existsSync(path)).toBe(true);expect(()=>readRollbackBotRestore(s.destination,digest(fs.readFileSync(path)))).toThrow();s.bot.assertUnchanged();});
it('retains an incomplete private output when the original timestamp helper fails, without changing source files',async()=>{const s=await setup(),bin=join(s.root,'failing-python');fs.mkdirSync(bin,{mode:0o700});fs.writeFileSync(join(bin,'python3'),'#!/bin/sh\nexit 1\n',{mode:0o700});const previous=process.env.PATH;try{process.env.PATH=bin+':'+previous;expect(()=>s.restore()).toThrow();}finally{process.env.PATH=previous;}expect(fs.existsSync(join(s.destination,'incomplete.json'))).toBe(true);expect(fs.existsSync(join(s.destination,'bot-restore-manifest.json'))).toBe(false);s.bot.assertUnchanged();readRollbackPackage(s.packageRoot,s.packageSha256).assertUnchanged();});
it.each(['wrong inode','symlink','hardlink'])('timestamp helper rejects %s before changing the named private file',async change=>{const s=await setup(),before=fs.lstatSync(s.words,{bigint:true}),path=join(s.root,'helper-target');if(change==='symlink')fs.symlinkSync(s.words,path);else if(change==='hardlink')fs.linkSync(s.words,path);const target=change==='wrong inode'?s.words:path;expect(()=>execFileSync('python3',['-I','tools/migration/restore-bot-file-times.py',target,before.dev.toString(),change==='wrong inode'?'0':before.ino.toString(),'2000000000000'],{stdio:['ignore','pipe','pipe']})).toThrow();expect(fs.lstatSync(s.words,{bigint:true}).mtimeNs).toBe(before.mtimeNs);expect(fs.readFileSync(s.words,'utf8')).toBe('["合成屏蔽詞"]');});
it.each(['root','parent','subdirectory'])('fences replaced restore %s at a late guard and leaves replacement bytes untouched',async change=>{
  const s=await setup();let calls=0;const originalParent=join(s.root,'restore-parent');fs.mkdirSync(originalParent,{mode:0o700});const destination=join(originalParent,'bot');
  expect(()=>writeRollbackBotRestore(s.packageRoot,s.packageSha256,destination,stamp,()=>{if(++calls!==3)return;if(change==='root'){fs.renameSync(destination,destination+'-saved');fs.mkdirSync(destination,{mode:0o700});fs.writeFileSync(join(destination,'keep'),'other');}else if(change==='parent'){fs.renameSync(originalParent,originalParent+'-saved');fs.mkdirSync(originalParent,{mode:0o700});fs.mkdirSync(destination,{mode:0o700});fs.writeFileSync(join(destination,'keep'),'other');}else{const logs=join(destination,'bot-logs');fs.renameSync(logs,logs+'-saved');fs.mkdirSync(logs,{mode:0o700});fs.writeFileSync(join(logs,'keep'),'other');}})).toThrow();
  if(change==='subdirectory'){expect(fs.readFileSync(join(destination,'bot-logs/keep'),'utf8')).toBe('other');expect(fs.existsSync(join(destination,'incomplete.json'))).toBe(true);}else expect(fs.readdirSync(destination)).toEqual(['keep']);s.bot.assertUnchanged();
});
it.each(['mtime','bytes','missing file','extra file','extra directory','public file','hardlink','symlink','replaced file','manifest pin','manifest mutation'])('independently rejects %s restore changes',async change=>{
  const s=await setup(),saved=s.restore(),read=readRollbackBotRestore(s.destination,saved.manifestSha256),file=join(s.destination,'bot-abbreviation-results',token+'.json');let pin=saved.manifestSha256;
  if(change==='mtime')fs.utimesSync(file,2000,2000);if(change==='bytes')fs.appendFileSync(file,' ');if(change==='missing file')fs.rmSync(file);if(change==='extra file')fs.writeFileSync(join(s.destination,'bot-logs/extra'),'extra',{mode:0o600});if(change==='extra directory')fs.mkdirSync(join(s.destination,'extra'),{mode:0o700});if(change==='public file')fs.chmodSync(file,0o644);if(change==='hardlink')fs.linkSync(file,join(s.root,'extra-link'));if(change==='symlink'){fs.rmSync(file);fs.symlinkSync(s.words,file);}if(change==='replaced file'){fs.renameSync(file,file+'-saved');fs.copyFileSync(file+'-saved',file);}if(change==='manifest pin')pin='0'.repeat(64);if(change==='manifest mutation')read.manifest.createdAt='2026-11-20T00:00:00Z';
  if(change==='manifest mutation')expect(()=>read.assertUnchanged()).toThrow();else expect(()=>readRollbackBotRestore(s.destination,pin)).toThrow();s.bot.assertUnchanged();
});
it.each(['time renewal','path traversal','duplicate file','lost file','eligible claim','source pin'])('rejects rehashed %s manifest metadata before accepting private evidence',async change=>{
  const s=await setup();s.restore();const path=join(s.destination,'bot-restore-manifest.json'),manifest=JSON.parse(fs.readFileSync(path,'utf8'));
  if(change==='time renewal')manifest.sourceIndex.files[0].mtimeNs='2000000000000';if(change==='path traversal')manifest.sourceIndex.files[0].path='logs/../../sensitive-words.json';if(change==='duplicate file')manifest.sourceIndex.files.push(manifest.sourceIndex.files[0]);if(change==='lost file')manifest.files.pop();if(change==='eligible claim')manifest.rollbackEligible=true;if(change==='source pin')manifest.sourceBotStateSha256='0'.repeat(64);
  const raw=Buffer.from(JSON.stringify(manifest)+'\n');fs.writeFileSync(path,raw);expect(()=>readRollbackBotRestore(s.destination,digest(raw))).toThrow();s.bot.assertUnchanged();
});
it('runs the redacted restore CLI with fixed source pin and retains a verifiable private result',async()=>{const s=await setup(),output=execFileSync(process.execPath,['--import','tsx','tools/migration/rollback-bot-restore.ts',s.packageRoot,s.packageSha256,s.destination],{encoding:'utf8'}),result=JSON.parse(output);expect(result).toMatchObject({status:'restored_private_bot_evidence',rollbackEligible:false});expect(output).not.toMatch(/\/tmp|\/Users|uncertain|push_authorized|合成|markIncomplete/);readRollbackBotRestore(s.destination,result.manifestSha256).assertUnchanged();const verified=execFileSync(process.execPath,['--import','tsx','tools/migration/read-rollback-bot-restore.ts',s.destination,result.manifestSha256],{encoding:'utf8'});expect(JSON.parse(verified)).toMatchObject({status:'verified_private_bot_restore',sourcePackageSha256:s.packageSha256,rollbackEligible:false});expect(verified).not.toMatch(/private-claim|uncertain|push_authorized|合成|\/tmp|\/Users/);try{execFileSync(process.execPath,['--import','tsx','tools/migration/rollback-bot-restore.ts',s.packageRoot,'0'.repeat(64),join(s.root,'rejected')],{encoding:'utf8',stdio:['ignore','pipe','pipe']});throw Error('Expected rejection');}catch(error){expect(error).toHaveProperty('status',1);expect(String((error as {stderr?:string}).stderr)).not.toContain(s.root);expect(String((error as {stderr?:string}).stderr)).toContain('Bot restore rejected');}});
