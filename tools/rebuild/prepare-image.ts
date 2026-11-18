import { execFileSync } from 'node:child_process';
import { existsSync,mkdirSync,mkdtempSync,renameSync,rmSync,writeFileSync } from 'node:fs';
import { dirname,isAbsolute,join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BuildSource } from '@qgroup/runtime';
export function prepareImage(input:{root:string;commit:string;output:string;purpose:'rehearsal'|'release'}){
 if(!/^[a-f0-9]{40}$/.test(input.commit))throw Error('A complete lowercase commit SHA is required');
 if(!isAbsolute(input.output)||existsSync(input.output))throw Error('A new absolute output directory is required');
 const git=(...args:string[])=>execFileSync('git',['-C',input.root,...args],{encoding:'utf8'}).trim();
 if(git('status','--porcelain','--untracked-files=normal'))throw Error('Commit or preserve local changes before preparing an image');
 if(git('rev-parse','--verify',input.commit+'^{commit}')!==input.commit)throw Error('Invalid source commit');
 if(input.purpose==='release'){
  const approved=execFileSync('python3',[join(input.root,'deploy/check_release_source.py'),'--commit',input.commit],{cwd:input.root,encoding:'utf8'}).trim();
  if(approved!==input.commit)throw Error('Release source was not approved');
 }
 const source=BuildSource.parse({version:1,commit:input.commit,tree:git('rev-parse',input.commit+'^{tree}'),source:input.purpose==='release'?'origin-main':'rehearsal'});
 mkdirSync(dirname(input.output),{recursive:true});mkdirSync(input.output,{mode:0o700});const stage=mkdtempSync(join(input.output,'.source-')),context=join(input.output,'context');
 try{
  const archive=join(stage,'source.tar');git('archive','--format=tar','--output',archive,input.commit);
  execFileSync('tar',['-xf',archive,'-C',stage]);rmSync(archive);
  if(!existsSync(join(stage,'deploy/unified.Dockerfile'))||existsSync(join(stage,'release-source.json')))throw Error('Source commit has no unified image definition or contains reserved runtime metadata');
  writeFileSync(join(stage,'release-source.json'),JSON.stringify(source)+'\n',{flag:'wx'});renameSync(stage,context);
  return {context,source,releaseEligible:false};
 }catch(error){rmSync(input.output,{recursive:true,force:true});throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  const args=process.argv.slice(2),value=(name:string)=>{const n=args.indexOf(name);if(n<0||!args[n+1]||args.filter(v=>v===name).length!==1)throw Error('Missing or duplicate '+name);return args[n+1]!;};
  if(args.length!==6||args.some((v,i)=>i%2===0&&!['--commit','--output','--purpose'].includes(v)))throw Error('Use --commit <full SHA> --output <new absolute directory> --purpose rehearsal|release');
  const purpose=value('--purpose');if(purpose!=='rehearsal'&&purpose!=='release')throw Error('Invalid source purpose');
  const root=execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).trim();
  process.stdout.write(JSON.stringify(prepareImage({root,commit:value('--commit'),output:value('--output'),purpose}))+'\n');
 }catch{process.stderr.write('Image source preparation failed; no build or deployment performed.\n');process.exitCode=1;}
}
