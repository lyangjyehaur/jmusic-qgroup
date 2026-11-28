import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { assertDatabaseUsable, type DB } from '@qgroup/database';
import { botLength, botLocalTime, botStartCountdown, botStrip, renderBotCommand, renderBotEvent, renderBotHelp, renderBotNoEvents, renderBotSelection, renderBotTasks, withBotRoster } from '@qgroup/domain';
import { botActivityURL, botRegistrationLabel, botRosterLines } from '../../api/src/activity-bot';
import type { EventRow } from '../../api/src/activity-arrangements';
import { BOT_ALIASES, BOT_COMMANDS, BOT_HELP, BOT_LINK_ACTIONS, BOT_QUICK_COMMANDS, type PublicBotCommand } from './commands';
import { botCandidates, botFinanceClosed, botPublicCounts, botPublicTasks, BotSelectionError, currentBotEvent } from './public-queries';
export interface BotReplyOptions { baseURL?: string; now?: Date }
export interface PublicBotReply { text: string; markdown: string | null; keyboard: null }
const cut = (text: string, length: number) => Array.from(text).slice(0, length).join('');
const money=(cents:number)=>{const value=BigInt(cents),absolute=value<0n?-value:value;return (value<0n?'-':'')+(absolute/100n)+'.'+String(absolute%100n).padStart(2,'0');};
const phases: Record<string,string> = { scheduled:'待开始', ongoing:'进行中', ended:'已结束', cancelled:'已取消' };
const hasAction = (command:string): command is keyof typeof BOT_LINK_ACTIONS => Object.hasOwn(BOT_LINK_ACTIONS,command);
export function botHelpText(site:string) {
  return BOT_HELP + '\n\n隐私政策：' + site + '/privacy\n联络与问题反馈：' + site + '/contact\n群内消息只提供入口；不会替你报名、确认安排或登记付款。';
}
/** Coherent read transaction for both formats; no identity inferred or action executed.
 * Abbreviation queries belong to the separate asynchronous external lookup service.
 */
