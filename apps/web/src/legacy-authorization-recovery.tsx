import { Link } from 'react-router-dom';
import { Notice } from './shared';
export function legacyAuthorizationDestination(input:{method:string;path:string}){
 if(input.method!=='POST')return null;
 if(['/api/auth/qq/start','/api/auth/qq/finish','/api/register'].includes(input.path))return {path:'/login',label:'登入',message:'原登入或 OAuth 授權紀錄已保全。請在登入頁核對目前身份，重新發起授權；原憑證不重送。'};
 if(input.path==='/api/account/accept')return {path:'/me/devices',label:'裝置與帳號紀錄',message:'原裝置授權紀錄已保全。請先核對目前已授權裝置；需要新增存取時，由目前帳號重新建立授權連結。'};
 if(['/api/account/link','/api/account/revoke'].includes(input.path))return {path:'/me/devices',label:'裝置與帳號紀錄',message:'原裝置操作紀錄已保全。請先核對目前裝置狀態，再建立或撤銷授權；原操作不重送。'};
 if(['/api/account/switch','/api/auth/close','/api/auth/logout'].includes(input.path))return {path:'/me/accounts',label:'帳號',message:'原帳號操作紀錄已保全。請核對目前身份與裝置狀態，再從帳號頁完成切換、登出或關閉；原操作不重送。'};
 return null;
}
export function LegacyAuthorizationRecovery({input}:{input:{method:string;path:string}}){const destination=legacyAuthorizationDestination(input);return destination?<Notice>{destination.message}<Link to={destination.path}>前往{destination.label}</Link></Notice>:null;}
