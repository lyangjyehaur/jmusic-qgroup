import {readFileSync,realpathSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import type {FastifyInstance} from 'fastify';
import staticFiles from '@fastify/static';
import {displayLanguage} from '@qgroup/contracts';
import {staticCacheControl} from './static-cache';

/** Mount the parent, then resolve current once per response. Neither the shell
 * nor the route table is frozen at process startup. */
export async function registerFrontendRelease(app:FastifyInstance,root:string,apiCommit:string){
  const base=realpathSync(resolve(root)),releases=join(base,'releases')+sep;
  let cached:{directory:string;manifest:{version:1;commit:string;tree:string;apiCommit:string;buildId:string};shell:string}|undefined;
  function current(){
    const directory=realpathSync(join(base,'current'));
    if(!directory.startsWith(releases)||directory.slice(releases.length).includes(sep))throw Error('Invalid frontend release target');
    if(cached?.directory===directory)return cached;
    const manifest=JSON.parse(readFileSync(join(directory,'frontend-release.json'),'utf8'));
    if(manifest.version!==1||manifest.source!=='origin-main'||manifest.apiCommit!==apiCommit||!['commit','tree','apiCommit'].every(key=>/^[a-f0-9]{40}$/.test(manifest[key]))||!/^[a-f0-9]{64}$/.test(manifest.buildId))throw Error('Frontend release does not match this API');
    const shell=readFileSync(join(directory,'index.html'),'utf8');
    if(!shell.includes(`name="qgroup-build" content="${manifest.buildId}"`))throw Error('Frontend shell version differs');
    cached={directory,manifest,shell};return cached;
  }
  current();
  await app.register(staticFiles,{root:base,serve:false,preCompressed:true,cacheControl:false,etag:true,dotfiles:'deny',setHeaders(response,path){response.header('Cache-Control',staticCacheControl(base,path));}});
  const missing=(reply:import('fastify').FastifyReply)=>reply.code(404).send({code:'NOT_FOUND',message:'找不到此入口'});
  app.get('/assets/*',{config:{rateLimit:false}},(request,reply)=>{
    const name=(request.params as {'*':string})['*'];
    if(!/^[A-Za-z0-9_][A-Za-z0-9_.-]*-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(name)||/\.(?:br|gz|deflate)$/.test(name))return missing(reply);
    return reply.sendFile('assets/'+name);
  });
  for(const path of ['sw.js','music/sw.js','manifest.webmanifest','music/manifest.json','icon.svg','icon-192.png','icon-512.png']){
    app.get('/'+path,{config:{rateLimit:false}},(_request,reply)=>reply.sendFile(path,current().directory));
  }
  app.get('/frontend-version.json',{config:{rateLimit:false}},(_request,reply)=>{
    const {version,commit,tree,apiCommit,buildId}=current().manifest;
    return reply.header('Cache-Control','no-store').send({version,commit,tree,apiCommit,buildId});
  });
  const shell=(request:import('fastify').FastifyRequest,reply:import('fastify').FastifyReply)=>{
    const language=displayLanguage(request.headers['accept-language']);
    return reply.header('Content-Language',language).header('Vary','Accept-Language').header('Cache-Control','no-store').type('text/html').send(current().shell.replace(/<html lang="[^"]*"/,`<html lang="${language}"`));
  };
  app.get('/',shell);app.get('/index.html',shell);
  app.setNotFoundHandler((request,reply)=>{
    const path=request.url.split('?')[0]!;
    if(!['GET','HEAD'].includes(request.method)||(/^\/(?:api|auth)(?:\/|$)/.test(path)&&path!=='/auth/confirm')||/^\/music\/api(?:\/|$)/.test(path)||(path.includes('.')&&!['/music/index.html','/music/admin.html','/privacy.html','/music/privacy.html','/contact.html','/guide.html'].includes(path)))return missing(reply);
    return shell(request,reply);
  });
}
