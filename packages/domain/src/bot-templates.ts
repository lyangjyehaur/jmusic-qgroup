import { withDomainError } from './error-display';
import { DomainError } from './index';
import { BOT_MAX_CHARS, botLength, botPlainText, botStrip } from './bot-markdown';

export const BOT_TEMPLATE_LIMITS={heading:120,details:2500,url:512,title:40,starts_at:32,previous_starts_at:32,deadline:32,location:120,confirmed:20,waiting:20,fee_policy:120,description:120,version:20,change_summary:120,cancellation_reason:120} as const;
export const BOT_DEFAULT_TEMPLATE='{heading}\n{details}\n\n{url}';
type Part={literal:string}|{field:keyof typeof BOT_TEMPLATE_LIMITS};
const invalid=()=>withDomainError(new DomainError('INVALID_BOT_TEMPLATE','模板只能使用列出的变量，并须保留 {url}；不支持格式表达式',400));
/** Python Formatter's allowed subset, including literal {{ / }} and empty : spec. */
function parse(value:string):Part[]{
  const parts:Part[]=[];let literal='';
  for(let i=0;i<value.length;){
    const char=value[i]!;
    if(char!=='{'&&char!=='}'){literal+=char;i++;continue;}
    if(value[i+1]===char){literal+=char;i+=2;continue;}
    if(char==='}')throw invalid();
    if(literal){parts.push({literal});literal='';}
    const close=value.indexOf('}',i+1);if(close<0)throw invalid();
    const body=value.slice(i+1,close);const field=body.endsWith(':')?body.slice(0,-1):body;
    if(!Object.hasOwn(BOT_TEMPLATE_LIMITS,field))throw invalid();
    parts.push({field:field as keyof typeof BOT_TEMPLATE_LIMITS});i=close+1;
  }
  if(literal)parts.push({literal});return parts;
}
export function validateBotTemplate(value:unknown):string {
  if(typeof value!=='string'||!botStrip(value)||botLength(value)>2000)throw withDomainError(new DomainError('INVALID_BOT_TEMPLATE','消息模板须为 1–2000 字',400));
  const parts=parse(value);let expanded=0,hasURL=false;
  for(const part of parts){if('literal' in part)expanded+=botLength(part.literal);else{expanded+=BOT_TEMPLATE_LIMITS[part.field];if(part.field==='url')hasURL=true;}}
  if(!hasURL)throw invalid();
  if(expanded>BOT_MAX_CHARS)throw withDomainError(new DomainError('INVALID_BOT_TEMPLATE','模板展开后可能超过 4000 字，请减少重复变量或缩短内容',400));
  return value;
}
export function renderBotTemplate(templates:Readonly<Record<string,string>>,kind:string,context:Readonly<Record<string,unknown>>,markdown=false):string|null {
  const key=kind+(markdown?'@md':'');const custom=templates[key];if(markdown&&!custom)return null;
  const value=validateBotTemplate(custom||BOT_DEFAULT_TEMPLATE);
  const fields:Record<string,unknown>={previous_starts_at:'',...context};
  if(markdown)for(const [name,raw] of Object.entries(fields)){
    if(name==='url'||typeof raw!=='string')continue;
    fields[name]=name==='details'?raw.split('\n').filter(line=>botStrip(line)).map(line=>'- '+botPlainText(line)).join('\n'):botPlainText(raw);
  }
  const text=parse(value).map(part=>{
    if('literal' in part)return part.literal;
    if(!(part.field in fields))throw new Error('Missing frozen bot template field');
    const field=fields[part.field];return field===null?'None':field===true?'True':field===false?'False':String(field);
  }).join('');
  if(botLength(text)>BOT_MAX_CHARS||!botStrip(text))throw withDomainError(new DomainError('INVALID_BOT_TEMPLATE','消息内容超出 4000 字，请缩短模板',400));
  return text;
}
