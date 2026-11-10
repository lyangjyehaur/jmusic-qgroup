# 群聚看板

私有原始碼倉庫：[git.dan.tw/dan/qgroup](https://git.dan.tw/dan/qgroup)，主分支為 `main`。推送原始碼不會自動部署，線上更新仍按下方 server2 部署與保全流程進行。資料庫、使用者上傳圖片、伺服器環境設定及本機管理憑證不納入 Git。

面向群组成员的轻量活动报名与管理网站，支持唱歌、聚餐、运动、出游等活动，手机优先。首页直接显示活动，卡片进入详情。默认只显示基础发起、本人报名与结算；同行／代报、名额与期限、协办、账本及特殊分摊等收于各页「高级选项」开关。开关只控制显示，不清空已设置的数据和规则。

使用说明可从首页底部「操作说明」进入，或打开 [在线说明](https://kanban.danndann.cn/guide.html)。源文档见 [操作手册](docs/user-guide.md)：包含发起／本人报名、同行与代报、整组候补、退出审批、报名认领、改期、现场补录和结算更正，末尾附可复制到群内的简版说明。适用版本 20261109-events1。

已实现 P0–P5 功能，以及不依赖 QQ 的代报认领、账号冲突处理与跨设备授权：逐人／代报／同行、正式与候补、整组排队、退出审批、草稿、安排版本与逐人确认、实际时间、协办与转交、现场出席、归档，逐人费用分摊、多人合付、消费凭证，完整结算版本历史，以及预收、实收、退款与墊付账本。

完整计划见 [实施计划](docs/implementation-plan.md)，接口见 [报名契约](docs/roster-contract.md) 、[P2 活动契约](docs/activity-contract.md)、[P3 结算契约](docs/settlement-contract.md) 与 [P4 收付款契约](docs/finance-contract.md)。P5 增加活动／结算（含图片）／款项本机草稿、未知操作查回与安全重试、动态待办、活动复制与导航，详见 [P5 恢复契约](docs/experience-contract.md)；QQ OAuth 登录、回调及账号绑定已实现，应用审核和真实授权仍待确认。

## 本地运行及验证

Python 3.9+ 及系统 IANA 时区数据库，无第三方运行依赖。

```sh
npm ci --ignore-scripts
python3 deploy/build_guide.py
npm run build:locales
python3 server.py
python3 -m unittest discover -s tests -q
node --check public/app.js
node --check public/client.js
node --check public/roster.js
node --check public/activity.js
node --check public/settlements.js
node --check public/finance.js
node --check public/identity.js
node tests/test_dates.js
node tests/test_settlement_payload.js
node tests/test_client.js
node tests/test_todos.js
node tests/test_i18n.js
node tests/test_analytics.js
node --check public/storage.js
node --check public/experience.js
```

打开 http://127.0.0.1:8791，默认数据库 `data/kanban.sqlite3`，首次启动无测试活动。当前 218 项后端测试，另有时区、结算表单、持久化重试及角色待办的 Node 测试；测试使用隔离临时数据库。

## 使用规则

- 人数默认不限，发布后自动为发起者报名，占一个正式名额并计入默认 AA 人数；不再显示本人参加勾选。保存草稿不占位，发布草稿时自动报名；发起者之后可按同样退出规则撤销本人报名。同行逐人占位，支持代报者统一付款或参加者自己付款标记。结算时可逐人核对、调整付款归属或多人合付；实收和退款在独立账本登记。
- 多人报名先预览再确认；部分正式／候补必须明确接受。整组候补按队列等待，不自动让后人超车；新增同行使用新顺序。
- 待确认不占位，确认参加时入队。退出期限默认跟随报名截止；正式者逾期申请退出，由发起者或报名协办审批，审批前保留位置。截止后补人使用受邀接受流程，不预留名额。
- 活动有私有草稿、报名开关、最低成团人数及人工确认。活动默认 Asia/Shanghai，日期、开始、时长分别填写，跨日显示结束日期。超过预计结束仅提醒结束或延长；确认实际结束才进入往期和结算。
- 重要安排与费用规则变动须原因并保存新版本，原参加者逐人重新确认；暂不同意保留原位置及原约定，不自动退出或增加费用。
- 协办分为安排、报名、出席权限，没有账务或授予管理权。交接链接有效 7 天，接任人必须明确接受；发起者转交后不自动保留管理权。专属持有者链接只应发给指定人，也可绑定已有本人报名账号。
- 到场／缺席／迟到／早退独立于名额及账单，支持实际到离场时间；结束后更正须原因。现场补录须确认规则，超额或绕过候补须分别确认，已发布账单后不补录名单。
- 取消须原因，保留名单及账务，仍可结算订金等已发生费用。结束／取消后可归档，原链接、图片、记录继续可查。

## 结算

只有发起者可在实际结束或取消后发布结算。默认一笔共同费用、正式名单各一份 AA；可逐人半份／免共同费用（需原因），另加指定人员消费，或按比例、固定金额、参与分钟分摊。候补／待确认／已退出者不默认入账；缺席或未接受新安排需按原约定核对，不能从出席直接推断免费。每人可由一位或多位付款人承担。

发布前须核对名单并预览。以整数分、有理数和最大余数分配，每项及付款归属合计精确对平；同余依本版冻结的名单顺序分配。零元可发布，净总额及逐人应付不可负。店家退款／减免是费用扣项，不代表已实际退钱。

备注与收款码选填，每版最多三张消费凭证；浏览器转为静态 PNG 去除元数据，后端验证结构、校验和、尺寸及单张 2 MiB／合计 6 MiB 限制。新图片存于 SQLite 旁的私有 `images/`，按内容摘要去重，数据库只存索引和不可变版本引用；旧 BLOB 兼容保留。备份包含数据库和配对图片包。

首次发布及每次实际修改在同一事务内追加完整版本，冻结操作者、时间、人名、约定、份数、逐项金额、付款归属、备注与图片，并展示前后差异。旧版本不可覆盖或删除，换图不影响旧图，相同内容不加版本。原人均账单保持原值；发起者明确核对转换时只新增逐人版本，不重算历史。微信、支付宝、其他收款码按当前账号保存，结算每类可选一张并跨活动重用；移除私人库选项不影响已发布图片。P3 展示应付责任，P4 独立保存实际收付款。

新版写请求使用协议 2、请求去重键与活动 base_revision；结算额外核对 base_version，冲突返回 409，保留输入。旧网页兼容至 2026-12-08 UTC，之后需刷新。

## 收付款

活动发布后可记录预收、个人先付店家、订金／押金。参加者申报不等于已付款，须当前发起者核对后确认。分次、多付、实际转款人与责任人不同均有记录；可退押金先独立追踪，抵消费／转损失后才计店家净消费。已包含在最终账单的订金不重复记支出。

逐付款人按应付减去已确认净投入，显示待补／应退；改账或转交不挪动原款项。退款、偿还垫付、更正归属、移交代收资金各有类型与原因。个人可先垫付退款／偿还，活动代收资金不足时不虚构余额。每笔错误采用冲销及追加更正，原款项、申报与核对决定不可覆盖或删除。

每位付款人、店家净消费、代收资金、订金及待核对申报全部对平，才可确认结清。新账单／款项使结清重新待处理，保留旧结清记录。只登记款项，不执行真实转账。待核对或拒绝的申报原文仅发起者与申报者可见；已确认账本遵循活动可见性。完整规则见 P4 契约。

## 身份与访问

浏览网站仅建立访客 session，不自动注册。默认新账号须完成 QQ 授权并明确确认；登录后可单独修改群内称呼。第三方身份以 `(provider, client_id, subject)` 关联站内账号，预留微信等扩展，当前只实现 QQ。换设备可用同一 QQ 登录，也保留「账号与设备」一次性授权与明确切换；不按昵称合并账号。

管理员在 `/admin` 使用独立管理凭证登录；「允许免第三方登录注册」默认关闭。开启才允许仅填称呼创建浏览器账号，后端同样检查；再次关闭保留已有账号。该类账号丢失所有 Cookie／授权设备前应先绑定 QQ，否则不能仅凭称呼找回。详见 [身份契约](docs/identity-contract.md)。QQ 实际授权仍返回 100008「该网站尚未开通 QQ 账号登录」，待平台开通后做真实验收，再向群友公开。

公开活动的称呼、备注、账务对访问者可见；邀请模式对列表、详情、历史、图片统一验证。邀请可转传，不证明 QQ 群成员身份。站内通知及复制摘要供人工转发；可选的 QQ 群机器人见下节，默认关闭。页面每 30 秒刷新，写入、审计、通知、请求结果及机器人待发消息在同一事务提交。

## server2 部署与保全

- 网站：https://kanban.danndann.cn
- 应用 `/opt/qgroup`，systemd `qgroup.service` 与 `qgroup-bot.service`，两者以同一静态账号 `qgroupsvc` 非 root 运行。
- 后端仅监听 `127.0.0.1:8791`。
- 数据库 `/var/lib/qgroup/kanban.sqlite3`；改用静态账号后 systemd 的 `StateDirectory=qgroup` 就直接落在这里。原 `DynamicUser` 时代的 `/var/lib/private/qgroup` 已由 systemd 在首次启动时自动迁移过来（日志会写明），不要再往 private 路径找库。
- 反向代理、TLS 由用户通过 **1Panel 标准流程**管理；目标 `http://127.0.0.1:8791`，使用现有通配符证书。不要手写 OpenResty 配置。

每次升级先备份代码及 SQLite，以正式备份的隔离副本演练迁移，再停服务、最终快照、完整替换应用、启动迁移。上传 `server.py`、`qgroup_core/`、`public/`、`deploy/`、文档；不上传数据库。不要让旧、新写逻辑同时运行，不由 root 迁移实时库。

```sh
ssh server2 'systemctl status qgroup --no-pager'
ssh server2 'journalctl -u qgroup -n 80 --no-pager'
ssh server2 'systemctl start qgroup-backup.service'
python3 deploy/verify_migration.py source.sqlite3 isolated-copy.sqlite3
```

`qgroup-backup.timer` 每天 UTC 19:20 后延迟 0–5 分钟（台北次日 03:20–03:25）在线备份，root 专用目录 `/var/backups/qgroup` 保留 14 份。每份 `.sqlite3` 配对同名前缀的 `.images.tar.gz`，包含所有已提交的图片与历史。恢复需同时还原数据库和图片目录；旧版没有外部图片的备份可单独使用。升级验收比较源库每个用户表原有列及每个值，并校验完整性、外键和重复迁移。

恢复须先停服务，另外保存当前库及 WAL／SHM；使用现有服务用户及权限还原，不能混用旧 WAL。发布后如有新写入，不能盲目回滚旧数据库，应优先向前修复或做可对账恢复。

## 配置

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| KANBAN_HOST | 127.0.0.1 | 监听地址 |
| KANBAN_PORT | 8791 | 端口 |
| KANBAN_DB | data/kanban.sqlite3 | 数据库 |
| KANBAN_ORIGIN | 空，按 Host 判断 | 生产设 https://kanban.danndann.cn |
| KANBAN_SECURE_COOKIE | 0 | HTTPS 设 1 |
| KANBAN_ADMIN_KEY_HASH | 空 | 长随机管理凭证的 SHA256；由 root 0600 的 /etc/qgroup/admin.env 提供 |
| KANBAN_QQ_APP_ID | 空 | QQ 互联 App ID；未配置时隐藏 QQ 入口 |
| KANBAN_QQ_APP_KEY | 空 | 仅服务器保存，禁止放前端或代码仓库 |
| KANBAN_QQ_REDIRECT_URI | ORIGIN + /auth/qq/callback | 须与 QQ 平台登记一致，只接受同源固定路径 |
| KANBAN_BOT_ENABLED | 0 | 主服务是否把群消息写入 `bot_outbox`；不设则所有原有写入路径完全不变 |
| KANBAN_BOT_BASE_URL | https://kanban.danndann.cn | 群消息里的站内链接前缀 |
| KANBAN_BOT_SCHEDULE | 1 | 建立活动时排入截止前 24 小时／预计结束两条时间驱动提醒 |
| KANBAN_BOT_SETTLEMENT_DETAIL | 0 | 1 才在群里列出逐人金额；**会同时公开参加者姓名**，默认只给站内链接 |
| KANBAN_BOT_PERSONAL_QUEUE | 0 | 1 才把点名通知排入 private 通道（尚无身份绑定，投递时会被标记为 skipped） |
| KANBAN_BOT_BROADCAST_KINDS | 空＝默认集合 | 逗号分隔，自行增减主动广播节点；不是频率限制 |
| KANBAN_BOT_DRY_RUN | 1 | bot 行程只记 log 不真的发送，验收前保持 1 |

静态文件白名单；写接口要求 JSON、同源与限流，并在事务内验证身份、版本及权限。输入在前端进行 HTML 转义。

操作手册更新后运行 `python3 deploy/build_guide.py` 生成 `public/guide.html`；仅构建时需要 markdown-it-py，线上运行不需要该依赖。

## QQ 群机器人（初版 MVP）

独立的 `qgroup_bot` 常驻行程，通过官方 QQ 开放平台 WebSocket／OpenAPI v2 与群交互。平台能力已于 2026-11-10 实机验证：正式环境长连线、全量事件、被动回复、主动纯文字／含 URL、纯定时推播均可，个人主体即可，无需企业资质或上架审核。本版**默认全链路关闭**：`KANBAN_BOT_ENABLED` 未设时主服务一行额外逻辑都不执行；`KANBAN_BOT_DRY_RUN=1` 时 bot 只记 log 不发送。

**分工**：主服务只负责在 `audit.notify`／`audit.append` 的**同一事务**内把去识别化摘要写入 `bot_outbox`（migration 10）；`server.py` 的 API 与数据库业务表一行未改。挂钩由 `audit.bot_hook` 包住，文案组合或 outbox 写入出任何异常都只记日志，**不会让报名、结算或账务写入失败**。`qgroup_bot` 只读写 outbox 的投递状态，业务表一律只读打开。主服务没有排程器，所以时间驱动提醒在活动发布时就以 `due_at` 预先排入 outbox，由 bot 按时消费；发送失败只改 outbox 状态与 `attempts`，绝不回滚已成功的报名或收款。

**主动广播节点**（按「全群是否需要知道或行动」分级，不设则数上限）：活动发布／成团确认／重要安排变更／开始／结束／结算发布／已结清收尾，加上截止前与预计结束两条时间提醒。一场典型活动约 6–8 条，分散在数天。同一事实以内容派生的 `dedupe_key` 配合 `INSERT OR IGNORE` 去重——这是去重，不是限流；`audit.append` 的 `before == after` 短路也天然挡掉无效变更。逐笔报名、退出审批、认领、款项申报不广播，改由被动查询或（开启 `KANBAN_BOT_PERSONAL_QUEUE` 后）private 通道处理。

**被动查询**：`@bot /活动`、`/名额`、`/待办`、`/签到`、`/结算`、`/我的`、`/帮助`，可加活动 id 前 8 位指定活动；只 @ 不带指令时回当前活动卡（最快捷的报名入口）。`/待办` 直接映射 `boardTodos()` 那套既有聚合，不新增数据模型。指令面板 `/v2/panels` 与 keyboard 按钮为可选项，需在管理端核对 API 格式后开启。

**启用顺序**：① 部署 `deploy/qgroup-bot.service` 与 `deploy/bot.env.example`（`/etc/qgroup/bot.env`，root 0600）；② 建静态系统账号 `qgroupsvc` 并让两个 service 都改用同一 `User/Group`——`qgroup` 这个名称已被 systemd 的 `DynamicUser` 占用（nss-systemd 动态提供，不能 useradd），且两个不同使用者会互相 chown 掉同一个 SQLite；systemd 首次启动会把旧的 `/var/lib/private/qgroup` 自动迁移到 `/var/lib/qgroup`，不用手动搬库；③ 在**主服务**环境（`/etc/qgroup/qq.env`）加 `KANBAN_BOT_ENABLED=1`；④ 先以 dry-run 观察 outbox 内容，确认后再设 `KANBAN_BOT_DRY_RUN=0`。bot 行程需要 `websockets`，主服务仍只有标准库依赖；Debian 12 未装 `python3-venv` 时 `python3 -m venv` 会因缺 ensurepip 失败，改用 `python3 -m venv --without-pip .venv-bot` 再 `pip3 install --target .venv-bot/lib/python3.11/site-packages websockets`。

**本版刻意未做**：身份绑定（事件 `union_openid` 实测为空、QQ 互联仍在审核）→ 因此 `@bot` 直接报名、`/我的` 回个别金额、@ 特定成员、私聊个人化金额都还不能用，前者一律回一次性站内链接；结算卡默认只给站内链接，逐人金额需显式设 `KANBAN_BOT_SETTLEMENT_DETAIL=1`，收款码图片（私有 `image_assets`，须走富媒体分片上传 `msg_type=7`，不能用图文卡片 `pic_url`）留待上线时调整；前端「同步到群」逐次勾选尚未做，目前由环境变量与 `KANBAN_BOT_BROADCAST_KINDS` 控制。**默认群消息不含昵称、账号 id 与个别金额**；但显式开启 `KANBAN_BOT_SETTLEMENT_DETAIL=1` 后，结算卡会列出参加者姓名与应付金额，等于在群里公开金流信息，开启前须确认群成员都同意，并在隐私政策与群内告知监听全群对话这件事。

测试：`python3 -m unittest discover -s tests -p 'test_bot_*.py'`。全套 Python 测试分别在 `KANBAN_BOT_ENABLED` 关闭与开启两种状态下各跑一遍，确保新挂载点不影响任何既有业务路径。

## 访问与交互统计

首页、活动详情、操作说明、隐私政策、联系页、管理后台及 QQ 回调说明（含简繁版本）使用 Umami（`https://u.danndann.cn`），仅在 `kanban.danndann.cn` 发送统计，本地开发不发送。统计客户端异步加载，不阻塞看板启动。共用 `public/analytics.js` 委派记录动态按钮／链接点击、字段编辑和选择、表单提交与验证失败、展开收合、弹窗开关，并由 `public/client.js` 及 `public/admin.js` 记录写接口的成功、拒绝、网络错误及响应解析失败。`ui_submit` 表示提交尝试，`api_result` 才表示对应网络请求结果；自动刷新不计为交互，密码输入不记录编辑或验证事件。

使用手动页面统计避免重复：首页为 `/`、活动详情统一为 `/event`，其他页面使用固定公开路径。仅发送系统控制项标识、所在界面、语言、勾选状态及去除记录 ID 的接口类型与状态，不发送用户输入、姓名、金额、活动／账号／设备 ID、邀请或登录凭证。关闭 Umami 自动追踪，事件与页面载荷均覆盖原始 URL、标题和来源；统计脚本加载失败不影响功能，待发事件最多暂存 100 条。新增交互优先沿用已有 `data-*` 动作；新增动作值须同步更新 `analytics.js` 的白名单。

## 简繁适配

按 HTTP Accept-Language 的最高优先语言选择：zh-CN、zh-SG、zh-Hans 为简中；其余（包括英文、日文、缺省）为繁中。界面、帮助、表单提示和系统消息统一适配，用户输入及历史原文保留原样。无需登录，不新增语言开关或数据库迁移。

修改界面源文件、后端系统消息或手册后，运行 `python3 deploy/build_guide.py` 与 `npm run build:locales`，一并发布 `public/locales/` 和 `qgroup_core/locales.json`。构建依赖 Node.js 22.18+（或 24.11+）、npm、Python 及 markdown-it-py；生产运行仍只有 Python 标准库。不要直接修改生成的文件。新增动态系统消息时须在 `qgroup_core/i18n.py` 明确系统片段与用户变量边界并测试；不能对 API 或 DOM 全文转换。分类及状态保留原协议值，仅转换展示标签。

图片及收款码契约见 [结算契约](docs/settlement-contract.md)；生产新图片目录 `/var/lib/qgroup/images/` 由现有 DynamicUser／StateDirectory 管理，按原 API 验证权限后读取，不由反向代理直接暴露。更新应用无需改 1Panel 或服务沙箱配置。


QQ 服务配置从可选的 `/etc/qgroup/qq.env` 读取（root 所有、0600）；不把密钥写进 systemd 服务正文、前端、日志或数据库。生产 `KANBAN_ORIGIN=https://kanban.danndann.cn`，回调 `https://kanban.danndann.cn/auth/qq/callback`。详情见 [身份契约](docs/identity-contract.md)。本地测试通过伪造官方响应验收，不能据此声称审核通过或真实 QQ 授权成功。


正式公开前，按用户确认封存并清空整套测试数据（账号、活动、报名、账务与图片）。先停止服务，再执行 `deploy/reset_test_data.py --database /var/lib/qgroup/kanban.sqlite3 --archive /var/backups/一个新目录 --confirm-test-data`，由原 systemd 服务创建新数据库，不以 root 初始化实时库。封存与日常备份均须保留，恢复时成套还原。管理凭证原文仅保存于本地 `artifacts/private/`（目录 0700、文件 0600），不会随部署包上传；轮替服务器摘要即可撤销旧凭证与管理会话。
