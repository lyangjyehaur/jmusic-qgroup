# 第五十八批實作：共用表單的 IndexedDB 原稿

日期：2026-11-18（Asia/Taipei）。分支 `codex/unified-rebuild`。變更範圍 **`web`**，實際發布範圍 **`none`**。本批只修改原生前端、本機原稿及帳號清除的介面處理；不改伺服器 schema、API、outbox、bot 指令、群政策或 worker。保留 Python bot，未合入 main、未推送、未部署，未接觸正式資料、憑證、群設定或真實待送工作。

## 本批範圍

`useReviewedDraft` 的六個流程改用 IndexedDB：時間投票建立、填答、管理，逐人結算（含圖片），正式預分包間，以及個人詞條的建立／修改／刪除。後者依操作分別保存。這是共用表單的第一批持久化，不代表所有前端草稿已遷移。

新增 `draft-store.ts`，資料庫為 `qgroup-reviewed-drafts-v1`，分別保存目前原稿、保全版本及失效世代。使用明確的表單 key 白名單及目前帳號 scope，不把一般 sessionStorage、裝置 token、PIN、OAuth、登入／救援憑證或隱私收據 secret 複製進來。scope 是隔離識別值，不是登入憑證。

結算尚未提交時只保存輸入、基準版本與圖片，不保存可供新決策使用的預覽狀態；恢復後須重新預覽。已送出且結果未知的 pending 則完整保留原 UUID／原 payload，包括原 preview hash。該 hash 綁定計算內容與基準版本，不能取代登入、CSRF 或權限；它只隨原冪等操作查回，不被當作新一版預覽。

## 保存、恢復與分頁競爭

- 每次編輯加入依序執行的寫入佇列，畫面在提交前顯示「正在保存本機原稿」。IndexedDB 使用 strict durability，只有整筆交易完成才視為已保存；單筆 `put` 成功後若交易 abort，仍視為失敗。
- 送出前先提交完整 pending 紀錄；失敗不發出業務 mutation。成功回應後的清理也須完成交易；若無法保存確認狀態，保留原 pending，提示已送出但尚需核對。離站的「保留原稿並離開」會等保存成功，不能用按鈕標籤冒充已完成保存。
- 關閉分頁或整個瀏覽器後，可在同一瀏覽器／帳號恢復。不完整原稿顯示原內容並鎖定，按「恢復本機原稿」才繼續編輯；未知結果維持原 payload 鎖定，由原確認按鈕明確查回。開頁、切頁或重啟不自動重送。
- 寫入檢查原稿 revision。另一分頁已改動時，先在同一交易保全競爭內容，再阻止覆蓋及送出。衝突被發現前已排入的較新內容也逐份保留；相同內容的重複保存不製造無意義競爭。
- 原頁可讀取目前版本、載入保全版本（同時保全被替換內容）或下載原始 JSON。損壞原稿先原樣封存，才允許新的輸入；讀不懂的保全版本可下載，不會被當成空白原稿送出。
- 收件匣同時列出目前帳號的 IndexedDB pending、保全版本中的 pending，以及仍在本分頁的其他表單紀錄。清單只顯示類型與原頁入口，不展示 payload、圖片、私人文字或其他帳號資料；回執核對依舊為只讀操作。

同 key 的現有重構版 sessionStorage 原稿只在符合範圍時移入；交易成功後才移除分頁來源。若 IndexedDB 已有另一版本，分頁來源另存為保全版本，不覆蓋原紀錄。這不包含原看板的 `kanban-local-v1` 遷移。

## 登出、刪除與失敗恢復

全裝置登出／帳號關閉清除本機 canonical 與保全版本；只刪成分則清除該 scope 的詞條原稿及保全版本，保留活動原稿與其他帳號。刪除和世代遞增在同一交易完成，每個舊 handle 寫入前都再核對世代；即使該分頁無 BroadcastChannel，也不能把已清除內容寫回。清除後的舊 session 來源也不能再匯入。世代標記保留以阻止舊頁回寫，不包含原稿或憑證。

BroadcastChannel 只負責讓各頁清除自身 sessionStorage 並刷新帳號；共用 IndexedDB 由發起頁清一次，避免每個接收頁再次清除剛建立的新原稿。

若伺服器登出／刪除成功，但本機交易中止，介面會明示「本機原稿清除失敗」，保留重試清除入口；不把它說成伺服器操作失敗，也不再次送出登出或刪除。會員登出後即使變成訪客，清除提示仍可見；管理登出失去管理權後，外層頁面仍保留清除入口。隱私完成按鈕在本機清除成功前保持停用。

## 驗證與剩餘界線

主要新增驗證位於 `apps/web/tests/durable-drafts.spec.ts`：關頁／帳號隔離、真實 Chromium profile 關閉後重啟及圖片逐位元保全、分頁衝突／失敗不送、session 遷移失敗保留來源、敏感值排除、無 BroadcastChannel 的登出／刪除防回寫、跨新分頁收件匣原 UUID／原內容重試、離站保存失敗停留，以及會員／管理登出及成分刪除的本機清除重試。三個既有表單 spec 的儲存故障測試改為在真實 `put` 成功後中止交易，不再只模擬 sessionStorage 失敗。360px 保全版本介面已檢查，無水平溢出。

最終驗證：

- `npm run build:rebuild`：嚴格型別、Vite 原生前端及 API／bot 產物建置通過。
- `npm run test:e2e:rebuild -- durable-drafts.spec.ts time-polls.spec.ts music-entries.spec.ts activity-settlement.spec.ts activity-room-overview.spec.ts inbox-history.spec.ts privacy.spec.ts identity.spec.ts admin.spec.ts`：**72 項通過**，包含 **11 個新增持久化案例**及管理隱私相關回歸。Playwright 以路徑比對選取現有 spec；不把沒有匹配檔案的參數另算測試。
- `npm run test:rebuild`：**93 檔／805 項通過**。
- 保留 Python bot：`test_bot_*.py` **311 項**、`test_time_poll_bot.py` **15 項通過**；`node tests/test_bot_links.js` 三語入口檢查通過。
- `npm run test:build:rebuild`：建置後 API／bot 的隔離空庫、mock HTTP／WebSocket、原生 CLI 與復原阻擋 smoke 通過。
- `npm run check:capabilities`：166 IDs 保留、0 fully accepted、release eligible false；`git diff --check` 通過。

瀏覽器與全套原生回歸依序執行。以上全部為隔離本機／合成平台驗證，不包含正式 QQ 投遞、正式版本組合或上線驗收。

O04／O05 保持 `in_progress`，166 項仍無整體 accepted，不能據此切換正式系統。剩餘工作包括其他活動／報名／帳務／收款碼／成分／管理表單的 sessionStorage 持久化、原看板 IndexedDB（含圖片、client intent、基準版本及舊 pending 先查結果再轉換）的同源遷移、完整匯入／匯出與人工版本辨識、實際瀏覽器／裝置及發布組合驗收。舊庫不被修改或刪除；尚未對這些剩餘項目宣稱完成。既有大 chunk 建置提示仍在，未將本批視為整體效能或離線寫入驗收。
