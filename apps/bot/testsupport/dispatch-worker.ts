import { workerData } from 'node:worker_threads';
import { ABBREVIATION_API } from '../src/abbreviations';
import '../src/dispatch-task';
/** Synthetic upstream + deterministic heavy CPU in this isolate only. */
if('appSecret' in workerData.config||Object.keys(process.env).some(key=>key.startsWith('QQBOT_')||key.startsWith('KANBAN_')))throw Error('Credentials/environment leaked into business worker');
const nativeFetch=globalThis.fetch;
globalThis.fetch=async(input,options)=>{
  if(String(input)!==ABBREVIATION_API)throw Error('External network prohibited in dispatch fixture');
  const base=(workerData as {config:{baseURL:string}}).config.baseURL;
  const response=await nativeFetch(new URL('/lookup',base),options);
  await nativeFetch(new URL('/cpu-start',base));
  const until=performance.now()+1000;while(performance.now()<until){/* Simulate CPU-heavy JSON/mask processing. */}
  await nativeFetch(new URL('/cpu-end',base));return response;
};
