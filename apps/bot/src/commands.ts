import { botStrip } from '@qgroup/domain';
/** Fixed operational labels retained from the legacy bot command panel. */
export const BOT_COMMANDS = [
  {
    "name": "/活动",
    "desc": "选择活动，查看时间与地点"
  },
  {
    "name": "/报名",
    "desc": "本人、同行与退出入口"
  },
  {
    "name": "/我的",
    "desc": "登录网站查看我的报名与款项"
  },
  {
    "name": "/结算",
    "desc": "往期账单、收退款与账本"
  },
  {
    "name": "/管理",
    "desc": "按权限处理活动待办"
  },
  {
    "name": "/帮助",
    "desc": "常用指令与操作说明"
  }
] as const;
export const BOT_ALIASES = {
  "活动": "活动",
  "报名": "报名",
  "我的": "我的",
  "结算": "结算",
  "管理": "管理",
  "帮助": "帮助",
  "名额": "名额",
  "待办": "待办",
  "出席": "出席",
  "同行": "同行",
  "退出": "退出",
  "发起": "发起",
  "再约": "再约",
  "待确认": "待确认",
  "确认安排": "确认安排",
  "地点": "地点",
  "规则": "规则",
  "款项": "款项",
  "账本": "账本",
  "已付款": "已付款",
  "申报": "申报",
  "补报": "补报",
  "认领": "认领",
  "协办": "协办",
  "往期": "往期",
  "缩写": "缩写",
  "活動": "活动",
  "報名": "报名",
  "結算": "结算",
  "幫助": "帮助",
  "名額": "名额",
  "待辦": "待办",
  "签到": "出席",
  "簽到": "出席",
  "發起": "发起",
  "再約": "再约",
  "待確認": "待确认",
  "確認安排": "确认安排",
  "地點": "地点",
  "規則": "规则",
  "款項": "款项",
  "帳本": "账本",
  "賬本": "账本",
  "帐本": "账本",
  "申報": "申报",
  "補報": "补报",
  "認領": "认领",
  "協辦": "协办",
  "help": "帮助",
  "events": "活动",
  "todos": "待办",
  "me": "我的",
  "settle": "结算",
  "quota": "名额",
  "join": "报名",
  "縮寫": "缩写",
  "nbnhhsh": "缩写"
} as const;
export type BotCommand = typeof BOT_ALIASES[keyof typeof BOT_ALIASES];
export type PublicBotCommand = Exclude<BotCommand, '缩写'>;
export const BOT_QUICK_COMMANDS = "快捷指令：/名额 /待办 /出席（/签到） /同行 /退出 /待确认 /确认安排\n/地点 /规则 /款项 /账本 /已付款 /申报 /发起 /再约 /补报 /认领 /协办 /往期\n/缩写 yyds  查询拼音缩写（支持 /縮寫、/nbnhhsh；仅缩写发送至第三方查询）\n也可引用消息后只 @机器人，查询原文中的英文缩写。";
export const BOT_HELP = "群聚看板常用指令（简繁均可）：\n/活动  选择活动，查看时间与地点\n/报名  查看安排并进入报名\n/我的  登录网站查看我的报名、同行与款项\n/结算  往期账单与收退款\n/管理  按权限查看活动待办\n/帮助  显示本说明\n\n快捷指令：/名额 /待办 /出席（/签到） /同行 /退出 /待确认 /确认安排\n/地点 /规则 /款项 /账本 /已付款 /申报 /发起 /再约 /补报 /认领 /协办 /往期\n/缩写 yyds  查询拼音缩写（支持 /縮寫、/nbnhhsh；仅缩写发送至第三方查询）\n也可引用消息后只 @机器人，查询原文中的英文缩写。\n多场活动请点对应链接，或在指令后加清单序号，例如 /名额 2 选第 2 场。\n序号以最近一次 /活动 清单为准；活动增减后会变，短码仍可继续使用。\n指令只提供查询或操作入口；报名、确认及款项仍须在网站核对提交。";
export const BOT_LINK_ACTIONS = {
  "报名": [
    "join",
    "查看安排并在网站提交报名；目前尚未替你占位。"
  ],
  "同行": [
    "party",
    "同行逐人占位，请在网站预览正式／候补结果，再确认报名。"
  ],
  "待确认": [
    "tentative",
    "待确认不占名额；确定参加时按当时队列分配。"
  ],
  "退出": [
    "withdraw",
    "请在网站选择本人或可管理的同行；逾期正式报名须申请，批准前保留名额。"
  ],
  "确认安排": [
    "conditions",
    "请逐人核对新版安排；未确认或暂不同意不代表自动退出。"
  ],
  "款项": [
    "finance",
    "请登录网站查看本人待补、应退及垫付待收回款项。"
  ],
  "账本": [
    "finance",
    "结算决定应付，账本记录实际收付；申报须核实后才计入。"
  ],
  "已付款": [
    "report",
    "请在网站申报实际转账，发起者核实后才计入已确认款项；目前尚未登记。"
  ],
  "申报": [
    "report",
    "请核对实际转款人、付款责任人、金额及时间，再预览提交；申报不等于已到账。"
  ],
  "补报": [
    "invite",
    "补报名须有报名管理权限的人生成指定邀请；邀请不预留名额。"
  ],
  "认领": [
    "claim",
    "请找原管理人发本人认领链接；申请后仍需核对，不要重复报名。"
  ],
  "协办": [
    "management",
    "请在网站按权限生成或接受交接邀请；专属链接只交指定人。"
  ],
  "管理": [
    "manage",
    "请登录网站按发起者／协办权限处理；此入口不授予管理权。"
  ],
  "再约": [
    "copy",
    "只复制安排；请重新填写日期与截止，不复制名册、账务或收款码。"
  ]
} as const;
export const BOT_FINANCE_COMMANDS: ReadonlySet<string> = new Set([
  "已付款",
  "款项",
  "申报",
  "结算",
  "账本"
]);

export function parseBotCommand(content: unknown): [BotCommand | null, string] {
  const text = botStrip(botStrip(String(content || '').replace(/<@!?[A-Za-z0-9_-]+>/g, ' ')).replace(/^[＠@]+/, ''));
  if (!text) return ['活动', ''];
  // Python whitespace includes U+001C..U+001F and U+0085, but excludes BOM.
  const space = '[\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
  const match = new RegExp('^[/／]?' + space + '*([^' + space.slice(1,-1) + ']+)' + space + '*([\\s\\S]*)$', 'u').exec(text);
  if (!match) return [null, ''];
  const head = match[1]!.replace(/^[/／]+/, '').toLowerCase();
  return [Object.hasOwn(BOT_ALIASES, head) ? BOT_ALIASES[head as keyof typeof BOT_ALIASES] : null, botStrip(match[2]!)];
}
