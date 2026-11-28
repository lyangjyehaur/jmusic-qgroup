import { UsersRound } from 'lucide-react';
import { uiText } from './language';

/** Counts and the saved start-time decision describe different facts. */
export function ActivityNumbers({confirmed,minimumParticipants,capacity,waiting,finished=false,formationState}:{confirmed:number;minimumParticipants:number;capacity:number;waiting:number;finished?:boolean;formationState?:string}) {
  const remaining=Math.max(0,minimumParticipants-confirmed);
  return <div className="activity-capacity" aria-label="活動人數">
    <span><UsersRound size={15} aria-hidden="true"/><strong>{confirmed}</strong> 人已報名</span>
    {minimumParticipants>0&&<small className={remaining&&!['confirmed','formed'].includes(formationState??'')?'formation-pending':'formation-ready'}>{minimumParticipants} 人成團 · {formationState==='confirmed'?uiText('已確認成團'):formationState==='formed'?uiText('已成團'):remaining?(finished?uiText('未達門檻'):uiText('還差')+' '+remaining+uiText(' 人')):uiText('已達門檻')}</small>}
    {(capacity>0||waiting>0)&&<small>{capacity>0?uiText('上限')+' '+capacity+uiText(' 人'):''}{capacity>0&&waiting>0?' · ':''}{waiting>0?uiText('候補')+' '+waiting+uiText(' 人'):''}</small>}
  </div>;
}
