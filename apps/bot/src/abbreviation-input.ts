import { botStrip } from '@qgroup/domain';
import { object, type APIObject } from './protocol';
import { parseBotCommand } from './commands';
const space='[\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
export const abbreviationContinuationPrefix=new RegExp('^(?:继续|繼續|下一页|下一頁)(?:'+space+'|$)');
export const abbreviationContinuation=new RegExp('^(?:继续|繼續|下一页|下一頁)(?:'+space+'+([0-9a-f]{24}))?$');
const ignored=new RegExp('<@!?[^>]*>|<qqbot-at-[^>]*>|(?:[a-z][a-z0-9+.-]*://|www\\.)[^'+space.slice(1,-1)+'<>]+|[A-Za-z0-9_.+%-]+@[A-Za-z0-9.-]+|[@＠][A-Za-z0-9_]+|[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+(?:[/?:#][^'+space.slice(1,-1)+'<>]*)?','gi');
export function extractAbbreviationArgument(texts:readonly unknown[]) {
  const terms=new Set<string>();
  for(const text of texts)if(typeof text==='string')for(const match of text.replace(ignored,' ').matchAll(/[A-Za-z0-9_]+/g)){
    if(/^[A-Za-z0-9]{2,32}$/.test(match[0])&&/[A-Za-z]/.test(match[0]))terms.add(match[0].toLowerCase());
  }
  return [...terms].join(',');
}
export function abbreviationQueryArgument(argument:string){return abbreviationContinuationPrefix.test(argument)?argument:extractAbbreviationArgument([argument]);}
export function hasBotQuote(payload:APIObject) {
  const ext=object(payload.message_scene)?payload.message_scene.ext:null;
  return payload.message_type===103||(Array.isArray(ext)&&ext.some(value=>typeof value==='string'&&value.startsWith('ref_msg_idx=')));
}
/** Only inspect the quote supplied by QQ. Never fetch message history. */
export function quotedBotTexts(payload:APIObject):string[]|null {
  if(!hasBotQuote(payload))return null;
  const elements=payload.msg_elements;if(!Array.isArray(elements))return [];
  const ext=object(payload.message_scene)?payload.message_scene.ext:null;
  const refs=new Set(Array.isArray(ext)?ext.filter((v):v is string=>typeof v==='string'&&v.startsWith('ref_msg_idx=')).map(v=>v.slice(12)):[]);
  const selected=elements.filter(e=>object(e)&&typeof e.msg_idx==='string'&&refs.has(e.msg_idx));
  if(refs.size&&!selected.length&&elements.some(e=>object(e)&&e.msg_idx))return [];
  const pending=[...(selected.length?selected:elements)].reverse(),seen=new Set<object>(),texts:string[]=[];
  while(pending.length){const element=pending.pop();if(!object(element)||seen.has(element))continue;seen.add(element);if(typeof element.content==='string')texts.push(element.content);if(Array.isArray(element.msg_elements))for(let i=element.msg_elements.length-1;i>=0;i--)pending.push(element.msg_elements[i]);}
  return texts;
}
const mention=/<@!?([A-Za-z0-9_-]+)>|<qqbot-at-user id="([A-Za-z0-9_-]+)"[^>]*>/g;
export const normalizeBotContent=(content:unknown)=>botStrip(String(content||'').replace(mention,' '));
export function groupBotCommand(payload:APIObject) {
  const content=normalizeBotContent(payload.content),[command,argument]=parseBotCommand(content.replace(/[\r\n]/g,' '));
  if(content&&command!=='缩写')return [command,argument] as const;
  if(command==='缩写'&&argument)return [command,abbreviationQueryArgument(argument)] as const;
  const texts=quotedBotTexts(payload);return texts!==null?['缩写',extractAbbreviationArgument(texts)] as const:[command,argument] as const;
}
