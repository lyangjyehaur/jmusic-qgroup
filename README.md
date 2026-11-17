# 群聚看板

看板與成分的單一產品重構規劃（2026-11-18，隔離實作中、尚未發布；發布範圍 `none`）見 [重構文件入口](docs/unified-rebuild/README.md)，包含現有功能保留矩陣、統一操作流程、React／TSX 與 TypeScript 架構，以及資料遷移／驗收計畫。最新檢查點為[成分關聯與 PIN 回執持久化](docs/unified-rebuild/71-durable-admin-ownership-checkpoint.md)及[成分刪除後原操作核對](docs/unified-rebuild/72-erased-music-acknowledgements-checkpoint.md)，仍在隔離開發與驗收階段。

原始碼倉庫：[git.dan.tw/dan/jmusic-qgroup](https://git.dan.tw/dan/jmusic-qgroup)（公開）與 [GitHub lyangjyehaur/jmusic-qgroup](https://github.com/lyangjyehaur/jmusic-qgroup)（公開），主分支為 `main`。兩邊保存相同提交及完整 main 歷史，提交 SHA、作者和時間不變。推送原始碼不會自動部署，線上更新仍按下方 server2 部署與保全流程進行。資料庫、使用者上傳圖片、伺服器環境設定及本機管理憑證不納入 Git。

本機 `origin` 保留 git.dan.tw 作為抓取及發布來源，設定兩個 push URL，使 `git push origin main` 同步推送兩邊；另有 `github` remote 供單獨核對與重試。Git 設定不隨 clone 傳遞，新 checkout 須確認／補上雙遠端設定。兩邊推送非原子操作，完成後須核對兩個遠端 main 的 SHA；其中一邊失敗時補推並再次核對，不把單邊成功當成同步完成。

功能分支驗證後先整合並推送 `main`；正式新版本只從遠端 main 歷史中的明確提交建置。發布前必須執行 `deploy/check_release_source.py`，不從未合併功能分支或未提交工作目錄直接上線；詳見[分支與發布來源](docs/deployment-policy.md#分支與發布來源)。

面向群组成员的轻量活动报名与管理网站，支持唱歌、聚餐、运动、出游等活动，手机优先。首页直接显示活动，卡片进入详情。默认只显示基础发起、本人报名与结算；同行／代报、名额与期限、协办、账本及特殊分摊等收于各页「高级选项」开关。开关只控制显示，不清空已设置的数据和规则。

使用说明可从首页底部「操作说明」进入，或打开 [在线说明](https://kanban.danndann.cn/guide.html)。源文档见 [操作手册](docs/user-guide.md)：包含发起／本人报名、同行与代报、整组候补、退出审批、报名认领、改期、现场补录和结算更正，末尾附可复制到群内的简版说明。适用版本 20261109-events1。

已实现 P0–P5 功能，以及不依赖 QQ 的代报认领、账号冲突处理与跨设备授权：逐人／代报／同行、正式与候补、整组排队、退出审批、草稿、安排版本与逐人确认、实际时间、协办与转交、现场出席、归档，逐人费用分摊、多人合付、消费凭证，完整结算版本历史，以及预收、实收、退款与墊付账本。

完整计划见 [实施计划](docs/implementation-plan.md)，接口见 [报名契约](docs/roster-contract.md) 、[P2 活动契约](docs/activity-contract.md)、[P3 结算契约](docs/settlement-contract.md) 与 [P4 收付款契约](docs/finance-contract.md)。P5 增加活动／结算（含图片）／款项本机草稿、未知操作查回与安全重试、动态待办、活动复制与导航，详见 [P5 恢复契约](docs/experience-contract.md)；QQ OAuth 登录、回调及账号绑定已实现，应用审核和真实授权仍待确认。

新增[活動時間投票](docs/time-poll-contract.md)：至少 2 個候選日期或精確時段，無固定選項數量上限、月曆點選不連續日期、按需添加選項、逐項意願及改票、發起者定案後建立正式活動。投票不占報名名額；新投票預設開啟 QQ 群通知，定案後沿用同步設定，也可手動分享連結。涉及共用 schema 16–18 與 outbox，發布範圍為 `both`。

新增[合作方公開活動唯讀 API v1](docs/public-api.md)：提供已發布公開活動、逐人報名與站內帳號 ID 對照、預分／實際包間安排；整組查詢須帶合作方 Bearer 金鑰，由後端串接。未設定金鑰即停用。獨立於瀏覽器 API，不提供 QQ 識別碼、報名備註、出勤及款項。2026-11-14 已按 `web` 單邊部署，bot 原容器未變；詳見[發布紀錄](docs/releases/2026-11-14-partner-api.md)。

可選的[成分站與舊帳號關聯](music_site/README.md)以獨立容器和資料目錄提供 `/music/`，沿用原 QQ 互聯回調。既有有效且唯一的人工看板 ID 可直接沿用，其他舊會員經原口令與 QQ 授權建立對照；未設定轉接金鑰時入口停用。活動、報名、帳務及 bot 契約不變。

## 本地运行及验证

Python 3.9+ 及系统 IANA 时区数据库，无第三方运行依赖。

```sh
npm ci --ignore-scripts
python3 deploy/build_guide.py
npm run typecheck
npm run build
python3 server.py
python3 -m unittest discover -s tests -q
node --check public/app.js
node --check public/client.js
node --check public/roster.js
node --check public/activity.js
node --check public/time-polls.js
node --check public/settlements.js
node --check public/finance.js
node --check public/identity.js
node tests/test_dates.js
node tests/test_board.js
node tests/test_time_polls.js
node tests/test_settlement_payload.js
node tests/test_client.js
node tests/test_todos.js
node tests/test_i18n.js
node tests/test_analytics.js
node --check public/storage.js
node --check public/experience.js
```

打开 http://127.0.0.1:8791，默认数据库 `data/kanban.sqlite3`，首次启动无测试活动。当前 218 项后端测试，另有时区、结算表单、持久化重试及角色待办的 Node 测试；测试使用隔离临时数据库。

## React 與 Yahha UI

主站、成分站與兩邊管理頁使用 React 19.3.1 和 [Yahha UI 0.2.0](https://github.com/didilili/yahha-ui)。按鈕、欄位、核取方塊、開關、單選組、分段選項、頁籤、展開區塊、彈窗、提示、頭像、圖片、卡片與文字排版直接使用套件元件，版面與響應式設定放在 `ui/`。元件用途、相容接法與檢查範圍見 [UI 元件對應](docs/ui-components.md)。成分站支援淺色與深色主題。

看板主站與管理後台已完整改為 `ui/board/` 的 React TSX：列表、活動表單、報名、分房、結算、帳務、時間投票、帳號與後台設定直接以 hooks 管理狀態，使用 Yahha 元件。`public/index.html` 與 `public/admin.html` 只保留掛載入口；建置不再載入舊畫面控制器、HTML parser 或 DOM 轉接層。`public/storage.js`、`client.js`、`i18n.js` 保留為非畫面服務，沿用 IndexedDB 草稿、冪等重試、API 與 bot 連結契約。舊畫面控制器暫留作行為比對，修改看板互動請編輯 TSX 原始碼。簡繁系統文案在建置時轉換，使用者資料與協議值不轉換。

成分站採漸進遷移：「已選詞條／熟悉程度」、儲存列與回到頂部已改為 `ui/music/SelectionPanel.tsx` 的直接 TSX 元件。React 透過 `useSyncExternalStore` 訂閱唯一的選取資料來源，分類與收合使用 hooks；這些區域不經 HTML 轉換或隱藏 DOM 模型。其餘成分頁面、成分管理頁及靜態說明頁仍透過 `ui/react-view.tsx` 與 `deploy/react_controllers.mjs` 接入，後續逐區移除轉接。React 原始碼統一使用 TypeScript／TSX，`tsconfig.json` 啟用 `strict`；活動、報名、投票、結算、帳款、管理介面與成分選取狀態均有共用型別。API 請求的回傳型別在呼叫端明確指定，這是編譯期契約，不取代伺服器驗證或執行期資料檢查。`npm run typecheck` 檢查全部 `ui/` 的 TS／TSX（包括舊頁面轉接層），建置與 UI 回歸測試會先執行型別檢查。原生 JavaScript 控制器仍依上述範圍逐步遷移。不能手改壓縮產物。

建置需要 Node.js 22.22.3+；線上 Python 服務不需要 Node。初次安裝執行 `npm ci --ignore-scripts`，再執行 `npm run build`，會產生簡繁控制器、兩站的 React 模組與 CSS，最後更新簡繁 HTML。更新手冊時先執行 `python3 deploy/build_guide.py`，再執行完整建置。產物 `public/ui/`、`public/ui.css`、`music_site/public/ui/`、`music_site/public/ui.css` 必須與原始碼一起提交，現有 Dockerfile 會直接打包。元件及執行期依賴已鎖版，MIT 授權與第三方聲明隨靜態資源提供。

```sh
npm run build
npm run check:ui
npm run test:ui
```

瀏覽器回歸測試使用隔離 SQLite／JSON、模擬 QQ 與本機 HTTP 服務，涵蓋實際報名提交、同行增刪與重新開啟、包間、結算發布、款項登記、時間投票、彈窗選單、成分保存、管理操作、深色模式及手機版。可用 `CHROME_BIN` 指定 Chromium；macOS 預設尋找 Google Chrome，否則使用 `npx playwright install chromium` 安裝的瀏覽器。畫面輸出在忽略版控的 `artifacts/yahha-ui/`。需支援 ES2022、CSS layers 與原生 dialog 的現代瀏覽器。

此次 UI 變更的發布範圍為 `web`，並包含獨立 music 服務的靜態檔案與 `.mjs` MIME 支援；沒有 schema、outbox 或 bot 契約變更。主站模組依既有 Accept-Language 選擇簡繁版本；使用者輸入不做文字轉換。正式發布須依發布規則驗證實際的新舊服務組合，實際版本與結果記錄於 `docs/releases/`。

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

管理员可在 `/admin` 的「用户管理」查看、搜索账号，并设为或撤销管理员。被授权的账号登录后直接访问 `/admin`，无需再输入管理凭证；撤销权限立即生效。首次授权仍使用独立管理凭证登录，作为恢复入口保留。账号方式退出后台时会同时登出当前账号。

管理员账号也可在有权查看的已发布活动详情点「管理员协助编辑」，协助更正名称、时间、地点、说明等；须填写原因，保留修改前后及管理员操作记录，并通知发起者。时间、地点等重要变更仍需参加者重新确认。费用、可见性、群同步与自定义退出期限仍由发起者处理；跟随报名截止的退出期限可随改期同步。不会取得活动所有权、报名管理或财务权，也不能借此编辑私有草稿、绕过邀请访问或重写已实际结束／取消／归档及已结算的活动。详情见活动契约。

用户管理还可维护仅管理员可见的内部备注（最多 1000 字）及手动关联 QQ 号（5 至 12 位数字）。可按备注或 QQ 号搜索；同一 QQ 号只能手动关联一个账号，清空保存即可解除。手动关联不验证 QQ 所有权，不改变登录、第三方绑定或账号合并，也不进入对外 API；账号注销时删除。多人编辑有独立版本检查，冲突时保留输入，可重新载入已保存内容后核对。

用户管理同时显示 QQ UnionID 的取得状态，可筛选已取得、待补齐或未绑定 QQ。已绑定 QQ 但缺少 UnionID 的旧账号会收到重新登录引导，直接使用原 QQ 授权即可补齐，无需先登出；引导会说明对 bot 账号识别功能的影响，并允许稍后处理，24 小时内不重复自动提醒。「账号与设备」保留手动更新入口，QQ 未返回 UnionID 时仍保留原账号并显示结果，不强制反复登录。

「允许免第三方登录注册」默认关闭。开启才允许仅填称呼创建浏览器账号，后端同样检查；再次关闭保留已有账号。该类账号丢失所有 Cookie／授权设备前应先绑定 QQ，否则不能仅凭称呼找回。详见 [身份契约](docs/identity-contract.md)。QQ 实际授权仍返回 100008「该网站尚未开通 QQ 账号登录」，待平台开通后做真实验收，再向群友公开。

公开活动的称呼、备注、账务对访问者可见；邀请模式对列表、详情、历史、图片统一验证。邀请可转传，不证明 QQ 群成员身份。站内通知及复制摘要供人工转发；可选的 QQ 群机器人见下节，默认关闭。页面每 30 秒刷新，写入、审计、通知、请求结果及机器人待发消息在同一事务提交。

## server2 部署与保全

发布范围、单边更新条件、混合版本验证及回退规则见 [Web／bot 发布与相容性规则](docs/deployment-policy.md)。项目级 `AGENTS.md` 也引用同一份规则；以经过验证的 web／bot 版本组合为准，不强制两边同版。当前 Compose 仍共用 `QGROUP_TAG`，独立版本锁定及自动发布检查尚未实现。

- 网站：https://kanban.danndann.cn
- 应用 `/opt/qgroup`，由 **Docker Compose** 管理：`qgroup-web` 与 `qgroup-bot` 两个容器共用同一个 `qgroup:<tag>` 映像，只差启动命令；同一静态账号 `qgroupsvc`（994:992）非 root 运行，容器只读根文件系统。
- 后端仅监听 `127.0.0.1:8791`。容器刻意用 **host networking**：`server.py` 的限流只在来源为回环时才信任反向代理的 `X-Real-IP`；改用 bridge 发布端口会让所有访客都来自 Docker 网关，限流退化成全局共用。`1Panel` 上游因此一行都不用改。
- 数据库 `/var/lib/qgroup/kanban.sqlite3` 连同 `images/`、`-wal`、`-shm` 以 **bind mount** 挂进两个容器（容器内路径相同）。不能换成 named volume：宿主 `qgroup-backup.service` 直接读这个路径。原 `DynamicUser` 时代的 `/var/lib/private/qgroup` 已由 systemd 自动迁移过来，不要再往 private 路径找库。
- 密钥仍放 `/etc/qgroup/qq.env`、`admin.env`、`bot.env`（root 0600），由 `env_file` 注入；不进映像、不进构建上下文、不进 Git。非密钥设定放 `/opt/qgroup/.env`（不进 Git，见 `deploy/compose.env.example`）。
- 反向代理、TLS 由用户通过 **1Panel 标准流程**管理；目标 `http://127.0.0.1:8791`，使用现有通配符证书。不要手写 OpenResty 配置。
- `deploy/qgroup.service` 与 `qgroup-bot.service` 保留为 **systemd 回退路径**，Docker 上线后停用但不删除；`qgroup-backup.timer` 与备份脚本不受影响。容器以 `restart: unless-stopped` 随 Docker 开机自启，不需要额外 systemd unit。

```sh
# 常用维运（在 /opt/qgroup 下）
docker compose config -q                 # 校验设定；勿用 config 完整输出，会印出密钥
docker compose build web                # 建置 qgroup:<QGROUP_TAG> 映像
docker compose up -d                    # 启动 web + bot
docker compose ps
docker compose logs -f web              # 或 bot
docker compose up -d --force-recreate bot # 修改 env_file 后重新载入环境
docker compose down                     # 停止容器，不改动任何资料
```

每次升级先按发布规则确定 `web`／`bot`／`both` 范围并记录当前版本组合，执行来源检查，再备份代码及 SQLite，以正式备份的隔离副本演练所需迁移，然后将明确提交的封存包上传到新的干净暂存目录、建置新映像并更新选定服务。上方整组 `up -d` 适用于成套启动／相容升级；不相容变更须按发布规则安排维护窗，单边发布须额外处理当前共用标签的限制。封存包只含该提交的追踪档案，**不上传数据库**。不要让旧 systemd 服务与新容器同时运行（会抢 8791 与同一个 bot 长连线），不由 root 迁移实时库。回退前先检查原版本组合与现有资料库相容；成套回退可 `docker compose down` → `systemctl enable --now qgroup qgroup-bot`，或把 `.env` 的 `QGROUP_TAG` 指回已验证的旧映像后 `docker compose up -d`。单边回退须保留另一服务的预期版本，不能直接套用整组成套指令。

```sh
# 在本机干净仓库检查来源；失败立即停止。用核准的完整 SHA 封存，勿改用 HEAD。
release_commit=$(python3 deploy/check_release_source.py --commit FULL_40_CHARACTER_COMMIT_SHA) || exit 1
git archive --format=tar "$release_commit" > /tmp/qgroup-"$release_commit".tar
# 后续上传、建置及切换须遵循保全流程；这里不会操作正式环境。
```

```sh
ssh server2 'docker compose -f /opt/qgroup/compose.yaml ps; systemctl start qgroup-backup.service'
python3 deploy/verify_migration.py source.sqlite3 isolated-copy.sqlite3
# 完整映像测试移到本机／独立 CI；不要在正式主机并行跑完整测试。
# 将已建置的明确 image ID 导出到本机，载入后核对 ID；不要重新建置候选映像。
ssh server2 'docker image save sha256:FULL_IMAGE_ID' > /tmp/qgroup-candidate-image.tar
docker image load -i /tmp/qgroup-candidate-image.tar
# 以下在本机执行，限额按本机资源调整，多个设置组合依序测试。
# 用 docker run 而非 compose run，避免注入正式凭证；正式 DB 不挂进测试容器。
docker run --rm --network none --user 994:992 --read-only \
  --memory 1g --memory-swap 1g --cpus 2 --pids-limit 256 --tmpfs /tmp:rw,size=128m \
  -e KANBAN_DB=/tmp/kanban.sqlite3 \
  sha256:FULL_IMAGE_ID timeout 360 python3 -m unittest discover -s tests -q
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
| KANBAN_PUBLIC_API_KEYS | 空＝停用合作方 API | 逗号分隔的合作方只读金钥，最多 20 把、每把 32–128 位英数／_／-；由 root 0600 的 /etc/qgroup/public-api.env 提供，修改后重新载入 web 环境 |
| KANBAN_QQ_APP_ID | 空 | QQ 互联 App ID；未配置时隐藏 QQ 入口 |
| KANBAN_QQ_APP_KEY | 空 | 仅服务器保存，禁止放前端或代码仓库 |
| KANBAN_QQ_REDIRECT_URI | ORIGIN + /auth/qq/callback | 须与 QQ 平台登记一致，只接受同源固定路径 |
| KANBAN_BOT_ENABLED | 0 | 后台尚未保存配置时的主动通知默认开关；各场活动另有群同步设置 |
| KANBAN_BOT_BASE_URL | https://kanban.danndann.cn | 群消息里的站内链接前缀 |
| KANBAN_BOT_SCHEDULE | 1 | 后台尚未保存配置时的定时提醒默认开关；默认截止前 24 小时／预计结束提醒 |
| KANBAN_BOT_SETTLEMENT_DETAIL | 0 | 1 才在群里列出逐人金额；**会同时公开参加者姓名**，默认只给站内链接 |
| KANBAN_BOT_PERSONAL_QUEUE | 0 | 1 才把点名通知排入 private 通道（尚无身份绑定，投递时会被标记为 skipped） |
| KANBAN_BOT_BROADCAST_KINDS | 空＝默认集合 | 后台尚未保存配置时的广播事件默认集合，逗号分隔 |
| KANBAN_BOT_DRY_RUN | 1 | 后台发送模式选「沿用部署设置」时，1 表示模拟，通知及查询均不实际发送 |

Compose 专属变量写在 `/opt/qgroup/.env`（不进 Git，范例 `deploy/compose.env.example`）：`QGROUP_UID`／`QGROUP_GID` 必须等于宿主 `/var/lib/qgroup` 的拥有者，`QGROUP_TAG` 是映像标签，`QGROUP_DATA_DIR`／`QGROUP_ENV_DIR` 是资料与凭证目录，`KANBAN_PORT`／`KANBAN_ORIGIN` 供 web 使用。这些值只影响容器编排，不改变应用行为。

静态文件白名单；写接口要求 JSON、同源与限流，并在事务内验证身份、版本及权限。输入在前端进行 HTML 转义。

操作手册更新后运行 `python3 deploy/build_guide.py` 生成 `public/guide.html`；仅构建时需要 markdown-it-py，线上运行不需要该依赖。

## QQ 群机器人

### 后台实时配置

管理员登录 `/admin` 后，可在「QQ 机器人」调整主动通知与指令回复开关、模拟／实际发送模式、14 类通知事件、截止提前小时数、预计结束延后分钟数、勿扰时段与时区、主动通知最短间隔，以及按事件定制消息模板。模板可插入受限变量并用示例预览，预览不投递消息；模板中的自定义文字保持原文，不随后台简繁语言转换。模板必须保留 `{url}`，不能调用代码、访问对象属性或读取密钥。

schema 13 新增配置、不可变版本历史与 bot 载入／发送间隔状态，schema 15 新增群组发现与诊断，保留既有业务记录。首次未保存时沿用部署中的通知开关、事件集合、定时提醒与 bot 模拟模式（web 与 bot 各自读取自己的 `env_file`，两份环境需一致；在后台保存一次配置后即完全以数据库为准）；后台保存后，以数据库中的设置为准，发送模式选择「沿用部署设置」时仍由 bot 的 `KANBAN_BOT_DRY_RUN` 决定。Secret、基础网址、键盘权限、逐人金额公开权限及网络配置仍留在部署环境。

「群组管理」显示 bot 收到事件的群、日志对应摘要、管理备注、最近收讯时间和最近未回复的 @／按钮操作原因。QQ 事件不一定提供群名，备注由管理员填写，保持原文，不会修改 QQ 群名。每个群可独立允许指令回复，主动通知则只选一个目标群，也可明确不选目标。新群默认停用，不能因 bot 被加入另一群就自动获得活动内容。测试群可只开 @ 回复，正式群单独接收主动通知；全局回复、广播和发送模式开关仍适用。首次保存群组设置前，仅沿用 `KANBAN_BOT_GROUP` 原部署默认群；之后以后台群组政策为准，空列表表示全部停用，不回退环境值。无原部署默认群时，可先收事件或手动添加 `group_openid`，此标识不是 QQ 群号。

群组修改与其他 bot 配置一起保存并记录历史，回覆与按钮回呼每次重查权限，无需重启。更换主动通知目标会作废旧的待送／已领用任务，避免把原群的通知转给新群；仅重排未来提醒，不补发旧公告。诊断仅保存群标识、时间及固定原因，不保存群聊正文或成员身份；最多保留最近 100 条原因，后台显示最近 20 条。群发现最多保留最近 500 个，后台显示最近 200 个以及所有已配置群；清单不代表 QQ 平台完整群列表，旧日志无法还原原始群标识，可在群里 @ 一次再刷新。

web 每次操作读取最新配置，bot 每次投递与指令回复读取最新配置；bot 每轮轮询回报已载入版本（默认约 5 秒），后台约每 10 秒更新显示，回报时间不代表 QQ 连接健康；连接与心跳是否存活另由 `docker compose ps` 的 bot healthcheck 判断。关闭通知会作废该类待送消息，不会自动回放；已经交给 QQ 的请求无法撤回。提醒规则变化会作废旧计划、重排未来提醒，不补发已错过的提醒。

普通消息保留入队时的事件事实，新版队列在发送时套用最新模板；更早版本没有事实快照的队列保留原文。定时提醒发送前重算人数和适用性。实际投递记录附配置版本，已发内容保持原样。勿扰和发送间隔仅延后主动通知、不消耗失败重试次数；间隔状态跨 bot 重启保留，指令回复即时处理。后台恢复上一版会追加新配置版本，再应用开关与排程规则，历史不会被覆盖。

独立的 `qgroup_bot` 行程通过 QQ 官方 WebSocket／OpenAPI v2 接收指令与发送通知。群回复、帮助和指令面板使用简中，指令同时接受简繁，例如 `/活动`／`/活動`、`/报名`／`/報名`、`/结算`／`/結算`、`/待办`／`/待辦`。裸 @ 显示活动；未知指令显示帮助。只回复后台明确允许的群；尚未设置群组政策时沿用 `KANBAN_BOT_GROUP`。

**公开查询与主动通知分开**：允许回复的群可查询已发布、未删除的公开活动，无需开启活动的「QQ 群同步」；列表和指定短码查询使用相同的可见性限制。邀请活动与草稿不对群公开。新建公开活动的「QQ 群同步」默认勾选，发起者可取消；既有活动保留原设置。主动通知须该场活动开启同步；开启前先核对标题、时间、地点、说明与费用。关闭同步会作废待送通知，但不影响公开活动查询；改为邀请可见则同时隐藏群查询并作废待送通知，发送前也再次验权。全局 `KANBAN_BOT_ENABLED=1` 只允许排队，不会替所有活动开启同步。

**分工与投递**：主服务在审计同一事务内写入 `bot_outbox`；挂钩异常仅记日志，不让报名或账务操作失败。schema 11 增加逐场开关、收件人、重试时间、模拟时间、实际投递内容与 claim 凭证，不重写旧业务数据。bot 不修改报名、结算或账本。改期会作废旧提醒并重排，提醒发出时重算人数。token、网络及响应解析异常逐条计入有限重试，按退避时间重试，不阻塞整批；claim 凭证阻止过期 worker 回写。网络发送后进程崩溃仍可能重复投递，不能保证恰好一次。

**常用入口**：六个主要指令为 `/活动 /报名 /我的 /结算 /管理 /帮助`；另有 `/名额 /待办 /出席`（兼容 `/签到`）、`/同行 /退出 /待确认 /确认安排 /地点 /规则 /款项 /账本 /已付款 /申报 /发起 /再约 /补报 /认领 /协办 /往期`。多场活动列出时间、短码与对应入口；可在指令后加 8–16 位活动编号。错码、歧义不会自动跳到另一场。结算可查已结束／取消的活动；`/待办` 是公开活动状态摘要，个人任务需登录网站。所有写操作都回到网站按原权限核对、预览与提交，打开链接不会自动报名、记账或审批。

**缩写查询**：@ 机器人后输入 `/缩写 yyds`（兼容 `/縮寫`、`/nbnhhsh`），可查拼音缩写的候选含义。仅将输入的缩写发送到第三方查询，结果仅供参考；详见[缩写查询](docs/bot-abbreviations.md)。

**报名名单**：单场 `/活动`、`/报名`、`/名额` 回复，以及活动发起、成团、安排变更、截止提醒和暂停／恢复报名通知，分开列出正式与候补的站内显示名称，不包含待确认、受邀及已退出者。每类按站内队列顺序最多显示 10 人，其余显示人数并提示到活动页查看；同名者各占一笔。名单不附账号、备注、联系人或付款信息。普通通知保留入队时的名单，截止提醒在发送时重算；过长模板优先保留原消息和必要明细，名单可能改为活动页提示或省略。邀请活动、草稿及已删除活动仍不对群公开。

**有人报名通知**：公开活动开启群同步，且后台允许 `registration_added`（「有人报名」）时，一次成功报名只排一则消息，分列本次新增正式／候补称呼与当前总人数。待确认转为正式／候补、接受补报邀请也适用；只填写待确认、生成邀请、编辑称呼或付款归属不触发。发起者自动报名合并在活动发布卡，不额外发报名通知。通知与业务写入在同一事务，回滚不发，重复请求沿用去重规则；不补发历史报名。新配置默认包含此类型，已保存的通知选择不会自动改变，需在后台勾选并保存；关闭后不回放已作废通知。

**模拟与重送**：后台发送模式选「沿用部署设置」且 `KANBAN_BOT_DRY_RUN=1` 时，主动消息记为「模拟，未发送」，不会伪装成已发送；被动回复与面板注册也不发送。后台明确选「实际发送」时以数据库政策为准，不再受该环境变量限制。发起者可在活动高级选项查看最近 8 条群投递记录，失败或模拟通知可手动重送；重送只新增投递任务，不重做原业务操作。切换为真实发送不会自动回放模拟记录。旧安排的定时提醒不能重送。

**查看日志**：Docker 部署用 `docker compose logs --since 10m bot`（或 `docker logs qgroup-bot`），旧 systemd unit 停用后不再向对应 journal 写入。JSON 日志同时保存到数据库同目录的 `bot-logs/bot-events.jsonl`，每档 5 MiB、共 5 档、权限 0600；现有 bind mount 保留日志，重建容器后仍可查。默认记录时间、消息／成员的摘要引用、指令、@ 判断、忽略原因、发送内容的字数与摘要、平台结果及重试，使用同一个 `trace_id` 串起异步请求；不保存群聊正文、原始身份或凭证。每次 outbox 尝试有独立追踪码，通过 `outbox_id` 对照重试。`mention_everyone=missing` 表示平台未提供字段，不能当作「不是 @全体」。短期需要核对实际内容时设 `KANBAN_BOT_LOG_CONTENT=1`，记录限长且遮罩过的指令／输出预览；普通未 @ 消息始终不记正文。详细查阅方式见 [Bot 日志排查](docs/bot-logging.md)。

**启用顺序**：① 按 `deploy/bot.env.example` 配置 `/etc/qgroup/bot.env`（root 0600，AppID／Secret／主要群）；② 主服务环境 `/etc/qgroup/qq.env` 配置 `KANBAN_BOT_ENABLED=1`；③ 隔离副本验证 schema 13 迁移，构建新映像并 `docker compose up -d`，共用 SQLite 与 UID/GID；④ 发起者选择适合群内公开的活动开启同步，在后台保持模拟模式核对记录；⑤ 验收后在后台把发送模式切为「实际发送」、先只开指令回复（`replies_enabled=1`、广播 `enabled=0`），政策即时生效、无需重建容器；只有后台选「沿用部署设置」时才改 `KANBAN_BOT_DRY_RUN=0` 并执行 `docker compose up -d --force-recreate bot`。修改 env_file 后只执行 `restart` 不会加载新环境。`websockets==17.4` 在 Dockerfile 中安装，主服务仍只需标准库。systemd 回退同样使用静态账号 `qgroupsvc`，不能与容器同时运行。

**退出与递补通知**：公开活动开启群同步，且后台允许 `registration_changed`（「退出／候补递补」）时，正式／候补实际退出（含管理者撤销）会通知群聊。同次退出触发的候补递补合并为一则，分列退出者与递补为正式者、当前总人数及开始倒计时。增加名额、恢复报名、拆分整组候补产生的实际递补也通知。逾期退出申请待审或被拒不通知；批准实际退出才通知。取消待确认或未接受的邀请不通知，整场取消沿用活动取消通知。只公开显示称呼，不附退出原因、审批备注、账号或退款资料；事务回滚、重复请求、历史资料不额外发送。新配置默认包含此类型，已保存配置需另行勾选并保存。

**后续能力**：尚未绑定 bot 与站内身份，因此不提供群内直接报名、个人金额、@ 点名或私聊通知。个人队列只保存指定收件人，未绑定不会投递，也不会转发到群。收款码富媒体、每次操作独立勾选通知仍待完成。连接／心跳健康监测已完成：WebSocket 保存 session 并支援 Resume、心跳 ACK 逾时重连，bot 将 `bot-health.json`（0600）写入 `KANBAN_BOT_LOG_DIR`，compose 的 bot healthcheck 读取同一路径。报名名单只公开显示名称，个人金额仍按单独的结算通知设置处理；`KANBAN_BOT_SETTLEMENT_DETAIL=1` 会公开逐人金额，需明确告知并取得同意后才开启。

测试：`python3 -m unittest discover -s tests -p 'test_bot_*.py'`。完整业务测试应分别在全局开关关闭和开启时运行，验证迁移、权限、双语指令、模拟、重试及既有报名／账务流程。


## 访问与交互统计

首页、活动详情、操作说明、隐私政策、联系页、管理后台及 QQ 回调说明（含简繁版本）使用 Umami（`https://u.danndann.cn`），仅在 `kanban.danndann.cn` 发送统计，本地开发不发送。统计客户端异步加载，不阻塞看板启动。共用 `public/analytics.js` 委派记录动态按钮／链接点击、字段编辑和选择、表单提交与验证失败、展开收合、弹窗开关，并由 `public/client.js` 及 `public/admin.js` 记录写接口的成功、拒绝、网络错误及响应解析失败。`ui_submit` 表示提交尝试，`api_result` 才表示对应网络请求结果；自动刷新不计为交互，密码输入不记录编辑或验证事件。

使用手动页面统计避免重复：首页为 `/`、活动详情统一为 `/event`，其他页面使用固定公开路径。仅发送系统控制项标识、所在界面、语言、勾选状态及去除记录 ID 的接口类型与状态，不发送用户输入、姓名、金额、活动／账号／设备 ID、邀请或登录凭证。关闭 Umami 自动追踪，事件与页面载荷均覆盖原始 URL、标题和来源；统计脚本加载失败不影响功能，待发事件最多暂存 100 条。新增交互优先沿用已有 `data-*` 动作；新增动作值须同步更新 `analytics.js` 的白名单。

## 简繁适配

按 HTTP Accept-Language 的最高优先语言选择：zh-CN、zh-SG、zh-Hans 为简中；其余（包括英文、日文、缺省）为繁中。界面、帮助、表单提示和系统消息统一适配，用户输入及历史原文保留原样。无需登录，不新增语言开关或数据库迁移。

修改界面源文件、后端系统消息或手册后，运行 `python3 deploy/build_guide.py` 与 `npm run build:locales`，一并发布 `public/locales/` 和 `qgroup_core/locales.json`。构建依赖 Node.js 22.18+（或 24.11+）、npm、Python 及 markdown-it-py；生产运行仍只有 Python 标准库。不要直接修改生成的文件。新增动态系统消息时须在 `qgroup_core/i18n.py` 明确系统片段与用户变量边界并测试；不能对 API 或 DOM 全文转换。分类及状态保留原协议值，仅转换展示标签。

图片及收款码契约见 [结算契约](docs/settlement-contract.md)；生产新图片目录 `/var/lib/qgroup/images/` 由静态账号 qgroupsvc 管理并挂入容器，按原 API 验证权限后读取，不由反向代理直接暴露。更新应用无需改 1Panel 或服务沙箱配置。


QQ 服务配置从可选的 `/etc/qgroup/qq.env` 读取（root 所有、0600）；不把密钥写进 systemd 服务正文、前端、日志或数据库。生产 `KANBAN_ORIGIN=https://kanban.danndann.cn`，回调 `https://kanban.danndann.cn/auth/qq/callback`。详情见 [身份契约](docs/identity-contract.md)。本地测试通过伪造官方响应验收，不能据此声称审核通过或真实 QQ 授权成功。


正式公开前，按用户确认封存并清空整套测试数据（账号、活动、报名、账务与图片）。先停止服务，再执行 `deploy/reset_test_data.py --database /var/lib/qgroup/kanban.sqlite3 --archive /var/backups/一个新目录 --confirm-test-data`，由原 systemd 服务创建新数据库，不以 root 初始化实时库。封存与日常备份均须保留，恢复时成套还原。管理凭证原文仅保存于本地 `artifacts/private/`（目录 0700、文件 0600），不会随部署包上传；轮替服务器摘要即可撤销旧凭证与管理会话。
