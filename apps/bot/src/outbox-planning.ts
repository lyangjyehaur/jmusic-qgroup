import { botContentProblem,botHasUnapprovedLink,botLength,botStrip } from '@qgroup/domain';
import { object,type APIObject } from './protocol';
export { reminderKinds,outboxPayload,outboxSkipReason } from '../../api/src/bot-delivery-rules';
export { deliveryContext,prepareOutboxPayload } from '../../api/src/bot-delivery-plan';
export function outboxBody(
  payload: APIObject,
  markdown: boolean,
  hosts: readonly string[],
): { body: APIObject; problem?: undefined } | { problem: string; body?: undefined } {
  let body: APIObject = { msg_type: payload.msg_type ?? 0 };
  const rich = payload.markdown_text;
  if (body.msg_type === 0 && markdown && typeof rich === 'string' && !botContentProblem(rich, hosts))
    body = { msg_type: 2, markdown: { content: rich } };
  else if (body.msg_type === 0) {
    const text = payload.text;
    if (typeof text !== 'string' || !botStrip(text)) return { problem: '文字内容为空，拒绝发送' };
    if (/[\x00-\x08\x0b-\x1f]/.test(text)) return { problem: '文字含控制字符，拒绝发送' };
    if (botLength(text) > 4000) return { problem: '文字超过 4000 字，拒绝发送' };
    if (botHasUnapprovedLink(text, hosts)) return { problem: '文字含未报备域名，拒绝发送' };
    body.content = text;
  } else {
    const extra = Object.fromEntries(
      Object.entries(payload).filter(([key]) =>
        ['content', 'media', 'file_info', 'markdown', 'image'].includes(key),
      ),
    );
    if (object(payload._settlement_image)) body.media = { settlement_image: payload._settlement_image.kind };
    else if (Object.keys(extra).length) Object.assign(body, extra);
    else return { problem: '非文字消息缺少内容字段，拒绝发送' };
  }
  if (payload.keyboard) {
    if (
      !object(payload.keyboard) ||
      !object(payload.keyboard.content) ||
      !Array.isArray(payload.keyboard.content.rows)
    )
      return { problem: '按钮格式无效，拒绝发送' };
    for (const row of payload.keyboard.content.rows) {
      if (!object(row) || !Array.isArray(row.buttons)) return { problem: '按钮格式无效，拒绝发送' };
      for (const button of row.buttons) {
        if (!object(button) || !object(button.action)) return { problem: '按钮格式无效，拒绝发送' };
        if (button.action.type === 0 && botHasUnapprovedLink(String(button.action.data ?? ''), hosts))
          return { problem: '按钮含未报备域名，拒绝发送' };
      }
    }
    body.keyboard = payload.keyboard;
  }
  return { body };
}
