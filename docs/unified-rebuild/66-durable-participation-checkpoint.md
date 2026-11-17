# 第六十批實作：活動參與原稿持久化

日期：2026-11-18（Asia/Taipei）。分支 `codex/unified-rebuild`。變更範圍 **`web`**，實際發布範圍 **`none`**。本批只修改原生前端與瀏覽器原稿，不改 API、伺服器 schema、outbox、bot 指令、政策或模板。保留 Python bot；未推送、未合入 main、未部署，未操作正式資料、憑證、群設定或真實待送工作。

## 本批範圍

以下既有流程改接 `useDurableRecord` 與共同 IndexedDB，保留原草稿格式及業務命令：

- 活動狀態：暫停／恢復、成團、實際開始／結束、取消、歸檔／取消歸檔、移除。
- 逐人安排確認：原報名者、接受／暫不同意、原因、基準 revision 與安排版本。
- 現場出席及補錄：原穩定對象、到離場時間、備註、付款歸屬、原現場人員清單與原因。
- 本人／同行報名及逐人管理：整組／分開排隊、待確認、逐人編輯、確認參加、分組、退出及審核。

每次編輯依序保存。提交前等待完整 pending 交易完成，才發出 HTTP；交易 abort 不送出，帳號切換導致表單卸載也不再送出。拒絕結果只有在新本機狀態保存成功後才清除 pending；伺服器接受而本機確認保存失敗時保留原 UUID／body，由原按鈕明確查回。共同離站入口等待保存，不再直接以 `blocker.proceed()` 冒充已保全。

## 恢復與既有連結

有輸入的原稿在同帳號重新開頁後顯示內容並鎖定，須明確恢復。未送出的確認勾選、報名分配預覽與部分分配接受均不持久化；恢復或載入保全版本後重新核對。已送出的未知結果則保留原 pending 的預覽 token、安排版本與全部確認欄位，只用於查回原操作，不能轉作新決策。

原 bot／名冊連結的 `party`、`tentative`、`onsite`、`person` 及退出預選仍保留。預選在非同步載入原稿時處理：已有輸入就保留原輸入；新表單或原本乾淨的已保存空表單可帶入新預選，不把 URL 提供的選擇誤標成待恢復的舊輸入。共同 hook 的可選 `needsRestore(raw)` 只用於判斷原來源是否含輸入，既有使用者原稿仍由共同恢復入口處理。

現場名冊及管理報名原本掛在 mount effect 的 person 預選移到乾淨原稿初始化，避免非同步讀取時被鎖定而漏選，或在讀取原稿前覆蓋內容。所有連結均不自動提交。

## 驗證

`durable-participation.spec.ts` 增加六種操作各兩個關頁情境：未完成原稿的原內容／revision 與重新確認，以及未知結果由新分頁收件匣以原 UUID／body 查回、伺服器 revision／人數不重複增加。另測現場補錄雙分頁衝突的兩份人員清單、載入保全版本後重新確認，以及報名已成功但本機確認交易 abort 後的恢復。既有四個 spec 的故障注入改為真正 IndexedDB `put` 成功後中止交易，登出也檢查實際持久草稿清除。

退出審核測試改為先等待「報名操作已保存」，再查詢伺服器名單。原測試只檢查一段原本就不存在的完整標籤，非同步保存後可能在請求完成前通過該斷言；最終人數與退出規則的驗收保留。

最終驗證：

- `npm run build:rebuild`：嚴格型別、原生前端及 API／bot 產物建置通過。
- `npm run test:e2e:rebuild -- durable-participation.spec.ts activity-lifecycle.spec.ts activity-conditions.spec.ts activity-attendance.spec.ts activity-registration.spec.ts durable-authoring.spec.ts activity-drafts.spec.ts activity-finance.spec.ts payment-codes.spec.ts activity-publish.spec.ts legacy-navigation.spec.ts durable-drafts.spec.ts time-polls.spec.ts music-entries.spec.ts activity-settlement.spec.ts activity-room-overview.spec.ts inbox-history.spec.ts privacy.spec.ts admin.spec.ts`：**166 項通過**，包含本批 14 個新增情境。測試數量與能力矩陣 ID 數量恰好相同，並不代表 166 項能力已整體驗收。
- 現場補錄恢復／保全版本在 360px 無水平溢出，已檢查截圖、確認重置及操作入口。
- `npm run test:rebuild`：**93 檔／805 項通過**。
- `node tests/test_bot_links.js`：三語 bot 網頁入口檢查通過。
- 保留 Python bot：`test_bot_*.py` **311 項**、`test_time_poll_bot.py` **15 項通過**。
- `npm run test:build:rebuild`：建置後 API／bot 的隔離空庫、mock HTTP／WebSocket、ACK／Resume、投遞所有權、原生 CLI 與復原阻擋 smoke 通過。
- `npm run check:capabilities`：166 IDs 保留、0 fully accepted、release eligible false；`git diff --check` 通過。

瀏覽器與原生全套依序執行。以上僅為本機隔離及合成平台驗證，不包含正式 QQ 投遞或切換後實際版本組合的驗收。

O04／O05 仍為 `in_progress`。剩餘包括邀請／認領／分工、帳號／成分／管理表單持久化；含存取憑證的流程需另行審查，不能直接全部複製至持久儲存。原 `kanban-local-v1` 同源遷移、完整原稿匯入／匯出、實際裝置及正式 web／bot 版本組合驗收也尚未完成。166 項無整體 accepted，本批不構成全站完成或正式切換核准。
