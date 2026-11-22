import type { FastifyInstance } from 'fastify';
import type { DB } from '@qgroup/database';
import { LegacyRequestCheck, LegacyTimePollRetry, decodeLegacyTimePoll, legacyTimePollId } from '@qgroup/contracts';
import { DomainError } from '@qgroup/domain';
import { withApiError } from './error-display';
import { hash, type Security } from './security';
import { originalRequestSignature } from './legacy-local';
import { legacyStamp } from './activity-arrangements';
import { activityBotPolicy, type ActivityBotDefaults } from './activity-bot';
import { pollRow, pollView } from './time-poll-context';
import { preparePollVote, executePollVote, preparePollManagement, executePollManagement, requirePollOwner } from './time-poll-command';
import { preparePollAnnouncement } from './time-poll-bot';
export function registerLegacyTimePoll(app: FastifyInstance, db: DB, security: Security, now: () => Date, defaults: ActivityBotDefaults = {}) {
  const limits = {config:{rateLimit:{max:30,timeWindow:'1 minute'}}};
  function inspect(request: Parameters<Security['memberWrite']>[0], input: ReturnType<typeof LegacyRequestCheck.parse>) {
    const user = security.memberWrite(request);
    let route: ReturnType<typeof legacyTimePollId>;
    try {route = legacyTimePollId(input);} catch {throw withApiError(new DomainError('LEGACY_POLL_UNSUPPORTED','原時間投票方法或路徑尚未支援；請保留原請求，不能重試',400));}
    const poll = pollRow(db,route.id,true);
    // Current owner authority is mandatory even for a matching deleted management receipt.
    if (!route.vote) requirePollOwner(poll,user.id);
    const signature = originalRequestSignature(input.method,input.path,input.data), old = db.prepare('SELECT signature,response_json FROM request_results WHERE user_id=? AND request_key=?').get(user.id,input.requestKey) as {signature:string;response_json:string}|undefined;
    if (old && old.signature !== signature) throw withApiError(new DomainError('LEGACY_REQUEST_CONFLICT','原操作編號與內容不符，請保留並核對原紀錄',409));
    if (old) {
      let result: unknown; try {result = JSON.parse(old.response_json);} catch {throw withApiError(new DomainError('LEGACY_REQUEST_RESULT_MISMATCH','原回執無法解析，請保留並核對原紀錄',409));}
      if (!result || typeof result !== 'object' || !('id' in result) || result.id !== poll.id || !('time_poll' in result && result.time_poll === true || 'status' in result && result.status === 'deleted')) throw withApiError(new DomainError('LEGACY_REQUEST_RESULT_MISMATCH','原回執投票與原請求不一致，請保留並核對原紀錄',409));
      if (poll.status === 'deleted') requirePollOwner(poll,user.id);
      return {user,poll,signature,old,requestKey:input.requestKey,decoded:undefined};
    }
    if (poll.status === 'deleted') pollRow(db,poll.id);
    let decoded: ReturnType<typeof decodeLegacyTimePoll>;
    try {decoded = decodeLegacyTimePoll(input,poll);} catch {throw withApiError(new DomainError('LEGACY_POLL_UNSUPPORTED','原時間投票欄位尚未支援或缺失；原請求保留，不能重試',400));}
    return {user,poll,signature,old,requestKey:input.requestKey,decoded};
  }
  const receipt = (id:string) => ({committed:true,target:{kind:'poll' as const,id}});
  function prepare(s: ReturnType<typeof inspect>, time: Date) {
    const decoded = s.decoded!;
    const plan = decoded.kind === 'vote' ? preparePollVote(db,s.poll,decoded.input,time) : preparePollManagement(db,s.poll,s.user,decoded.input,time,defaults);
    const finalization = 'finalization' in plan ? plan.finalization : undefined;
    let group_preview = '';
    if (decoded.kind === 'manage' && decoded.input.action === 'bot_retry' && 'retryNotice' in plan) group_preview = plan.retryNotice?.payload.text ?? '';
    if (decoded.kind === 'manage' && decoded.input.action === 'bot_sync' && decoded.input.bot_enabled) {
      // The original sync hook is optional. A formatting failure cannot block its business change.
      try {group_preview = preparePollAnnouncement(db,{...s.poll,bot_enabled:1},time,defaults)?.payload.text ?? '';} catch {group_preview = '';}
    }
    const value = {current:pollView(db,s.poll,s.user.id,time,defaults),command:decoded.input,finalization,group_preview};
    // Fence current review, policy, and original identity; this is not an invented original preview proof.
    const recovery_token = hash(JSON.stringify({user:s.user.id,key:s.requestKey,signature:s.signature,value,policy:decoded.kind === 'manage' ? activityBotPolicy(db,defaults).config : undefined,retryNotice:'retryNotice' in plan ? plan.retryNotice : undefined}));
    return {plan,view:{state:'retryable' as const,...value,recovery_token}};
  }
  app.post('/api/v2/me/legacy-requests/time-poll/inspect',limits,async request => db.transaction(() => {
    const input = LegacyRequestCheck.parse(request.body), s = inspect(request,input);
    return s.old ? {state:'committed',receipt:receipt(s.poll.id)} : prepare(s,now()).view;
  })());
  app.post('/api/v2/me/legacy-requests/time-poll/retry',limits,async request => db.transaction(() => {
    const {confirm,recovery_token,...input} = LegacyTimePollRetry.parse(request.body); void confirm;
    const s = inspect(request,input); if (s.old) return receipt(s.poll.id);
    const time = now(), p = prepare(s,time);
    if (p.view.recovery_token !== recovery_token) throw withApiError(new DomainError('LEGACY_POLL_REVIEW_CHANGED','原投票核對資料已變更；請重新檢查後確認',409));
    const hook = (work: () => unknown) => {try {db.transaction(work)();} catch {app.log.error({pollId:s.poll.id},'Poll bot hook failed; required business preserved');}};
    if ('active' in p.plan) executePollVote(db,p.plan,s.user,time); else executePollManagement(db,p.plan,s.user,time,defaults,hook);
    const poll = pollRow(db,s.poll.id,true), result = poll.status === 'deleted' ? {id:poll.id,status:'deleted'} : {id:poll.id,time_poll:true};
    // Original server refreshes this marker using current visibility and roles.
    db.prepare('INSERT INTO request_results VALUES(?,?,?,?,?,?)').run(s.user.id,input.requestKey,s.signature,JSON.stringify(result),200,legacyStamp(time));
    return receipt(poll.id);
  }).immediate());
}
