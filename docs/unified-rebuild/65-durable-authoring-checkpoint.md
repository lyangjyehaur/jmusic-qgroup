# 第五十九批實作：活動與帳務原稿持久化

日期：2026-11-18（Asia/Taipei）。分支 `codex/unified-rebuild`。變更範圍 **`web`**，實際發布範圍 **`none`**。本批修改瀏覽器原稿與收件匣本機操作入口；不改伺服器 schema、API、outbox、bot 指令、政策、模板或 worker。保留 Python bot，未合入 main、未推送、未部署，未操作正式資料、憑證、群設定或真實待送工作。

## 本批範圍

活動新增／編輯／再約副本、已發布安排、款項登記與申報／核對命令，以及私人收款碼庫改用 IndexedDB。`useDurableRecord` 沿用各表單既有資料格式、驗證與業務 API；保存原操作 UUID、完整 pending body、基準 revision 及圖片，不把既有草稿改成另一種業務命令。收款碼仍以原 serializer 保留一份圖片，不重複保存 pending 圖片。

`DraftFeedback` 抽成共用元件，提供讀取／保存狀態、明確恢復、損壞原稿保全、衝突版本載入與 JSON 下載。原 `useReviewedDraft` 六流程繼續使用已驗證的實作，沒有在這批再次改寫。所有新增文案均用於狀態、恢復或操作限制。

## 保存與恢復

- 編輯依序保存。業務提交前先等待完整 pending 的 IndexedDB 交易提交；失敗不送出。同步 busy guard 阻止同次事件內重複操作，保存或讀取期間不接受編輯。
- 等待交易時若帳號已切換、原表單已卸載，即使原 pending 保存成功也停止後續 HTTP 提交；原帳號可回到待確認操作自行核對。
- 不完整原稿開頁時顯示內容並鎖定，明確恢復後才可編輯；結果未知的原操作仍鎖定原內容，由確認按鈕以原 key／原 body 查回。關頁、新分頁與收件匣不會自動提交。
- 帳務恢復或載入保全版本後清除暫存預覽與確認，須重新核對；未知結果則保留原 pending 所需預覽憑證，只用於原操作恢復。
- 帳務的保存狀態、錯誤與恢復入口放在摺疊表單外，收合款項操作後仍可核對或恢復原稿。
- 帳務摺疊由 React 的同一狀態控制，避免讀取原稿後延遲的原生 toggle 事件再次收合，藏起恢復或編輯欄位。
- 保存確認狀態失敗時保留 pending，不能把伺服器已接受誤判為拒絕，也不能顯示本機已清理成功。原稿衝突保全、帳號隔離及登出世代檢查沿用共同儲存層。
- 離站按鈕等待本機保存，讀取結果的唯讀 fallback 不額外攔截開啟已確認的活動。損壞與衝突原稿仍有保全入口。

## 新活動原稿的原子轉移

伺服器回傳新活動 ID 後，來源 `new`／`copy:<id>` 的退役與新 ID 原稿的初始化在同一筆交易中完成。任何一步 abort 均保留原 pending；重開後可由收件匣以相同 UUID／body 查回同一個活動。

如果另一分頁在回應等待期間已編輯新 ID 的原稿，保留該原稿，不能用建立回執覆蓋。退役來源使用 `raw:null` 並遞增 revision 的墓碑；目前原稿清單不列墓碑，舊分頁也無法以舊 revision 復活已處理來源。墓碑只屬瀏覽器資料形狀，不改伺服器資料庫。

再約原稿先檢查本機來源，有資料即讀取原稿，不重新抓取原活動安排；損壞內容也先進保全流程。收件匣的 copy 原稿連結改為 `/activities/new?copyFrom=...`，支援 URL 編碼的來源 ID。

## 驗證與剩餘界線

`durable-authoring.spec.ts` 新增六個情境：pending 交易等待期間切換帳號後不送出、建立後原子轉移 abort／關頁重試、回應延遲時保全另一頁的目標編輯、再約副本由新分頁收件匣查回而不重讀來源、收款碼原圖關頁恢復／帳號隔離／無 BroadcastChannel 登出防回寫，以及帳務未完成命令的原 ID／revision、收合後恢復與雙分頁衝突保全。既有活動、帳務、發布、收款碼及舊入口測試改為檢查實際 IndexedDB 交易，不再以 sessionStorage 成功代替持久保存。

最終驗證：

- `npm run build:rebuild`：嚴格型別、原生前端及 API／bot 產物建置通過。
- `npm run test:e2e:rebuild -- durable-authoring.spec.ts activity-drafts.spec.ts activity-finance.spec.ts payment-codes.spec.ts activity-publish.spec.ts legacy-navigation.spec.ts durable-drafts.spec.ts time-polls.spec.ts music-entries.spec.ts activity-settlement.spec.ts activity-room-overview.spec.ts inbox-history.spec.ts privacy.spec.ts admin.spec.ts`：**121 項通過**。
- 手機版恢復介面另跑帳務案例確認，**1 項通過**；360px 無水平溢出，已檢查衝突提示與保全版本入口。多分頁截圖先切至目標分頁，避免背景分頁的合成截圖失真。
- `npm run test:rebuild`：**93 檔／805 項通過**。
- 保留 Python bot：`test_bot_*.py` **311 項**、`test_time_poll_bot.py` **15 項通過**；`node tests/test_bot_links.js` 三語入口檢查通過。
- `npm run test:build:rebuild`：建置後 API／bot 的隔離空庫、mock HTTP／WebSocket、原生 CLI、投遞所有權與復原阻擋 smoke 通過。
- `npm run check:capabilities`：166 IDs 保留、0 fully accepted、release eligible false；`git diff --check` 通過。

六個新增情境另以 `--repeat-each=3` 連續執行，**18 次通過**；這是六個情境的重複時序驗證，不另算 18 個獨立功能。

瀏覽器與全套原生回歸依序執行。以上為隔離本機／合成平台驗證，不代表正式 QQ 投遞、正式版本組合或全站上線驗收。

O04／O05 保持 `in_progress`。其餘報名、活動狀態、逐人確認、出席、邀請／認領／分工、帳號／成分及管理表單仍待逐項持久化。原 `kanban-local-v1` 的同源遷移也尚未完成：須先查清舊 pending 結果，再保留原冪等 key、client intent、版本與圖片轉換，驗證前不刪除來源。不得將 PIN、裝置 token、OAuth／救援憑證或隱私收據 secret 納入持久草稿。完整裝置、平台、bot 實際版本組合及正式切換驗收仍未完成；本批不是全站完成或發布核准。
