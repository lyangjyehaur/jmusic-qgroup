// Shared by the future web outbox producer and TypeScript worker. User text
// never contributes QQ Markdown syntax; only system fragments / admin templates do.
export const BOT_BLANK='\u200b';
export const BOT_MAX_CHARS=4000;
export const botLength=(value:string)=>Array.from(value).length;
const control=/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const spaces='[\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const nonSpace='[^'+spaces.slice(1,-1)+']';
const pyRegex=(source:string,flags='g')=>new RegExp(source.replaceAll('[^\\s','[^'+spaces.slice(1,-1)).replaceAll('\\s',spaces).replaceAll('\\S',nonSpace),flags);
export const botStrip=(value:string)=>value.replace(pyRegex('^\\s+|\\s+$'),'');
export function botPlainText(text:unknown):string {
  let value=String(text??'').replace(new RegExp(control.source,'g'),' ').replace(/[\r\n\t]/g,' ').replaceAll(BOT_BLANK,'');
  value=value.replace(pyRegex('<\\s*/?\\s*qqbot-at-[^>]*>','gi'),'').replace(pyRegex('<\\s*https?://[^>]*>','gi'),'');
  value=value.replace(/!?\[([^\]]*)\]\([^)]*\)/g,'$1').replace(/[*_`~<>\[\]!|\\#]/g,'').replace(/ {2,}/g,' ');
  return botStrip(botStrip(value).replace(pyRegex('^\\s*(?:[-+]\\s+|\\p{Decimal_Number}+[.)]\\s+)','u'),''));
}
export function botTimeChange(previous:unknown,current:unknown){
  const before=botPlainText(previous),after=botPlainText(current);
  return before&&after&&before!==after?'- **时间** ~~'+before+'~~ → **'+after+'**':null;
}
export function botContentProblem(text:unknown,allowedHosts:readonly string[]=[]):string|null {
  if(typeof text!=='string'||!botStrip(text))return 'markdown 内容为空';
  if(control.test(text))return 'markdown 含控制字符';
  if(botLength(text)>BOT_MAX_CHARS)return 'markdown 超过 4000 字';
  return botHasUnapprovedLink(text,allowedHosts)?'markdown 含未报备域名':null;
}
export function botHasUnapprovedLink(text:string,allowedHosts:readonly string[]=[]):boolean {
  if(allowedHosts.length){
    const hosts=new Set(allowedHosts.filter(Boolean).map(host=>botStrip(host).toLowerCase()));
    for(const match of text.matchAll(pyRegex('https?://([^\\s<>"\\[\\]{}]+)','gi'))){
      try{const host=new URL('https://'+match[1]!.replace(/\)+$/,'')).hostname.toLowerCase();if(!hosts.has(host))return true;}
      catch{return true;}
    }
  }
  return false;
}
export function renderBotBroadcast(label:string,title:string,details:readonly string[],url:string,options:{linkLabel?:string;notice?:readonly string[];systemFacts?:readonly string[];footnote?:string}={}){
  const facts=[...(options.systemFacts??[]).filter(line=>botStrip(line)),...details.filter(line=>botStrip(line)).map(line=>'- '+botPlainText(line))];
  const lines=['## '+botPlainText(label),'活动名称：'+botPlainText(title),BOT_BLANK,...(facts.length?facts:['- 暂无其他说明'])];
  if(options.notice?.length)lines.push(BOT_BLANK,'## 逐人应付',...options.notice.filter(line=>botStrip(line)).map(line=>'- '+botPlainText(line)));
  lines.push(BOT_BLANK,'['+botPlainText(options.linkLabel??'打开活动')+']('+url+')');
  const footnote=options.footnote??'指令只提供查询或操作入口；报名、确认及款项仍须在网站核对提交。';
  if(footnote)lines.push(BOT_BLANK,'> '+botPlainText(footnote));
  return lines.join('\n');
}
export function withBotRoster(text:string,lines:readonly string[]|null|undefined,markdown=false):string {
  if(!lines?.length)return text;
  const section=markdown?lines.map(line=>'- '+botPlainText(line)).join('\n'):lines.join('\n');
  const gap=markdown?'\n'+BOT_BLANK+'\n':'\n\n';const parts=text.split('\n');let link=-1;
  for(let i=parts.length-1;i>=0;i--){const line=parts[i]!;if(line.startsWith('https://')||line.startsWith('http://')||pyRegex('^\\[[^\\]]+\\]\\(https?://[^\\s]+\\)$','').test(line)){link=i;break;}}
  for(const content of [section,'报名名单较长，请到活动页查看完整名单。']){
    const decorated=link>=0?parts.slice(0,link).join('\n')+gap+content+gap+parts.slice(link).join('\n'):text+gap+content;
    if(botLength(decorated)<=BOT_MAX_CHARS)return decorated;
  }
  return text;
}
/** Public roster names also strip mentions and bare links in the plain fallback. */
export function botRosterName(raw:string){
  const text=botPlainText(raw.replace(/<@!?[^>]*>/g,''));
  const name=botStrip(text.replace(pyRegex('https?://\\S+','gi'),'').replace(/@(?:everyone|all)(?![\p{L}\p{N}_])/giu,'').replace(/[@＠]/g,''));
  return Array.from(name).slice(0,24).join('')||'未填写称呼';
}
