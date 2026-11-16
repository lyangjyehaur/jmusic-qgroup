# 程式盤點索引與差異紀錄

日期：2026-11-17。發布範圍：`none`。基線：`8da877857f163853c449474e168534e2e493121b`（本輪抓取後的 origin/main）。索引從此提交讀取原始碼，不包含工作目錄原有的頁首草稿或私人資料。

## 1. 方法與證據強度

- 檢查網站 HTTP dispatch、核心業務、成分 service 包裝與 upstream 繼承、前端入口／建置、管理頁、bot、遷移／備份及現有測試；對照契約與近期發布紀錄。
- [機器索引](source-audit.json)涵蓋 **198 個程式／設定來源**、Python 函式／類別、**743 個 `test_` 方法名稱**與部分 JS／TS 函式線索。這是靜態索引數量，不是測試執行／通過數量，也不保證每個名稱都是被 runner 收集的測試。
- 從指定提交將 Python 原始碼放進新的臨時目錄，建立合成空庫；看板初始化連續兩次。得到 **59 張看板使用者資料表、10 張成分身分表**，看板 migration 最高為 **20**，兩庫完整性 `ok`、外鍵違規 0。`sqlite_sequence` 為 SQLite 自動表，不計入上述 59；因此不能直接拿此數與過去含系統表的「60 表」記錄說資料少了一表。
- [資料表與欄位索引](schema-index.md)為合成 schema。沒有讀取正式 DB／JSON、會員數、私有快照或機密設定；沒有對正式網址／QQ 授權做本輪驗收。
- JSON 內 `http_literal_clues` 是 AST 字串線索，不等於可達路由。service 會覆寫 upstream、gateway 會阻擋內部入口、部分 suffix 是協議匹配；必須連同下表與實際 dispatch 閱讀。
- 本輪沒有重跑應用業務測試，避免把文件更新描述成系統重構通過。空庫初始化只驗證 schema 可建立／重入，不能代替帶資料的遷移演練。

重建索引（只讀提交，輸出本目錄的 JSON／schema 文件）：

```sh
python3 docs/unified-rebuild/build_source_audit.py --commit 8da877857f163853c449474e168534e2e493121b
```

後續若基線更新，先核對新增功能並更新矩陣，再重建；不只更新 SHA 而保留過時清單。

## 2. 現有 runtime 與前端分界

| 系統 | 有效入口／來源 | 現況 |
| --- | --- | --- |
| 看板 web | [server.py](../../server.py)、[qgroup_core](../../qgroup_core/__init__.py) | Python HTTP／SQLite，共享核心含 bot 依賴 |
| 看板 UI | [BoardApp](../../ui/board/BoardApp.tsx)、[AdminApp](../../ui/board/AdminApp.tsx)、其餘 ui/board | 直接 TSX；身份、報名、表單、投票、帳務、包間、管理各有元件 |
| 看板非畫面服務 | [client](../../public/client.js)、[storage](../../public/storage.js)、[i18n](../../public/i18n.js) | 仍為 JS，注入 React；其餘舊畫面 JS 留供比對，並非現行 Board runtime |
| 成分 web | [service.py](../../music_site/service.py) → [upstream.py](../../music_site/upstream.py) | 前者覆寫身份、入口與管理；不能把後者所有方法都當公開能力 |
| 成分 UI | [index](../../music_site/public/index.html)、[app.js](../../music_site/public/app.js)、[admin.js](../../music_site/public/admin.js) | 大部分仍為舊控制器，建置轉 React；含排行、推薦、圖表、分享、分房、喊話、帳號 |
| 成分直接 TSX | [SelectionPanel](../../ui/music/SelectionPanel.tsx)、[store](../../ui/music/selection-store.ts) | 選取／程度、保存列、工具；不是全站完成 TSX |
| 轉接建置 | [build_ui](../../deploy/build_ui.mjs)、[controllers](../../deploy/react_controllers.mjs)、[react-view](../../ui/react-view.tsx) | 成分仍用轉接；新系統最終須移除這些 runtime 依賴 |
| bot | [main](../../qgroup_bot/main.py)、[replies](../../qgroup_bot/replies.py)、[worker](../../qgroup_bot/worker.py) | 官方 WebSocket＋HTTP，讀共用 DB、消費 outbox |
| 部署 | [Compose](../../compose.yaml)、[music Compose](../../deploy/music-compose.yaml) | web／bot 共用 QGROUP_TAG，music 獨立；不是已實作自動獨立版本鎖定 |

