import { it,expect } from 'vitest';
import { mkdtempSync,rmSync,symlinkSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRuntimeManifest,readRuntimeEvidence } from '../../../tools/rebuild/check-runtime-manifest';
import { runtimeComposeService } from './runtime-compose.fixture';

function fixture(){
 const source=(character:string)=>({version:1 as const,commit:character.repeat(40),tree:character.repeat(40),source:'rehearsal' as 'rehearsal'|'origin-main'});
 const web=runtimeComposeService('web'),bot=runtimeComposeService('bot'),webSource=source('1'),botSource=source('2');
 const spec=(image:string,commit:string)=>({Id:image,RepoDigests:[] as string[],Os:'linux',Architecture:'amd64',Config:{Labels:{'org.opencontainers.image.revision':commit}}});
 return {manifest:{version:1,purpose:'rehearsal',platform:'linux/amd64',origin:'https://qgroup.example',erasureAuthorityManifestSha256:'c'.repeat(64),
  services:{web:{image:web.image,source:webSource},bot:{image:bot.image,source:botSource}}},
  compose:{services:{web,bot}},images:{web:[spec(web.image,webSource.commit)],bot:[spec(bot.image,botSource.commit)]},
  versions:{web:{...webSource,service:'web',runtime:'typescript'},bot:{...botSource,service:'bot',runtime:'typescript'}}};
}
it('verifies independently pinned services without claiming deployment or compatibility',()=>{
 const r=checkRuntimeManifest(fixture());expect(r.services.web.source.commit).not.toBe(r.services.bot.source.commit);
 expect(r.identityVerified).toBe(true);expect(r.deploymentPerformed).toBe(false);expect(r.functionalCompatibilityVerified).toBe(false);
 expect(r.sourceAuthorizationVerified).toBe(false);expect(r.releaseEligible).toBe(false);
});
it('resolves registry digests to inspected local IDs and permits one image for both services',()=>{
 const x=fixture(),ref='registry.example/qgroup@sha256:'+'d'.repeat(64);
 x.manifest.services.bot.source={...x.manifest.services.web.source};x.versions.bot={...x.versions.web,service:'bot'};
 x.images.bot=structuredClone(x.images.web);
 for(const name of ['web','bot'] as const){x.manifest.services[name].image=ref;x.compose.services[name].image=ref;x.images[name][0]!.RepoDigests=[ref];}
 const r=checkRuntimeManifest(x);expect(r.services.web.image).toBe(ref);expect(r.services.web.imageId).toBe(r.services.bot.imageId);
});
it('checks origin-main metadata for release intent while leaving release authorization false',()=>{
 const x=fixture();x.manifest.purpose='release';
 for(const name of ['web','bot'] as const){x.manifest.services[name].source.source='origin-main';x.versions[name].source='origin-main';}
 const r=checkRuntimeManifest(x);expect(r.sourceAuthorizationVerified).toBe(false);expect(r.releaseEligible).toBe(false);
});
it.each(['compose reference','image ID','unresolved digest','revision label','missing label','platform','service name','swapped services','runtime','development source','stale commit','stale tree','release intent','rehearsal intent','same commit different tree','same image different source','manifest origin','authority pin','extra service','extra manifest field','multiple image results','unsupported platform'])('rejects mismatched version evidence: %s',change=>{
 const x=fixture();
 if(change==='compose reference')x.compose.services.bot.image=x.compose.services.web.image;
 if(change==='image ID')x.images.bot[0]!.Id=x.images.web[0]!.Id;
 if(change==='unresolved digest'){const ref='registry.example/qgroup@sha256:'+'d'.repeat(64);x.manifest.services.bot.image=ref;x.compose.services.bot.image=ref;}
 if(change==='revision label')x.images.bot[0]!.Config.Labels['org.opencontainers.image.revision']='3'.repeat(40);
 if(change==='missing label')Reflect.deleteProperty(x.images.bot[0]!.Config.Labels,'org.opencontainers.image.revision');
 if(change==='platform')x.images.bot[0]!.Architecture='arm64';
 if(change==='service name')x.versions.bot.service='web';
 if(change==='swapped services'){const v=x.versions.bot;x.versions.bot=x.versions.web;x.versions.web=v;}
 if(change==='runtime')x.versions.bot.runtime='python';
 if(change==='development source')Reflect.set(x.versions.bot,'source','development');
 if(change==='stale commit')x.versions.bot.commit='3'.repeat(40);
 if(change==='stale tree')x.versions.bot.tree='3'.repeat(40);
 if(change==='release intent')x.manifest.purpose='release';
 if(change==='rehearsal intent'){x.manifest.services.bot.source.source='origin-main';x.versions.bot.source='origin-main';}
 if(change==='same commit different tree'){x.manifest.services.bot.source.commit=x.manifest.services.web.source.commit;x.versions.bot.commit=x.versions.web.commit;x.images.bot[0]!.Config.Labels['org.opencontainers.image.revision']=x.versions.web.commit;}
 if(change==='same image different source'){x.manifest.services.bot.image=x.manifest.services.web.image;x.compose.services.bot.image=x.compose.services.web.image;x.images.bot[0]!.Id=x.images.web[0]!.Id;}
 if(change==='manifest origin')x.manifest.origin='https://other.example';
 if(change==='authority pin')x.manifest.erasureAuthorityManifestSha256='d'.repeat(64);
 if(change==='extra service')Reflect.set(x.manifest.services,'extra',x.manifest.services.web);
 if(change==='extra manifest field')Reflect.set(x.manifest,'releaseEligible',true);
 if(change==='multiple image results')x.images.bot.push(x.images.bot[0]!);
 if(change==='unsupported platform')x.manifest.platform='linux/riscv64';
 expect(()=>checkRuntimeManifest(x)).toThrow();
});
it('reads bounded regular evidence files and rejects symlinks, directories and oversized inputs',()=>{
 const dir=mkdtempSync(join(tmpdir(),'qgroup-runtime-manifest-'));
 try{
  const file=join(dir,'evidence.json');writeFileSync(file,JSON.stringify(fixture()));expect(checkRuntimeManifest(readRuntimeEvidence(file)).identityVerified).toBe(true);
  const link=join(dir,'link');symlinkSync(file,link);expect(()=>readRuntimeEvidence(link)).toThrow();
  expect(()=>readRuntimeEvidence(dir)).toThrow();expect(()=>readRuntimeEvidence('relative.json')).toThrow();
  writeFileSync(file,Buffer.alloc(8*1024*1024+1));expect(()=>readRuntimeEvidence(file)).toThrow();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
