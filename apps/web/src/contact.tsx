import { ArrowUpRight, Mail } from 'lucide-react';
import { Heading, Surface } from 'yahha-ui';
import { ActionLink } from './action-link';
import { InformationPage } from './information-page';
import { uiText } from './language';

const topics = [['email', uiText('聯絡信箱')], ['report', uiText('問題與投訴')], ['reply', uiText('處理與回覆')]] as const;

export function ContactPage() {
  return <InformationPage title="聯絡營運者" topics={topics}>
    <Surface className="information-document">
      <section id="email" className="information-section">
        <Heading level={2}>聯絡信箱</Heading>
        <a className="contact-email" href="mailto:203008876@qq.com"><Mail size={20} aria-hidden="true"/>203008876@qq.com<ArrowUpRight size={17} aria-hidden="true"/></a>
      </section>
      <section id="report" className="information-section">
        <Heading level={2}>問題與投訴</Heading>
        <p>請說明問題類型、希望的處理方式，以及相關活動連結、帳號稱呼或資料刪除申請編號。內容投訴請標明具體位置與必要依據。</p>
        <div className="contact-actions"><ActionLink to="/me/privacy">隱私與資料刪除申請</ActionLink></div>
      </section>
      <section id="reply" className="information-section">
        <Heading level={2}>處理與回覆</Heading>
        <p>請使用可收到回覆的信箱；勿傳送 QQ 密碼、授權碼或無關的敏感資料。將以回信核對歸屬並告知處理情況。</p>
      </section>
    </Surface>
  </InformationPage>;
}
