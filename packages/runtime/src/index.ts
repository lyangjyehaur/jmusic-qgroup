import { readFileSync,lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
const sha=z.string().regex(/^[a-f0-9]{40}$/);
export const BuildSource=z.object({version:z.literal(1),commit:sha,tree:sha,source:z.enum(['rehearsal','origin-main'])}).strict();
export type BuildSourceValue=z.infer<typeof BuildSource>;
export function readBuildSource(path:string){
 if(!isAbsolute(path))throw Error('Build source path must be absolute');
 const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2048)throw Error('Invalid build source file');
 return BuildSource.parse(JSON.parse(readFileSync(path,'utf8')));
}
/** Image metadata, never a moving branch, an environment SHA, or a health claim. */
export function runtimeInfo(service:'web'|'bot',env:NodeJS.ProcessEnv=process.env,read=readBuildSource){
 if(env.QGROUP_BUILD_INFO){const source=read(env.QGROUP_BUILD_INFO);return {service,runtime:'typescript' as const,...source};}
 if(env.NODE_ENV==='production')throw Error('Production runtime requires baked build source metadata');
 return {service,runtime:'typescript' as const,version:1 as const,source:'development' as const,commit:null,tree:null};
}
export function webRuntimeConfig(env:NodeJS.ProcessEnv){
 const production=env.NODE_ENV==='production';
 const port=env.REBUILD_PORT??(production?'8791':'5081');if(!/^[1-9][0-9]{0,4}$/.test(port)||Number(port)>65535)throw Error('Invalid web port');
 const host=env.REBUILD_HOST??'127.0.0.1';if(!['127.0.0.1','::1','0.0.0.0'].includes(host))throw Error('Invalid web bind address');
 const origin=env.REBUILD_ORIGIN??(production?'':'http://127.0.0.1:5080');let url:URL;
 try{url=new URL(origin);if(url.origin!==origin||url.username||url.password||!['https:','http:'].includes(url.protocol))throw Error();if(url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error();}catch{throw Error('Explicit HTTPS origin or isolated loopback HTTP origin required');}
 const database=env.REBUILD_DB??(production?'':'.rebuild-data/unified.sqlite3');if(!database||production&&!isAbsolute(database))throw Error('Production database path must be explicit and absolute');
 return {production,port:Number(port),host,origin,database};
}
const recent=(v:unknown,now:number,seconds:number)=>typeof v==='number'&&Number.isFinite(v)&&v>0&&now-v>=-5&&now-v<seconds;
/** Poll, gateway and ACK liveness; source version is checked independently. */
export function healthyBot(value:unknown,now=Date.now()/1000){
 if(!value||typeof value!=='object')return false;const h=value as Record<string,unknown>;
 return h.runtime_state==='running'&&h.gateway_connected===true&&h.policy_resolved===true&&recent(h.updated_at,now,120)&&recent(h.last_poll,now,120)&&(h.last_ack===null?recent(h.last_ready,now,120):recent(h.last_ack,now,240));
}
export function readBotHealth(path:string){const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)throw Error('Invalid bot health file');return JSON.parse(readFileSync(path,'utf8')) as unknown;}
