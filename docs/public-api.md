# 合作方公開活動唯讀 API v1

發布範圍：`web`。2026-11-14 20:18（Asia/Taipei）已正式部署，網站根網址為 `https://kanban.danndann.cn`，活動列表為 `https://kanban.danndann.cn/api/public/v1/events`。這是供第三方整合的獨立契約，原 `/api/events` 繼續供網站使用。詳見[發布紀錄](releases/2026-11-14-partner-api.md)。

## 可公開內容

第一版提供活動時間、地點、類型、說明、費用規則、報名期限、成團狀態、名額統計、活動連結、報名人員及包間安排。只接受已發布且 `visibility=public`、`lifecycle!=draft`、`status!=deleted` 的活動。已取消、結束、歸檔的公開活動仍可查詢，方便同步取消狀態及保留歷史。

所有資料查詢均需合作方 API Key，包括端點索引、活動列表與活動詳情。金鑰只允許讀取公開活動，不取得任何管理或寫入權限。網站登入 Cookie 不能代替金鑰；帶活動所有者、管理員或持邀請權限帳號的 Cookie 也無法取得非公開活動。沒有全站帳號目錄或依 QQ 號查人的端點。路徑保留 `/api/public/v1`，其中 public 表示資料只來自公開活動，並非匿名存取。

不提供 QQ 號、OpenID、UnionID、QQ 暱稱／頭像、Cookie、邀請碼、管理權限、報名備註、退出原因、出勤、付款人／收款人、金額、帳本、收款碼或消費憑證。帳務與付款狀態不應由包間分配推斷。時間投票暫未納入；如日後開放，應另定選項及投票統計契約。

## HTTP 行為

- 資料請求須有 `Authorization: Bearer <API_KEY>`；支援 `GET`、`HEAD`、`OPTIONS`，通過鑑權後的寫入方法回 `405`，`Allow: GET, HEAD, OPTIONS`。
- JSON UTF-8；系統欄位與 enum 不隨 `Accept-Language` 改變，使用者文字保留原文。
- 由合作方後端串接，不提供跨站 CORS。金鑰只保存在雙方後端，禁止放進瀏覽器 JavaScript、公開倉庫或網址參數。正式環境使用 HTTPS。
- 不建立 session、不設定 Cookie、不修改資料；資料庫連線啟用 SQLite `query_only`，每次回應在同一讀取交易內取得快照。
- `Cache-Control: no-store`，避免切換成邀請可見後持續從 HTTP 快取讀取。
- 成功 `200`；無資料的 `OPTIONS` 可不帶金鑰並回 `204`，但不授予 CORS 權限。缺少／錯誤／格式不正確的金鑰回 `401`，格式 `{"error":"Valid API key required"}`，帶 `WWW-Authenticate: Bearer realm="qgroup-partner-api"`。
- 未配置金鑰、空設定或設定格式錯誤時，資料介面一律回 `503`，格式 `{"error":"Partner API is not configured"}`，不回退成匿名查詢。
- 通過鑑權後，錯誤參數 `400`；不存在、邀請、草稿、刪除一律 `404`，格式 `{"error":"Public event not found"}`。未知子路徑同為 `404`。請求日誌不記錄 Authorization，並遮蔽這組介面的所有查詢參數。
- 未知或重複參數回 `400`，不默默忽略。JSON 文字仍需由接收網站依其顯示方式正常跳脫。

## 端點

| 方法與路徑 | 內容 |
| --- | --- |
| `GET /api/public/v1` | 端點索引、ID 語意與分頁上限 |
| `GET /api/public/v1/events` | 分頁活動摘要，不夾帶逐人名單或包間 |
| `GET /api/public/v1/events/{event_id}` | 單場摘要＋說明／費用規則／取消原因＋名單＋包間，同一快照 |
| `GET /api/public/v1/events/{event_id}/participants` | 逐人報名名單 |
| `GET /api/public/v1/events/{event_id}/rooms` | 預分包間及最新詳細結算中的實際包間 |

`event_id` 為站內現有 16 位十六進位活動 ID。除索引外，每個回應均含 `api_version: 1`；單場回應另含 `event_id`、`revision`。

### 活動列表

可選參數：

| 參數 | 預設／範圍 |
| --- | --- |
| `limit` | 預設 20，1–100 |
| `offset` | 預設 0，0–100000000 |
| `lifecycle` | 不篩選；可選 `scheduled`、`ongoing`、`ended`、`cancelled` |
| `status` | 不篩選；可選 `open`、`closed`、`cancelled` |

