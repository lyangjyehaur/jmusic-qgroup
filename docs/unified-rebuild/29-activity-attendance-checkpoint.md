# 第二十三批實作：現場出席與補錄

日期：2026-11-17（Asia/Taipei）。分支 `codex/unified-rebuild`。發布範圍 **`none`**：隔離實作、測試及原始碼同步；未部署、未整合 main。名冊、費用同意與 bot outbox 為跨服務依賴，正式切換仍先按 **`both`** 驗證。

## 已實作

活動詳情連到原生 React／TSX「現場出席」。同頁查看正式人員與曾核對出席的人員，按穩定 attendee ID 核對狀態、出席備註、實際到離場時間，或切換現場補錄。付款名稱沿用不可變認領來源，沒有按改名或認領重算責任。

原生 TypeScript API：

- `GET /api/v2/activities/:id/attendance`：僅具 attendance scope 且能存取活動的會員；回目前安排、條件版本、正式／候補數、逐人出席及付款辨識、操作限制。網站 admin 或原代報 manager 不自動取得 attendance 權限。
- `POST /api/v2/activities/:id/attendance/:personId`：精確 revision、狀態、備註、實際時間、原因及明確確認。需要 attendance scope。
- `POST /api/v2/activities/:id/onsite`：同時需要 roster 與 attendance；1–20 位本人／同行、付款歸屬、精確 revision 與 conditionsVersion、原因、費用接受，以及超額／繞候補各自的明確確認。

舊 bot `/?event=…&action=onsite` 轉入此頁，保留登入返回；開啟不自動送出。其他已支援的舊 bot task 入口繼續保留原行為。

## 出席與費用分離

保留 `unknown`／`present`／`absent`／`late`／`left` 五狀態。活動實際開始或已過預定開始後可以核對；結束、取消後仍可更正但必須填原因。歸檔須先取消歸檔，草稿及尚未開始不可核對。

狀態改動不釋出名額、不遞補候補、不修改 payer、原條件同意、結算版本、金額、收據或 finance entries。正式人員可核對；候補／待確認未觀察者不能藉此轉為正式。曾有觀察的已退出人員保留歷史更正入口，清回 unknown 後依來源規則離開此清單。

到離場以台北時間輸入、明確 offset 傳送，後端正規化 UTC 秒。拒絕無時區、無效日曆、將來時間或離場早於到場。時間可部分填寫；unknown／absent 不可留到離場時間。沒有實際改變時不追加 audit、不增加 revision，也不重寫 updated_at。

已發布的 settlements／history／details／receipt BLOB／finance entries 保持不變，缺席不自動更動既有帳單 headcount。需要更改費用時仍必須走後續有版本的結算流程。

## 現場補錄

僅進行中或已結束、未歸檔且尚無任何 settlements row 時可補錄；取消不能補錄。已有帳單即阻擋，不以空金額當作未結算。

建立新的 individual party 與 confirmed／present attendee，逐人寫入目前版 accepted consent；不填猜測的 arrived_at，也不改原有 attendee、party 或候補 seq。可報本人或未關聯同行；本人最多一次且不能重複現有非 withdrawn 本人。保留本人 self payer、同行 self／manager payer 的既有語意。

人數上限為 0 表示不限。超額需額外確認；有任何 waiting 時，另需先協調並確認此次補錄不按原候補排隊。費用版本、超額、繞候補各自勾選，重新讀取安排或修改輸入即清除確認。補錄原因必填，不以一般 signup 的報名開放條件取代現場規則。

## 交易、恢復與 bot

所有寫入使用 immediate 交易與精確 UUID receipt，發送前保存帳號／活動 scope 的完整 payload。未知出席及補錄沿用原 key／person／people／條件確認重試，禁止重複新增人員；回放前仍核對當前存取與 scopes，不藉收據恢復撤銷權限。

版本衝突保留原狀態、實際時間、備註、參加者及原因，明確取得目前出席與安排後重新核對。儲存失敗不送出，損壞原稿先保全副本；確認不持久化。帳號切換拒絕舊 scope，跨頁登出清除原稿，延遲成功不能恢復私人內容。

party／attendee／consent／audit／receipt 必要寫入失敗全回滾。Optional bot hook 巢狀交易失敗隔離。沿用來源規則：attendance_updated 與 onsite_added 不新增 signup 群卡或私人通知；關閉公開群同步仍會使既有 pending／sending 群卡失效。沒有把未啟用的現場廣播當作新能力。

Python `attendance` 差分比較 events、attendees、parties、consents、audit、access、payment origins、notifications、outbox 及原 finance／settlement 表；正規化隨機 ID，保留真實名冊／候補順序。保留的 Python `OutboxWorker` 實際消費新版先前產生的 roster 群卡一次，驗證出席與補錄不多送卡、worker 不改現場狀態。全部使用合成資料庫與 Mock 平台 API，無正式 bot、憑證或群操作。

## 驗收

新增 **14 項後端案例**：五出席狀態／UTC 時間與 Python 差分；attendance／roster 各別權限；實際／預定開始、草稿、結束／取消原因、歸檔；無效／未來／逆序／缺席時間；候補與已退出歷史；已發布帳單／finance 保全；現場 party／consent 差分；超額與候補獨立確認／隊序；條件版本、重複本人、payer、無上限及結束後補錄；no-op／receipt／撤權；競爭與 stale revision；必要回滾／optional bot；私人存取／scoped cookie／CSRF／原付款名稱；保留 worker 消費既有卡且不重播。

新增 **8 項 Chrome 案例**：活動入口與台北實際時間；開始／結束／歸檔和更正原因；超額／繞候補／費用三項確認；未知出席恢復；未知補錄去重；安排更新保稿與清空確認；無效時間／儲存阻擋／損壞保全／360px；舊 bot 入口／登入返回／帳號切換／跨頁登出／延遲回應。既有發布入口測試一併更新為真正的 onsite 入口且驗證不送出。

全套後端／領域／資料庫 **299 項、37 檔**及 Chrome **163 項**通過。strict TypeScript、建置、built API／SQLite／SPA smoke、既有 UI 生成及 166 項台帳檢查通過。schema 維持 **9**、**83** 張 user tables。前端約 **720 kB**，既有 500 kB 警告仍待效能收尾。

重現：`npm run test:rebuild`、`npm run build:rebuild`、`npm run test:e2e:rebuild`、`npm run test:build:rebuild`、`npm run check:ui`、`npm run check:capabilities`。

## 剩餘工作

E15／E16 仍記 in_progress：須結合完整結算／付款／分房、歷史及通知收件匣、全部舊 API 與隔離正式資料成套驗收。可見歷史／收件匣／待辦、投票、分房、費用／收款／圖片、音樂其餘功能及完整 TS bot 持續實作；不將這批稱為 166 項或 B01–B15 完整通過。台帳仍 **0 項完整通過、release_eligible=false**；未部署，正式 bot 及 main 不變。