## 3. 現有 HTTP 入口清單

以下 `:id` 等是文件參數寫法，實際長度／字元限制以原 dispatch 為準。主站多數讀接口由 GET／HEAD 共用處理；callback HEAD 不消耗授權。mutation 不因舊碼接受較寬 method 就推廣成新版功能；新版保留有效業務意圖與既有相容要求。

### 3.1 主站帳號、系統與管理

| 方法 | 現有路徑 | 職責／矩陣 |
| --- | --- | --- |
| GET | `/api/health`、`/api/me` | 健康與訪客／會員／protocol／draft scope／同意狀態；I01、O15 |
| POST | `/api/register`、`/api/auth/logout`、`/api/auth/close` | 名稱註冊、登出、註銷；I05、I14、I16 |
| POST | `/api/auth/qq/start`、`/api/auth/qq/finish`；舊別名 `/api/account/qq/start`、`/api/account/qq/finish` | QQ 發起與本人確認；I02–I04 |
| GET | `/api/auth/qq/status`、`/api/account/qq/status`；`/auth/qq/callback` | 狀態與原 callback；I02–I04 |
| GET／POST | `/api/account`（GET）、`/api/account-links/:token`（GET）；`/api/account/link`、`accept`、`switch`、`revoke`（POST，後三者同 `/api/account/` 前綴） | 裝置、多帳號與授權；I07–I09 |
| POST | `/api/profile` | 改站內稱呼；I06 |
| GET／POST | `/api/notifications`（GET）、`/api/notifications/read`（POST） | 本人消息、已讀；O07 |
| GET | `/api/requests/:key` | 原操作結果查回，讀取仍重驗身份／角色；O05 |
| GET／POST／DELETE | `/api/payment-codes`（GET／POST）、`/api/payment-codes/:id`（DELETE）、`/api/payment-codes/:id/image`（GET） | 私人碼庫；S11 |
| GET | `/api/admin/session`、`/api/admin/users`、`/api/admin/bot-settings`、`/api/admin/music-links` | 後台 session／列表／設定／關聯；A01–A06、B07–B09 |
| POST | `/api/admin/login`、`logout`、`settings`、`users`、`users/metadata`、`privacy-review`、`music-links`（均同 `/api/admin/` 前綴） | 管理登入、政策、角色、備註、隱私與關聯 |
| POST | `/api/admin/bot-preview`、`/api/admin/bot-settings`、`/api/admin/bot-revert` | 預覽、保存與恢復前版；B07 |

### 3.2 活動與時間投票

除投票外，本表相對路徑皆以 `/api/events/:eventId` 為前綴。