依 `starts_at,id` 升冪排序，回應 `events`、`total`、`limit`、`offset`、`next_offset`；最後一頁 `next_offset=null`。活動列表每筆摘要包含：

- `id`、`title`、`category`、`location`、`owner_name`、`url`（站內相對網址 `/?event=...`）。
- `starts_at`、`ends_at`、`duration_hours`、`timezone`、`deadline`、`withdrawal_deadline`、`actual_started_at`、`actual_ended_at`。時間使用既有 ISO 8601；未填時長則 `ends_at=null`，未知實際時間為 `null`。
- `status`、`lifecycle`、`phase`、`estimated_over`、`registration_open`、`archived_at`、`formation_state`。
- `capacity`（0 為不限）、`remaining_capacity`（不限為 `null`）、`minimum_participants`、`minimum_met`、`counts: {confirmed, waiting, tentative}`。
- `revision`、`conditions_version`、`created_at`。

`lifecycle` 是明確記錄的狀態；`phase` 可能因預計開始時間已到而顯示 `ongoing`，不表示已確認實際開始。`estimated_over` 也不表示活動正式結束。`registration_open` 代表基本報名時間與開關允許，仍可能進入候補／整組排隊；`remaining_capacity` 不能當作保證可取得的名額。

### 名單及人工 ID 對照

回應例子（虛構資料）：

```json
{
  "api_version": 1,
  "event_id": "0123456789abcdef",
  "revision": 7,
  "participants": [
    {"attendee_id": "1111111111111111", "user_id": "example-account-id", "name": "小明", "status": "confirmed", "confirmation_state": "accepted"},
    {"attendee_id": "2222222222222222", "user_id": null, "name": "同行", "status": "waiting", "confirmation_state": "accepted"}
  ]
}
```

- `user_id` 就是管理後台「用戶管理」暱稱下方的完整 `users.id`，供對方維護 `QQ 號 ↔ user_id`。改名、換裝置、跨活動沿用；重新註冊的新帳號是新 ID，不自動合併。
- `attendee_id` 是單筆報名 ID，等同現有活動 `participants[].id` 與包間 `person_ids` 的值。同一帳號參加不同活動有不同報名 ID；不要用它建立跨活動的個人對照。
- 未認領同行 `user_id=null`，不能使用代報者的帳號 ID 代替。可先維護單場 `event_id + attendee_id ↔ QQ 號`；本人認領後保留報名 ID，補上本人帳號 ID。
- 已註銷帳號的共用活動記錄仍可能保留，但 `user_id` 不再提供，接收方應移除原對照關聯。
- 只含 `confirmed`／`waiting`／`tentative`，依此順序分組，同組維持原報名順序；邀請未接受及已退出人員不在這份當前名單中。
- `confirmation_state` 為安排確認狀態 `accepted`／`pending`／`declined`，與報名狀態分開。

### 包間分配

回應包含 `planned` 與 `actual`：

```json
{
  "api_version": 1,
  "event_id": "0123456789abcdef",
  "revision": 7,
  "planned": {
    "version": 2,
    "rooms": [{"id": "aaaaaaaaaaaaaaaa", "name": "牡丹廳", "attendee_ids": ["1111111111111111"], "members": [{"attendee_id": "1111111111111111", "user_id": "example-account-id", "name": "小明"}]}],
    "unassigned_attendee_ids": ["2222222222222222"]
  },
  "actual": null
}
```

`planned.version=0` 表示還沒有預分版本；沒有預分時仍列出當前所有未分配人員。預分只顯示當前有效報名者，已退出／未接受邀請者不會由舊分配快照洩漏出來。候補可被預分，分配不代表取得正式名額。

`actual=null` 表示尚無已發布的逐人詳細結算。存在時結構同 `planned`，但版本欄位為 `settlement_version`，人員及姓名來自該版不可變結算快照，可能包含後來退出的人；`user_id` 依該報名目前的有效帳號關聯取得。普通逐人結算可有 `actual.rooms=[]`，不應回退成舊預分。舊人均結算沒有逐人實際包間資料，因此仍為 `null`。

單場詳情回應的相同資料位於 `room_assignments` 下。接收方可在沒有 `actual` 時顯示 `planned` 並標示「預分」；已有 `actual` 時顯示實際安排。兩者均不含付款身分、消費金額或支付狀態。

## 呼叫與同步

以下金鑰變數由合作方後端的私密環境設定注入，範例不含真實金鑰。

```sh
curl -H "Authorization: Bearer ${QGROUP_API_KEY}" 'https://kanban.danndann.cn/api/public/v1/events?limit=20'
curl -H "Authorization: Bearer ${QGROUP_API_KEY}" 'https://kanban.danndann.cn/api/public/v1/events/0123456789abcdef'
```

