import { Link } from 'react-router-dom';
import { Surface } from 'yahha-ui';
import { PageIntro } from './shared';
export function ContactPage(){return <><PageIntro title="聯絡與投訴"/><Surface className="detail"><a href="mailto:203008876@qq.com">203008876@qq.com</a><p>請說明問題類型、希望的處理方式，以及相關活動連結、帳號稱呼或資料刪除申請編號。內容投訴請標明具體位置與必要依據。</p><p>請使用可收到回覆的信箱；勿傳送 QQ 密碼、授權碼或無關的敏感資料。將以回信核對歸屬並告知處理情況。</p><Link to="/me/privacy">隱私與資料刪除申請</Link></Surface><p><a href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer">渝ICP备16002872号-1</a></p></>;}