| 方法 | 現有路徑 | 職責／矩陣 |
| --- | --- | --- |
| GET／POST | `/api/events` | 列表含 time_polls／建立；E01–E03 |
| GET／PATCH | 活動本身 | 讀取；edit／publish／pause／resume／start／finish／cancel／formation／archive／unarchive／remove／bot_sync／bot_retry；E02–E14、B04–B06 |
| POST | `/access` | 邀請活動瀏覽授權；E05 |
| POST | `/roster/preview`、`/roster/parties` | 本人／同行／代報預覽與建立；R01–R05 |
| PATCH／DELETE | `/attendees/:personId` | 修改／確認／拆組／退出；R04–R08 |
| PATCH | `/attendees/:personId/withdrawal`、`/attendees/:personId/conditions` | 退出審核、安排同意；R08、E11 |
| POST／GET | `/roster/invitations`（POST）、`/invitations/:token`（GET）、`/invitations/:token/accept`（POST） | 補報邀請、有限預覽、接受；R09 |
| POST／GET | `/claims`（POST）、`/claims/:token`（GET）、`/claims/:token/request`（POST）、`/claims/:claimId`（POST） | 發出、申請、核對與撤銷認領；R10–R11 |
| POST／GET／DELETE | `/management/invitations`（POST）、`/management/invitations/:token`（GET）、其 `/accept`（POST）、`/management/invitations/:invitationId`（DELETE）、`/management/roles/:roleId`（DELETE） | scope／指定結算人／轉交；E12–E14 |
| PATCH／POST | `/attendance/:personId`（PATCH）、`/onsite`（POST） | 出席與現場補錄；E15–E16 |
| GET | `/conditions`、`/history?before=...` | 安排版本、可見操作分頁；E10、E17 |
| PUT | `/rooms` | 正式預分安排；P01–P04 |
| GET | `/attendees/:personId/music` | 活動權限內的成分浮層；R12 |
| GET／POST／PUT | `/settlement/roster`（GET）、`/settlement/preview`（POST）、`/settlement/detailed`（PUT） | 名冊核對、逐人／包間預覽發布；S01–S14 |
| GET | `/settlement/history`、`/settlement/history/:version/receipts/:itemId` | 歷史列表與每版消費圖；S09–S10 |
| GET | `/payment-code`、`/settlement/history/:version/payment-code`、`/settlement/history/:version/payment-codes/:kind` | 舊兼容碼圖與每版微信／支付寶／其他；S10 |
| GET／POST | `/finance`（GET／POST）、`/finance/preview`（POST） | before／before_report 分頁；record／report／accept／reject／withdraw／reverse／close／reopen；F01–F12 |
| PUT／DELETE | `/registration` | 舊本人報名 adapter，不影響同行；R01、R07 |
| PUT | `/settlement` | 舊人均 adapter；逐人／包間後不得覆蓋；S01 |
| GET／POST／PATCH／PUT | `/api/time-polls`（POST）、`/api/time-polls/:id`（GET／PATCH）、`/api/time-polls/:id/votes`（PUT） | close／extend／cancel／finalize／remove／bot_sync／bot_retry，date／exact 選票；T01–T09 |

未宣告 HTTP v2 的舊活動／報名／結算寫協議有既定截止；不是把整個 `/registration` 功能任意刪除。新 client 必須走完整逐人 use case，舊相容拒絕條件另測。

### 3.3 成分 API

表內路徑皆為公開代理前綴 **`/music/api`** 之後的部分；原 `upstream` 看到的 `/api/*` 不等於外網可直接使用。

| 方法 | suffix | 職責／矩陣 |
| --- | --- | --- |
| GET | `/health`、`/session` | 服務／帳號關聯與 pending entry 狀態；I11–I12 |
| POST | `/join`、`/logout` | 舊成分證明登入／清會話；不開放新 PIN 註冊 |
| POST | `/profile/create`、`/profile/contact` | 明確新建與聯絡號修改／清空；I11、I13 |
| POST | `/entry/start`、`/entry/complete` | 十分鐘新會員進入意圖；I11 |
| POST | `/link/start`、`/link/cancel`、`/link/complete` | 舊成分 QQ 關聯；I12 |
| GET | `/state`、`/me` | 詞條、本人、計數與分類；M01、M03–M06、M10 |
| GET | `/members`、`/member`、`/entry/members` | 群友、成分和詞條選取者；M12、M17 |
| GET | `/matches`、`/compare` | 推薦排序、指定比較；M13–M18 |
| POST | `/selection`、`/note`、`/gender` | 成分、私人留言、性別／公開旗標；M03–M06、M18–M19 |
| POST | `/entry`、`/entry/update`、`/entry/delete` | 本人自建詞條；M07–M09 |
| GET | `/trend`、`/clusters` | 趨勢、群聚 API；M21–M22 |
| GET／POST | `/shouts`、`/shouts/history`（GET）、`/shout`（POST） | 喊話、歷史與發表；C01–C03 |
| POST | `/room/preview`、`/room/split`、`/room/recalc` | 自選合拍／分房／手動重算；P05–P07 |
| GET | `/qgroup/events`、`/qgroup/event` | 公開活動 API 來源、名單匹配；P08 |
| POST | `/qgroup/split`、`/qgroup/rooms` | 活動分房與調整重算；P06–P10 |
| GET | `/admin/session`、`/admin/state`、`/admin/backups`、`/admin/backup`、`/export` | 受主站管理驗證的狀態、JSON 與歷史下載；A10、A14 |
| POST | `/admin/create`、`edit`、`delete`、`merge`（均同 `/admin/` 前綴） | 詞條完整 CRUD／合併；A09 |
| POST | `/admin/pin`、`/admin/members`、`/admin/member/delete`、`/admin/reset` | PIN、會員資料、刪除／全重置；A10–A11 |
| POST | `/admin/shout/list`、`/admin/shout/delete` | 喊話管理；A12 |
| POST | `/admin/walls`、`/admin/wall/upload`、`delete`、`config`、`toggle`、`move`（後五者同 `/admin/wall/` 前綴） | 壁紙管理；A13 |

