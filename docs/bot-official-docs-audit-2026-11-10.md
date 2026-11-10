# QQ Bot 官方文件對照審查

日期：2026-11-10。結論：目前已具備活動查詢、網站操作入口、業務通知佇列、排程、重試與日誌；正式可用仍有工程收尾，不能視為只剩 Union_openid 郵件審批。

## 範圍與證據

從官方文件前端目錄辨識 478 個路由條目；排除 index 別名等後有 422 個路由，依本專案現有及規劃用途選取 109 個網址，取得 106 個正文頁及 3 個只有標題的目錄頁。涵蓋 FAQ、運營規範、鑑權、WebSocket／Webhook、群聊／單聊 API 與事件、互動、面板／選單、媒體、錯誤碼、更新紀錄。頻道及歷史 SDK 的專屬能力未列作群聊 Bot 必需功能；Agent 教學與歷史更新亦不當作本專案依賴。

來源清單含網址、標題及抓取摘要，見 [官方來源索引](bot-official-docs-sources-2026-11-10.json)。隔離核對結果見 [重現紀錄](bot-official-docs-reproduction-2026-11-10.json)。官方索引中目前最新 API 變更為 2026-10-28。

程式以審查時線上 `qgroup:20261110-bot2-4bdfecc8e0` 容器內來源快照為基準，另核對工作區草稿。`api.py`、`worker.py`、`bot_outbox.py` 與工作區一致；工作區 `main.py` 已有額外的 UnionID 診斷草稿，不能把它當作正式身份映射已上線。審查未修改線上設定或發送測試訊息。

## 線上狀態

| 項目 | 核對結果 |
| --- | --- |
| Bot 容器 | running，重啟次數 0；有 READY 及後續群事件紀錄 |
| 實際發送 | `KANBAN_BOT_DRY_RUN=1`，入站查詢與出站推送均處於模擬模式 |
| 網站通知總開關 | `KANBAN_BOT_ENABLED=1`；開啟群同步的活動為 0 場 |
| Bot 面板／鍵盤 | 未啟用自動面板配置及選配鍵盤 |
| 個人通知 | 私人佇列未啟用；Worker 目前不發私人訊息 |
| QQ 網站登入 | 網站映像 `qgroup:20261110-unionid1-1e94c7b4ef`，health 為 healthy；已有 1 筆 UnionID |
| Bot 跨應用身份 | 使用者已送出綁定申請；尚無審批完成或真實跨端匹配證據 |
| 健康監測 | Bot 沒有獨立 healthcheck；running 或曾 READY 不能單獨證明目前心跳及投遞正常 |

群主的主動發言授權、網址發送能力、平台面板與身份綁定核准結果，不能從服務環境變數推斷。本次沒有登入管理端或使用憑證呼叫管理 API 驗證這些權限。

## 一、先修的協議與可靠性缺口

P1 表示開啟相關真實能力前應完成；P2 表示應列入近期收尾。沒有把可選平台功能混成必修項。

### A01　P1：API 回應必須兼容 err_code，避免錯標送達

現行 `QQBotAPI.post()` 只讀取 `data.code`，搭配任何 2xx 就判成功；`observability.api_code()` 也只讀 code。現行 [API 呼叫指南](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/api-call-guide.html) 明確使用 `err_code`；Token API 則仍使用 `code`，不能只把其中一種欄位換掉。

隔離重現：回應 `HTTP 200 + {err_code:40034105}`，程式返回 `ok=True, code=None`。若發送端碰到這類回應，Worker 會進入 sent 分支。這是可重現的判斷錯誤；本次未聲稱正式環境已發生過此種假成功。

修正與驗收：

- 統一解析兩種錯誤欄位，任一有效的非零錯誤碼都不能當作成功；異常／未知結構也不能默認成功。
- 依端點核對成功回應；發消息成功應保留平台消息識別資訊。HTTP 201／202 等非同步結果需要依回應判定，不能一律視為已送出。
- 更新認證重試及日誌，涵蓋兩種錯誤包、非 JSON、空包、暫時失敗及永久拒絕。

定位：`qgroup_bot/api.py:QQBotAPI.post`、`qgroup_bot/observability.py:api_code`、`qgroup_bot/worker.py:_deliver`。