```js
// Node.js 後端範例；不要放到網頁前端。
const base = 'https://kanban.danndann.cn';
const key = process.env.QGROUP_API_KEY;
if (!key) throw new Error('Missing QGROUP_API_KEY');
const response = await fetch(`${base}/api/public/v1/events?limit=20`, {
  headers: {Authorization: `Bearer ${key}`}
});
if (!response.ok) throw new Error(`HTTP ${response.status}`);
const page = await response.json();
```

建議每 60 秒或使用者手動刷新時更新一次，循 `next_offset` 取得全部頁面；這是呼叫建議，目前沒有新增公開 GET 速率限制。單場詳情提供名單與包間的同一交易快照，優先使用它組合畫面。分開呼叫的端點可能跨越異動，需要時重新取得單場詳情。

`revision` 是活動版本，改暱稱、帳號註銷與時間推移未必遞增，因此不要只靠它跳過重新讀取。列表在同步期間可能新增、刪除或調整排序，offset 分頁不保證跨請求完整快照；依 ID 去重並定期完整重讀。`404` 代表該場已無公開資料，應停止展示並清除本地公開副本；完整同步成功後，也應移除列表不再出現的活動。`401` 應檢查／更新金鑰，`503` 或網路失敗應稍後重試，不能當作活動刪除。本站切換可見性無法撤回對方已下載的副本。

## 我方金鑰設定及撤銷

我方環境變數為 `KANBAN_PUBLIC_API_KEYS`，最多 20 把、逗號分隔，每把 32–128 字元，限英數、`_`、`-`。請為每個合作方分別產生至少 32 個隨機 bytes 的金鑰，例如 `python3 -c 'import secrets; print(secrets.token_urlsafe(32))'`，私下交付對應合作方；不要把實際金鑰放入文件或對話紀錄。範例檔為 `deploy/public-api.env.example`，預設空白代表停用。

正式環境將實際設定放在 `/etc/qgroup/public-api.env`（root 所有、0600），Compose 僅 web 載入；systemd 的 qgroup.service 亦保留此 EnvironmentFile。更新檔案後，Compose 須依發布政策只重建 web 容器以重新載入環境（不是只執行 restart）；systemd 則重啟 qgroup.service。bot 不需要此金鑰，也不需要因此重啟。

輪替時暫時保留舊、新兩把，讓對方切換成功後移除舊金鑰，再重新載入 web 環境。撤銷某合作方只需移除其金鑰；移除全部金鑰會關閉整組 API。本次已建立首把正式金鑰；換鑰與撤銷流程已於隔離測試驗證，尚未在正式環境執行。

## 相容性與驗證

新增 `public_api.py` 僅由 `server.py` 匯入，Docker 明確納入此檔；Compose／systemd 僅為 web 新增可選金鑰環境檔。沒有 schema、outbox、共用核心行為、bot 入口或共用設定語意變更；原瀏覽器 API 的回應與權限保持既有契約。隱私政策與手冊補充合作方鑑權及資料範圍，帳號既有登入同意版本未變更。

發布範圍為 `web`；本次已完成正式單邊發布，bot 原容器、映像及啟動時間未變。部署已按 deployment-policy 記錄兩個服務實際版本與映像，驗證新版 web 搭配線上 bot；後續發布仍須重新通過相同門檻。

驗證指令：`python3 -m unittest discover -s tests -p test_public_api.py -q`，以及專案完整 Python／前端回歸。新增測試涵蓋跨活動 ID、代報認領、註銷、可見性、分頁、包間快照、後端存取、HEAD／OPTIONS、方法限制及讀取零資料異動，以及缺少／錯誤／重複金鑰 header、錯誤配置、換鑰撤銷、Cookie 不可代替金鑰與日誌遮蔽。

2026-11-14 鑑權版驗證：API 專項 14 項、完整 Python 682 項及全部 15 組前端測試通過，簡繁產物已重新生成。核准來源的同一份 linux/amd64 映像匯入本機後，完成 682 項容器測試（skipped=8），退出碼 0、OOMKilled=false。正式配對備份的隔離副本完成重複初始化、資料／圖片完整性及原 bot 相容性驗證，schema 維持 19。正式 HTTP／HTTPS 及本機對外 HTTPS 驗證金鑰錯誤 401、有效金鑰 200、寫入 405；正式非公開活動的詳情／名單／包間均為 404。完整映像、版本、備份、回退及驗收結果見發布紀錄。