私有成分服務另有 `GET /api/internal/attendee-profile`、`POST /api/internal/admin-links`，必須由伺服器可信 context 使用。公開 gateway 不轉傳瀏覽器偽造的身分標頭，也不為此路徑產生專用 attendee_profile／admin_actor；請求由 service 拒絕，並非 gateway 有一條通用 internal 路徑封鎖規則。新架構仍須保持外部不可取得內部權限。`POST /api/admin/member/board` 明確拒絕並指引主站關聯管理；舊 admin login/password 不在有效 routes 內。

### 3.4 合作方及公開頁

- `/api/public/v1`、`/events`、`/events/:id`、`/events/:id/participants`、`/events/:id/rooms`（後四者同 v1 前綴）：GET／HEAD、Bearer 金鑰、唯讀白名單；OPTIONS 為獨立預檢行為，O01。
- 主站目前頁面為 `/`、`/admin`、`/guide.html`、`/privacy`、`/contact`；`/ui/*`、`/ui.css`、本機 JS、圖示／QQ 官方登入圖與第三方授權文字為資產，不能當作額外產品功能。檔案存在不等於其檔名是有效 URL；例如 public/admin.html 由 `/admin` 提供，新版可增加 html 別名，但不能將它說成原 server 已支援。
- 成分目前 `/music/`、`/music/admin`／`admin.html`、`privacy.html`、manifest、SW、壁紙、圖示／OG 圖與 UI 資產。hash 分頁見產品規格，fragment 僅客戶端可讀。

## 4. 資料表領域對照

完整欄位在 [schema-index.md](schema-index.md)；每一張都須在遷移台帳有去向，不能只遷主要 users／events／members。

| 範圍 | 原表／資料 | 新領域與保留重點 |
| --- | --- | --- |
| 基礎與名冊 | users、events、registrations、browser_sessions、event_access、roster_parties、attendees | 帳號／活動／名冊；registrations 保留只讀，不拿它覆蓋目前名冊 |
| 安排與交接 | event_conditions、attendee_consents、event_roles、management_invitations | 版本、逐人同意、scope、接受與撤銷 |
| 帳單與媒體 | settlements、settlement_history、settlement_details、settlement_receipts、image_assets、user_payment_codes、settlement_code_images、settlement_receipt_images | 舊版及每版完整快照、圖片引用與原 bytes |
| 實收付 | finance_reports、finance_report_actions、finance_entries | 追加原文／決定／沖銷與責任不變 |
| 裝置與認領 | browser_accounts、device_links、account_audit、attendee_claims、attendee_payment_origins | 裝置授權、原位認領及凍結付款來源 |
| 身分與管理 | qq_accounts、qq_attempts、external_identities、external_profiles、external_unionids、visitor_sessions、login_attempts、auth_requests、site_settings、admin_sessions、admin_audit、user_admin_roles、admin_role_history、admin_user_metadata | 外部 subject、session、政策與備註分開，按完整 namespace 匯入 |
| 隱私與紀錄 | privacy_consents、privacy_requests、schema_migrations、event_audit、notifications、request_results | 同意、刪除待審、遷移、審計、通知及已提交去重結果 |
| 投票與包間 | time_polls、time_poll_options、time_poll_ballots、time_poll_votes、time_poll_history、event_room_plans | 日期／票／定案與正式分房的穩定 ID 和版本 |
| bot | bot_outbox、bot_settings、bot_settings_history、bot_runtime、bot_groups、bot_group_ignores | 原工作、設定版本、載入狀態、群發現與診斷 |
| 成分身分庫 | sessions、links、used_oauth、prelinks、login_attempts、link_overrides、link_audit、native_profiles、profile_contacts、entry_intents | 原來源 namespace 與關聯權威順序、空值清理／撤銷／限流 |
| 成分 JSON／檔案 | members、entries、settings、shouts、shoutHistory、trend、walls／manifest、配對備份及 erasures | 正規化但不丟欄位；刪除重播與完整備份另有規格 |