### A02　P1：WebSocket 補 ACK 檢查、Resume、明確的連線健康狀態

依 [WebSocket 文件](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html)，斷線後可用 `op=6`、session_id 與已處理 seq 補收事件，心跳成功應收到 `op=11`。目前每次重新 Identify，READY 只留下 session 摘要；不保留可恢復 session，也不監控 ACK 或處理服務端要求立即心跳的 `op=1`。

風險是短暫斷線期間的指令／授權變更沒有補收，以及 socket 卡住但容器仍顯示 running。重連迴圈已存在，不能將此說成完全沒有重連。

修正與驗收：保存可恢復的 session 與已完成處理的序號；Resume 成功補收，無效 session 才重新 Identify；ACK 逾時主動重連；同時管理及取消每條連線的心跳 task。依 [網關錯誤碼](https://bot.q.qq.com/wiki/develop/api-v2/gateway/error/error.html) 區分可恢復、配置錯誤與禁止重連，遵守 Gateway 的呼叫及 Identify 頻率限制。

Bot 健康狀態應分別顯示最近 ACK、最近成功輪詢、重連及永久錯誤。群內長時間沒人發言是正常情況，不應僅用「最近沒有群消息」判斷離線。

定位：`qgroup_bot/main.py:Bot.websocket_loop/run`、`compose.yaml:services.bot`。

### A03　P1（啟用按鈕前）：互動回呼缺正式 ACK、類型分流及去重

[互動回應](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/interactions_interaction_id.put.html) 要求 type 11／12 回呼呼叫 `PUT /interactions/{d.id}`，同一互動只回應一次；發一條群訊息不能替代此 ACK。`d.id` 與用於被動發訊息的外層事件 ID 須分開使用。

現行 Bot 只解析 button_data 後回群訊息，沒有 PUT 客戶端會持續 loading；也把群內所有 INTERACTION_CREATE 當作按鈕處理，沒有區分 type 19／20 等授權事件。隔離重播同一按鈕事件兩次，reply 被處理兩次。

修正與驗收：先依互動 type／scene 分流；按鈕及快捷選單快速 ACK，授權事件另存狀態；事件冪等，拒絕／重複亦返回合適結果；進入業務前重查活動、群、身份與角色。按鈕保留活動 ID 的部分已具備。

定位：`qgroup_bot/main.py:_handle_dispatch`、`qgroup_bot/api.py`。

### A04　P1（真實推送前）：主動限流、錯誤分類與拒收狀態

[群消息規則](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)：已認證 Bot 60 條／分鐘、未認證 30 條／分鐘；每群 20 條／分鐘、每日 1000 條。群被動回覆是 5 分鐘內最多 5 次。現有 Worker 有批量、重試及退避，但沒有 Bot／群維度的主動發送限流；預設每 5 秒最多領 10 筆不能視作符合每群 20 條／分鐘。

所有失敗目前大致採同一種有限重試，沒有區分頻控、群主未授權、被移出、內容錯誤、拒收與暫時故障。`GROUP_MSG_REJECT/RECEIVE`、`GROUP_DEL_ROBOT` 及群授權變更未形成持久狀態。

修正與驗收：按群節流、爆量合併／延後；429／頻控等等待配額恢復；永久錯誤停止同一內容盲目重試；保存群可用性與推送授權，排程發送前再次核對。記錄「平台已接受」與「使用者已讀」的區別。

`bot_state` 可協助排查主動權限，但 [官方明列白名單限制](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_bot_state.get.html)，不能把可成功呼叫它當作基礎 Bot 的必然能力。缺權限時採事件及管理端人工核對，不反覆輪詢。

定位：`qgroup_bot/worker.py`、`qgroup_bot/main.py`、`qgroup_core/bot_outbox.py`。

### A05　P2（啟用面板前）：面板 API 格式需要重做

官方 [查詢](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_panels.get.html) 必須帶 `scope=group`，回應為 `records`；[建立](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_panels.post.html) 必須有 `scope`、`panel.items`，群範圍可用 `target_type=specific` 搭配 group_openids。

目前 `setup_panels()` 查詢未帶 scope，讀取不存在的 panels 欄位，建立時傳 scene／elements，缺 scope／panel。隔離抓取請求確認與現行格式不符。這個選配路徑目前關閉，因此不影響既有純文字查詢。

修正與驗收：使用現行 schema、明確項目 type、限定主要群、保存 panel_id 並可重入更新；查詢分頁及內容比對正確，不在每次重啟重複建立，也不覆蓋非本專案管理的面板。留意每 Bot 最多 20 面板及每面板最多 20 項。

定位：`qgroup_bot/api.py:setup_panels`。

### A06　P2：對齊統一 API 網域與平台 TraceID

2026-08-10 [更新紀錄](https://bot.q.qq.com/wiki/develop/api-v2/changelog.html) 指出統一 `api.bot.qq.com`。目前正式 API 主站仍為 `api.sgroup.qq.com`，Token 先嘗試 `bots.qq.com`。應以現行主站優先，舊站是否保留相容要明確設定；沒有證據顯示舊站目前全面停用，不能把它寫成已無法運作。

目前日誌有本機 trace_id／request_ref，但 HTTP 回應頭 `X-Tps-trace-ID` 與回應中的平台 trace_id 沒有保存；這些與自己生成的 trace_id 不同，聯繫騰訊時需要平台追蹤碼。補齊時繼續遮蔽 token、OpenID、UnionID 與原始請求內容。

定位：`qgroup_bot/api.py:http_json/post`、`qgroup_bot/observability.py`。

### A07　P2：去重會吞掉合法重問；全量模式的 @ 辨識依賴未保證欄位

目前文字指紋不包含消息時間或來源事件類型，同一人在 30 秒內重新發相同指令，即使 message_id 不同也會被當作重複。隔離測試兩筆不同 ID 的 `/活动`，第二筆確實被忽略。

[全量群消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html) 的 mentions 文件列出 User 結構，未保證有 `is_you`。目前只有 `mentions[].is_you=True` 或 GROUP_AT_MESSAGE_CREATE 才算被 @；只收到標準結構的全量 @ 事件時會忽略。隔離事件已重現，但本次未將真實群消息誤判為已驗證遺失。

修正與驗收：保存 Bot 自己在目前群的身份，按官方提及資料核對；以消息 ID 為主，跨兩種事件的去重限定同一事件對應，不封鎖正常重問。將純文字 @、全量消息、@其他人、@全體、卡片／附件及引用消息列入用例。只有準備支援附件或引用內容時，才解析對應結構，無法識別時給明確提示。

定位：`qgroup_bot/main.py:duplicate/_handle_dispatch`。

## 二、Union_openid 審批後才開放的個人能力

### B01　身份映射

官方 [FAQ](https://bot.q.qq.com/wiki/bot_FAQ/#q-如何申请开通机器人union-openid) 說明相同主體及主應用 AppID 綁定；[群消息 User](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html) 和 [好友事件](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/friend_add.html) 有可能提供 union_openid。

網站已保存 OpenID 與實際返回的 UnionID；下一步以同一人真實事件確認 Bot 返回身份與網站識別碼的對應規則，再建立按 Bot AppID／主應用作用域隔離的映射。FAQ 未明確承諾 `union_openid` 必然與網站 `/me.unionid` 逐字相等，因此必須驗證，必要時依核准綁定的主應用 OpenID 對照，不可用「欄位名稱相近」代替證明。

工作區的 UnionID 診斷只判斷是否出現及是否命中，尚未建立用於授權的映射。不要拿全庫不分 provider／client 的匹配結果授予操作權。缺失、衝突、解除與註銷均須有清楚處理；沒有匹配時回站內登入，不根據暱稱或 QQ 頭像猜帳號。

### B02　私聊及個人通知

現行私聊事件未處理，沒有 `/v2/users/{user_openid}/messages` 投遞路徑；private outbox 會被 Worker 作廢。已有 recipient_user_id 是良好基礎，但不等於私聊已完成。

依 [單聊接口](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)，收件路由需使用真正的 C2C user_openid；不能把群 member_openid 或 UnionID 直接放進 URL。識別本人也不代表已建立可發送的私聊關係或取得推送授權。

需要接上好友新增／刪除、C2C 拒收／允收、必要的訂閱授權；依平台主體與開放範圍核對可使用的私聊對象。個人主體的開放範圍限制見 FAQ，不能假設全體群友皆有私聊能力。

單聊被動回覆為 60 分鐘內最多 4 次，規則與群聊不同。私聊不可用時維持站內入口，不把個人應付、退出原因或認領憑證改發群裡。佇列宜區分未綁定／未授權／暫時失敗；不自動補發過時款項或已完成待辦。

### B03　直接群內報名及管理操作

目前 `/报名`、`/已付款`、`/管理` 等只提供網站入口，沒有代替網站寫入；這與幫助文案一致，並非協議缺陷。身份打通後若增加直接操作，仍需活動選擇、最新版安排及名額預覽、本人／同行範圍、最終確認、角色校驗及持久冪等。

協辦權按網站授權決定，不能因平台 member_role 是群管理員，就取得某場活動管理或財務權。本人報名、代報、付款責任人亦不能只靠同一個 QQ 識別碼混為一個角色。

## 三、適合增加，但不用全部實作的平台能力

| 能力 | 文件現況及建議 |
| --- | --- |
| 精簡 Markdown 活動卡＋按鈕 | FAQ 與 [Markdown 文件](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/markdown.html) 確認，自 2026-04-23 群聊／單聊自訂 Markdown 已向全部 Bot 開放，不用另申請模板。建議短摘要＋活動入口＋查看名額，保留純文字退路 |
| 鍵盤相容性 | 舊按鈕頁寫基於 Markdown，新群消息 schema 廣泛列 keyboard 欄位。不能僅據舊頁斷言文字＋鍵盤必定失效；優先交付明確示範的 Markdown＋鍵盤，再用手機實測。按鈕 ACK 需先修 |
| 私聊底部選單 | [全域 menu](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_menu.put.html) 僅支援 C2C，不能代替群面板。私聊上線時可放我的活動、網站及幫助；近期先做群面板 |
| 新增圖文卡片 | 2026-10-28 新增 msg_type=8。適合將來的活動分享，非現階段必需。現行 Worker 未放行 card 欄位，不能只切換 msg_type 就宣稱支援 |
| 收款碼／圖片 | 有 [富媒體上傳](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_files.post.html) 與 [素材管理](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/material-management.html)，無須將私人圖片改成公開 URL。後端驗權後上傳正確帳單版本；群／單聊媒體不互通，file_info 有 ttl。Markdown 素材有 100 張配額及 90 日滑動時效，與一般富媒體 ttl 不同 |
| Bot 加好友分享連結 | [generate_url_link](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_generate_url_link.post.html) 可加 callback_data，最多 32 字元；適合作為私聊入口。來源參數不是身份證明，不直接拿來綁帳號 |
| 撤回舊消息 | 官方只支援 2 分鐘內撤回；目前只記發送 ID 摘要，不具備可操作的撤回紀錄。可選擇短期保存受控消息 ID；活動入口始終顯示最新版本，不依賴隨時能撤回舊卡 |
| 群成員／群資料 | 群名單、成員資料、bot_state 等部分接口仍內邀／白名單。不要設計成報名或身份映射必須先完整拉取群名單 |
| 群管理、禁言、踢人、入群審批 | 文件已有接口，其中部分需群管理員與白名單。與約 K 看板目前目的無直接關係，無須擴成群管機器人 |
| 頻道日程、論壇、表情表態、Embed | 屬頻道能力，不能當成一般 QQ 群可用的活動日程或群投票。當前不需要補 |
| Webhook | 官方同時支援 WebSocket 與 Webhook，未找到本次文件要求停用 WebSocket 的規定。可選擇保留並補強 WS；若之後轉 Webhook，才需 HTTPS、地址驗證、Ed25519 原始 body 驗簽與防重播。現階段不為它改代理設定 |
| AI／Agent／流式回覆 | 本 Bot 是結構化活動工具，不依賴 OpenClaw 或 AI；流式接口只在單聊可用，無須為查活動加入 Agent 層 |
| @全體成員 | 新語法 `<qqbot-at-everyone />`，需群管理員且每群自然日 1 次。當前優先避免刷屏，不把 @全體作必需通知方式 |

## 四、運營與產品收尾

[運營規範](https://bot.q.qq.com/wiki/business/) 與目前程式相關的實際事項：

- Bot 幫助應提供能找到的運營聯繫、隱私及投訴入口；網站已有對應頁面，Bot HELP 尚未明確列出。平台要求功能指引和有效聯絡渠道。
- 活動標題、地點、注意事項和費用說明均是使用者原文。現有逐場開關及公開性檢查是基礎；廣播預覽、長度／控制字元處理、違規內容拒送與可追蹤原因仍應補齊。若採 Markdown，須防止原文意外變成其他跳轉、提及或按鈕語義。不要宣稱現有群摘要已完全去除個人資料。
- 目前一旦開啟活動群同步，預設的重要節點都可排隊；之前計畫的「每次操作獨立選擇是否同步」尚未全面實作。應保留精簡預設，在高級選項提供預覽與覆寫，避免再增加常駐勾選框。
- Bot 身份映射、私聊授權、私人資料刪除、待送通知與撤權，需要與網站註銷及政策說明同步。這是新增能力上線時的必要配套，不能因網站有舊政策就視為所有 Bot 使用情境已涵蓋。
- 網站導覽功能與 Bot 對外簡介應一致，清楚標示尚未替使用者報名／付款。運營規範有關依賴其他應用的文字，需在平台審核或答覆有疑義時核實配套網站使用方式；本次沒有據此判定現有網站入口已違規，也不以它作停止開發的理由。
- README、舊審查與部分計畫仍有「QQ 未審核／未部署」等過時狀態。以實測與發版紀錄更新，區分網站 QQ 登入、Bot 身份綁定、Bot 真實群回覆三條進度。

## 五、建議落地順序與驗收

| 批次 | 內容 | 可驗收的結果 |
| --- | --- | --- |
| 1：協議與收發可靠性 | A01–A04、A06–A07；保留模擬開關 | 新舊錯誤包都判斷正確；重連可補收；心跳失效能恢復；按鈕不轉圈；重問不被吞；限流及拒收可追蹤 |
| 2：手機上的主要入口 | A05、精簡 Markdown 卡、幫助／聯絡入口、廣播預覽 | 手機可從面板選活動，卡片短且可點，純文字仍可用；群主權限／網址能力核對後驗收一次真實回覆與一次選定通知 |
| 3：平台批准後的身份與個人通知 | B01–B02；可先實作等待授權及資料模型 | 同一人的 Bot 事件可靠對應原帳號；私人狀態只到授權本人；未授權時返回站內，不改發群聊 |
| 4：有限直接操作 | B03；媒體按需求加入 | 重複事件、重啟、版本衝突不重複報名／申報；同行、候補、付款責任與網站一致 |

可在郵件等待期間先完成批次 1／2 的程式與離線驗證。真實發送是獨立的上線步驟，不能把模擬紀錄當作平台已接受的證據。

## 六、本次已做的隔離核對

全部以線上來源副本、臨時 SQLite 及 mock HTTP 進行，未呼叫真實消息接口：

1. HTTP 200＋err_code 非零：重現誤判成功。
2. 面板建立請求：確認缺必填 scope／panel。
3. 兩筆不同消息 ID 的同內容指令：重現 30 秒內合法重問被忽略。
4. 同一互動事件重播兩次：重現回覆處理兩次。
5. 官方結構的全量 @ 消息、未提供 is_you：重現不處理。
6. 兩場同時建立、同時間的活動：兩場各自都有發布及兩種提醒，確認沒有跨活動去重吞消息；沒有將此列作缺陷。

以上是功能對照審查與針對性重現，並非本輪修改後的全套驗收。上線前仍需新實作測試及真實手機／平台驗證。

## 七、2026-11-10 19:30 修補進度（本輪）

依本報告的批次 1 先修協定與可靠性；**只動程式與離線測試，未部署、未切換真實發送、未發任何測試群訊息**。

| 項目 | 狀態 | 落地 |
| --- | --- | --- |
| A01 `err_code` | 已修 | `observability.api_code()` 同時讀 `code`／`err_code`；`api.post()` 對 HTTP 200 + 非零錯誤碼、非 JSON／空包、201/202 異步結果一律不判成功，異步結果標 `_unconfirmed_http` 由 Worker 轉「未確認、需人工核對」而不重發。平台 `X-Tps-trace-ID` 與回應 `trace_id` 保存於日誌，憑證與原始識別碼仍不外洩 |
| A02 WS 健康 | 已修主體 | READY 保存 `session_id`／bot `user.id`／seq；`op=6` Resume、`op=11` ACK、`op=1` 立即心跳、`op=9` 清 session；心跳 task 可取消、ACK 逾時主動重連；`bot-health.json`（0600，路徑跟 `KANBAN_BOT_LOG_DIR`）記錄最近 ACK／READY／輪詢與實際生效政策，`compose.yaml` 的 bot healthcheck 已接上並讀同一路徑。官方未載 `op=9` 的 `d` 語意，採保守清 session |
| A03 互動回呼 | 已修 | `INTERACTION_CREATE` 依 type 分流（11/12 按鈕；18/19/20 授權另記）；先 `PUT /interactions/{d.id}` 帶 `{"code":0}` 再處理業務，`d.id` 與外層 `event_id` 分開；`interaction_id` 10 分鐘去重 |
| A04 限流與分類 | 已修 | 沿用版本化政策的 `reserve_send`（勿擾時段／最小間隔，跨輪詢與重啟持久）與 `deferred`；新增錯誤分類：頻控等待配額、內容／去重／長度類永久拒絕停止重試、群授權類寫入私有 `bot-group-state.json` 並保留有限重試。主動訊息另加控制字元、4000 字與 URL 白名單（顯式設定才啟用）檢查 |
| A05 面板格式 | 已修 | `GET /v2/panels?scope=group` 讀 `records`；建立用 `scope` + `panel.items[].type=command` + `target_type=specific`／`group_openids`；同名群面板不重複建立。仍屬選配，預設關閉 |
| A06 統一網域 | 已修 | 預設 `https://api.bot.qq.com`，`GET /gateway` 失敗自動回退已驗證的 `api.sgroup.qq.com`；可用 `KANBAN_BOT_API_BASE` 指定。Token 端點新主站優先、舊站備援 |
| A07 去重與 @ | 已修 | 指紋加入平台 `timestamp` 並正規化提及標記，合法重問不再被吞；同一 @ 的兩種事件仍只處理一次；全量模式的 @ 判斷改用 READY 的 bot `user.id` 與官方 User 結構，不再只靠未保證的 `is_you` |
| 運營收尾 | 部分 | `/帮助` 補上隱私政策、聯絡與問題回饋入口，並重申不代為報名／付款；廣播內容檢查已加。每次操作獨立預覽與選擇同步、完整角色待辦後端、Markdown 卡與手機實測仍待處理 |

**並行改動對齊**：本輪進行中，工作區同時新增 `qgroup_core/bot_settings.py`（版本化後台政策、節流、模板、schema 13）與管理後台 UI，`main.py`／`worker.py` 改為讀資料庫政策（`replies_enabled`、`dry_run`、`enabled`），目標是讓 bot 功能可在網站後台即時修改生效。因此**撤回本輪原先設計的 `KANBAN_BOT_SEND_MODE` 環境變數開關**，避免兩套開關打架；實際開放範圍以管理後台的版本化政策為**唯一事實來源**，`KANBAN_BOT_DRY_RUN` 只在後台選「沿用部署設定」時作為預設值，後台明確選「實際發送」時會覆蓋它。已順手修正 `tests/test_i18n.py` 一處縮排錯誤。

**「開放一部分」的正確組合**（尚未套用到線上）：後台設 `replies_enabled=1`、發送模式「實際發送」（`dry_run=false`），並維持廣播 `enabled=0`（或清空 `broadcast_kinds`）→ 群友主動 @ 才真回，主動廣播仍不發；確認手機實測與群主權限後再把 `enabled` 打開、逐場勾選群同步。注意 `dry_run=false` 會覆蓋部署環境的 `KANBAN_BOT_DRY_RUN=1`，這是設計而非保險失效；只有後台選「沿用部署設定」且 `DRY_RUN=1` 時才會全部模擬。

**驗證**（19:30 快照）：Python **354 項**、JavaScript **9 組**全數通過；新增 `tests/test_bot_protocol.py` 18 項（兩類錯誤包、異步 2xx、互動 ACK、面板 schema、去重與 @、白名單 opt-in、HELP 入口）。20:00 追加後台政策測試後為 **360 項／24 項**，見第八節。以上皆為離線／mock 驗證，沒有真實平台發送證據。

**仍未完成／不可提前**：B01 身份映射與 B02 私聊（等 Union_openid 核准並實機比對）、B03 群內直接寫入；真實手機面板／keyboard、URL 白名單報備與群主主動發言授權的實機核對；以及把本輪與並行改動一起提交、建置映像、schema 13 遷移演練後的上線切換。

## 八、修補統計與後台即時生效收乾（2026-11-10 20:00）

### 修補了多少

| 口徑 | 已修／總數 | 說明 |
| --- | --- | --- |
| 第一節編號可靠性缺口 A01–A07 | **7／7** | 全部有程式落地。但 A02 是「已修主體」（`op=9` 的 `d` 官方未載、Gateway 錯誤碼未逐類對齊）；A04 沿用既有 `reserve_send`，未另加 bot／群維度 QPM 硬上限；A05 面板格式已改，選配仍關閉且未實機驗證 |
| 第二節需核准的個人能力 B01–B03 | 0／3 | 等 Union_openid 綁定核准並實機比對，完全未動 |
| 第四節運營收尾條列 | 1 完成＋1 部分／6 | HELP 聯絡／隱私入口已完成；廣播內容檢查部分；每次操作獨立預覽、Markdown 卡、註銷配套、導覽一致性、舊文件狀態未動 |
| 第五節落地批次 | 1 完成＋1 部分／4 | 批次 1 完成；批次 2 部分（A05 格式已修，面板／Markdown／廣播預覽未驗收）；批次 3／4 未開始 |
| 第六節隔離重現 | 5／5 缺陷 | 第 6 項是跨活動去重的正常行為確認，原本就不是缺陷 |
| 第三節可選平台能力 | 0／13 正式採用 | 該節明寫「適合增加，但不用全部實作」，**不計入待修分母** |

因此：**審查明列需要修補的工程缺陷是 7 項，7 項全部修完**；若把需平台核准的 B 類一併算進去則是 **7／10**。第三節 13 項是可選能力，不列完成率。所有 7 項都只有離線／mock 驗證，沒有一項取得真實平台發送證據。

### 20:00 追加：讓殘留項目也跟著後台政策

原先「後台即時修改生效」仍剩三處看啟動環境，本輪收乾：

- `qgroup_bot/main.py` 新增 `resolve_dry_run()`／`refresh_policy()`／`sync_panels()`。面板註冊不再由 `config.dry_run` 決定；後台從模擬切為實際發送時，輪詢會自動註冊一次（`setup_panels` 本身冪等，不會重複建立面板），切回模擬再切回會重新觸發。DB 無 `bot_settings` 表時降級為部署預設值，只記 DEBUG，不刷警告。
- `bot-health.json` 的 `dry_run` 改記**實際生效值**，另存 `deployment_dry_run` 與 `policy_resolved`；`bot_started` 日誌同步帶兩個值。`compose.yaml` 的 healthcheck 改讀 `KANBAN_BOT_LOG_DIR`，與 `Config.log_dir` 對齊。
- `qgroup_core/bot_settings.py` 的 `defaults()` 統一 web／bot 的 `enabled` 預設（皆為 `KANBAN_BOT_ENABLED`，預設 0），避免首次未保存設定時 web 不排隊、bot 卻投遞舊佇列。`worker` 參數保留於簽名供相容，但不再分叉政策。`deploy/bot.env.example` 與 `README.md` 已提醒兩份 `env_file` 需一致，或直接到後台存一次設定。

新增 6 項測試（`tests/test_bot_protocol.py` 共 **24** 項）：政策覆蓋部署 env、無表降級、健康檔生效值、面板政策切換、web／bot 預設一致、log_dir 對齊。**全套 Python 360 項、JavaScript 9 組**全綠；`docker compose config -q` 與 `git diff --check` 通過。本輪仍只動本機程式與文件，未提交、未部署、未發任何真實群訊息。