export function answerPublicBotCommand(db:DB, command:PublicBotCommand|null, argument='', options:BotReplyOptions={}):PublicBotReply {
  return db.transaction(() => {
    assertDatabaseUsable(db);
    if ((command as string) === '缩写') throw Error('Abbreviation command requires the asynchronous lookup service');
    const site=(options.baseURL??'https://kanban.danndann.cn').replace(/\/+$/,''),now=options.now??new Date();
    const url=(event:EventRow,action?:string)=>botActivityURL(event.id,action,{baseURL:site});
    const reply=(text:string,markdown:string|null):PublicBotReply=>({text,markdown,keyboard:null});
    if (!command || !Object.values(BOT_ALIASES).includes(command) || command==='帮助') {
      const prefix=command==='帮助'?'':'未识别这条指令，请使用下列指令：';
      return reply((prefix?prefix+'\n':'')+botHelpText(site),renderBotHelp(BOT_COMMANDS,site,BOT_QUICK_COMMANDS,prefix));
    }
    function generic(text:string):PublicBotReply {
      const lines=text.split('\n').filter(line=>botStrip(line));
      const link=lines.at(-1)?.match(/^https?:\/\//)?lines.pop()!:'';
      const head=lines[0]&&(lines[0].startsWith('【')||botLength(lines[0])<=42)?lines.shift()!:'';
      return reply(text,renderBotCommand(command!,head,lines,link));
    }
    if(command==='我的'&&!argument)return generic('机器人尚未绑定你的站内身份，请登录网站查看我的报名、同行、款项与待办。\n'+site+'/?action=mine');
    if(command==='发起')return generic('请登录网站填写并核对后发布；目前尚未创建活动。\n'+site+'/?action=create');
    let event:EventRow|undefined;
    try { event=currentBotEvent(db,argument,command,now); }
    catch(error){if(error instanceof BotSelectionError)return reply(error.message,null);throw error;}
    if(!event){
      const rows=botCandidates(db,command,now);
      if(!rows.length)return reply('目前没有可在本群查询的活动（没有进行中的公开活动，或该分类暂无已发布的公开活动）。\n请到网站查看你有权访问的活动：\n'+site+'/',renderBotNoEvents(site));
      const action=hasAction(command)?BOT_LINK_ACTIONS[command][0]:command==='结算'?'settlement':'detail';
      const lines=['请选择活动，点对应链接继续，或发送 /'+command+' 序号（例如 /'+command+' 1）：'];
      const items=rows.slice(0,8).map((candidate,index):[string,string,string]=>{
        const countdown=botStartCountdown(candidate,now),when=botLocalTime(candidate.starts_at,candidate.timezone)+(countdown?' · '+countdown:'');
        const title=cut(candidate.title,40),link=url(candidate,action);lines.push((index+1)+'. '+title+' · '+when,link);return [title,when,link];
      });
      if(rows.length>8)lines.push('更多活动请到网站查看：'+site+'/');
      lines.push('序号以最近一次 /'+command+' 清单为准；活动增减后会变，也可发送 8 位活动短码。');
      return reply(lines.join('\n'),renderBotSelection(items,command,site,rows.length>8));
    }
    const c=botPublicCounts(db,event.id),when=botLocalTime(event.starts_at,event.timezone),countdown=botStartCountdown(event,now),title=cut(event.title,40);
    const head='【'+title+'】'+when+(countdown?'\n'+countdown:'');
    if(hasAction(command)){
      const [action,explanation]=BOT_LINK_ACTIONS[command];let text=[head,explanation,'',url(event,action)].join('\n');
      if(command==='报名')text=withBotRoster(text,botRosterLines(db,event));
      return generic(text);
    }
    let lines:string[];
    if(command==='活动'||command==='往期'){
      const phase=(event.formation_state==='unformed'&&event.lifecycle==='cancelled'?'未成团 · 已取消':phases[event.lifecycle]!)+' · '+botRegistrationLabel(event,now);
      lines=[head,'地点：'+event.location,'报名截止：'+botLocalTime(event.deadline,event.timezone),'正式 '+c.confirmed+' 人，候补 '+c.waiting+' 人','当前阶段：'+phase,'',url(event)];
      let text=lines.join('\n'),markdown=renderBotEvent(title,when,[['地点',cut(event.location||'',120)],['报名截止',botLocalTime(event.deadline,event.timezone)],['人数','正式 '+c.confirmed+' 人，候补 '+c.waiting+' 人'],['当前阶段',phase]],url(event),countdown);
      if(command==='活动'){const roster=botRosterLines(db,event);text=withBotRoster(text,roster);markdown=withBotRoster(markdown,roster,true);}
      return reply(text,markdown);
    }
    if(command==='名额'){
      lines=[head,botRegistrationLabel(event,now),'正式 '+c.confirmed+' 人 / 上限 '+(event.capacity||'不限'),'候补 '+c.waiting+' 人，待确认参加 '+c.tentative+' 人（不占名额）'];
      if(db.prepare("SELECT 1 FROM attendees a JOIN roster_parties p ON p.id=a.party_id WHERE a.event_id=? AND a.status='waiting' AND p.queue_mode='together' LIMIT 1").get(event.id))lines.push('存在整组候补，空位须按队列分配，不能保证直接报上。');
      if(event.minimum_participants)lines.push('最低成团 '+event.minimum_participants+' 人；'+(event.formation_state==='confirmed'?'发起者已确认成团':event.formation_state==='formed'?'开始时已达门槛，已成团':event.formation_state==='unformed'?'未成团，活动已取消':'待发起者决定是否成团'));
      lines.push('',url(event,'join'));return generic(withBotRoster(lines.join('\n'),botRosterLines(db,event)));
    }
    if(command==='待办'){
      const tasks=botPublicTasks(db,event,now);
      lines=[head,'活动状态摘要（不是你的个人待办）：',...(tasks.length?tasks.map(text=>'・'+text):['・暂无公开状态提醒']),'认领、退出审批、款项申报及个人补退款，请登录网站按权限查看。','',url(event,'todos')];
      return reply(lines.join('\n'),renderBotTasks(title,when,tasks,url(event,'todos'),countdown));
    }
    if(command==='出席'){
      const counts=new Map((db.prepare("SELECT attendance,count(*) AS n FROM attendees WHERE event_id=? AND (status='confirmed' OR attendance!='unknown') GROUP BY attendance").all(event.id) as {attendance:string;n:number}[]).map(row=>[row.attendance,row.n]));
      lines=[head,['到场','迟到','早退','缺席','未核对'].map((label,i)=>label+' '+(counts.get(['present','late','left','absent','unknown'][i]!)??0)+' 人').join('，'),'尚未替你登记出席；核对已有人员与现场补录是不同流程，须按权限在网站操作。','',url(event,'attendance')];
    }else if(command==='结算'){
      const version=(db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM settlement_history WHERE event_id=?').get(event.id) as {version:number}).version;
      const bill=db.prepare('SELECT total_cents,headcount FROM settlements WHERE event_id=?').get(event.id) as {total_cents:number;headcount:number}|undefined;
      lines=bill?[head,'第 '+(version||1)+' 版，总额 '+money(bill.total_cents)+' 元，'+bill.headcount+' 人',botFinanceClosed(db,event)?'账务已确认结清。':'账单已发布，收退款与账务仍需核对；发布不代表款项已收齐。','每人应付与付款归属请到站内查看（不在此列出）。']:[head,'结算尚未发布；请发起者在实际结束或取消后核对发布。'];
      lines.push('',url(event,'settlement'));
    }else if(command==='我的'){
      lines=[head,'尚未绑定你的身份；个人应付金额与付款归属请登录站内查看。','',url(event,'finance')];
    }else if(command==='地点'){
      lines=[head,'地点：'+event.location,'请到活动页点击导航。','',url(event)];
    }else if(command==='规则'){
      lines=[head,'费用约定：'+(event.fee_policy||'未填写，请向发起者确认'),'退出期限：'+botLocalTime(event.withdrawal_deadline||event.deadline,event.timezone),'期限后正式报名须申请退出；退出不等于退款。最终金额以核对发布的账单为准。','',url(event,'conditions')];
    }else throw Error('Unimplemented public command: '+command);
    return generic(lines.join('\n'));
  })();
}
/** Open the existing file read-only: never create, migrate or mutate a DB. */
export function readPublicBotReply(path:string,command:PublicBotCommand|null,argument='',options:BotReplyOptions={}):PublicBotReply {
  const db=new Database(resolve(path),{readonly:true,fileMustExist:true});
  try { db.pragma('query_only = ON');db.pragma('busy_timeout = 5000');return answerPublicBotCommand(db,command,argument,options); }
  finally { db.close(); }
}