## 5. 已識別的差異與待鎖定行為

| 問題 | 程式證據 | 新規格處理 |
| --- | --- | --- |
| 「只有發起者可結算」過時 | permissions.SCOPES 含 settlement，management.accept 支援唯一指定結算人，settlements.context 驗 settlement | E13、S08、F02 保留指定結算人；不能依舊 P3／P4 文件降級 |
| 匹配公式註解不是現況 | match_stats docstring 寫 30/70 與冷門加權，但實際 parts 為 .55/.45、程度加權 | 以實際輸出鎖 fixtures；另保留冷門統計與排序，改公式另案 |
| 領域沒有熟悉度操作但舊資料仍有 level | 選取 UI 區分 kind；norm_selection／match_stats 仍處理 level | UI 保持無領域程度，遷移不直接刪 level；規格化時需驗證不改分數 |
| 私人留言方向／排序存在差異 | note_allowed 依「viewer 的預設推薦首位」判 other；matches 則只保留當次排序主榜首位 note | 明確列為授權問題，P0 補測固定 viewer／owner／sort 規則；不得直接套 UI「只給最像我的人」擴公開 |
| 圈子渲染不可達 | renderClusters 找 clustersCard，現有 index 無該節點；API 仍可用 | M22 保留後端，新 UI 提供明確入口，分開記新增體驗 |
| 兩種分房沒有寫回關係 | music qgroup_split／qgroup_rooms 只算結果，主站 rooms.save_plan 另寫正式快照 | 增加採用預覽／提交，新舊語意都保留，不自動記錢 |
| 成分稱呼長度有不同表述 | index maxlength=24、upstream MAX_NAME_LEN=16；enter_profile 後端清理至 16 | P0 以後端接受值鎖基線，新 UI 明示實際限制；不繼續靜默截斷 |
| 主站簡繁與成分不完全相同 | build_ui 主站有 hans／hant，music locale 為空 | O08 延續主站策略到統一產品；不宣稱舊成分已有全部簡繁產物 |
| 成分前端有 previewMode，包裝後 API 仍需身份 | service 對除 health／session 等入口的 API 驗 current_qq | 匿名保留公開活動，音樂不製造可匿名讀會員資料的假體驗 |
| 成分自建詞條改 kind 的限額需補邊界 | create_entry 檢查建立數，update_entry 可改 kind，管理與會員規則不同 | 保留可編輯能力；P0 補測類型變更後的限額與既有超額資料，不擅刪資料 |
| 文件內服務數與發布範圍不同 | 政策標 web／bot／both，實際另有 music 容器 | 範圍 none／web／bot／both 沿用，發布 manifest 另逐服務列實際映像 |
| 歷史測試數／會員數不等當下實測 | README 與多篇 release 分屬不同日期 | 索引只報方法／空庫結構；正式數量與測試通過數重新執行後再記 |

## 6. 使用方式與限制

這一輪盤點已足以建立新產品的全功能工作台帳與架構。實作 P0 仍須把分房、聚類、私人留言、失敗重試與所有角色組合補成可重播案例，並在受控的實際資料副本確認未知欄位與歷史資料形態。這些是明確的驗收工作，不代表可以在重寫時忽略該功能。

新增功能或發現隱藏分支時，先擴充矩陣 ID 與來源映射，再修改實作；不得因原網站不好用就讓能力在搬遷中無聲消失。
