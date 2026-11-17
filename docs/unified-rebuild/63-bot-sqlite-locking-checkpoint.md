# 第五十七批修正：bot 並行寫入交易

日期：2026-11-18（Asia/Taipei）。分支 `codex/unified-rebuild`。變更範圍 **`bot`**，實際發布 **`none`**。只在本機合成 SQLite／QQ 平台驗證，未修改或重啟正式 bot，未接觸憑證、正式群、資料或待送工作。schema 維持 14，不變更網站資料契約、指令、政策、通知內容或投遞語意。

## 原因與修正

PWA 批次的完整回歸發現兩種 bot 失敗：等待 token 後未完成模擬政策處理；公開回覆與按鈕並行時，群觀察先發生 `SqliteError`，導致該回覆流程停止。單獨執行 runtime spec 仍出現後者，不能只歸因測試負載或放寬 timeout。

`BotDispatchService` 的群觀察／略過紀錄、maintenance worker 的政策讀取／已套用版本紀錄，以及 outbox 準備內容時的政策讀取，都會寫入資料，原本卻使用 deferred transaction。WAL 模式中先讀 snapshot、之後再競爭 writer，可能直接得到 `SQLITE_BUSY`／`SQLITE_BUSY_SNAPSHOT`，設定 busy timeout 也不能保證升級成功。前兩處修正後，完整回歸仍抓到 outbox 的第三處問題，因此逐一檢查所有政策讀取的實際寫入行為。

已改為在這些寫入工作開始時取得 `BEGIN IMMEDIATE`，等待前一個 writer 提交後才讀取最新版並寫入。outbox 發送前的 claim／政策／勿擾核對也以同一個短寫入交易完成，包含 applied revision 與必要的延後／略過標記。純唯讀政策／公開資料查詢維持讀取交易；交易內沒有網路請求，不重試已經發送的 QQ 操作，也不變更 outbox claim、重試次數或不確定投遞狀態。政策刷新在取得鎖後再次驗證資料庫可用性，防止等待期間變成未核准恢復候選。

## 回歸證據與界線

新增三個真實 worker／WAL 競爭場景：先由另一連線持有 writer 並更新版本，再要求群觀察、政策刷新或 outbox 投遞；確認提交後保留群狀態、以最新政策版本記錄 applied revision，且通知只送一次、失敗嘗試仍為零。驗證分別暫時恢復舊 deferred 實作執行這三個新測試，三項均確實失敗；隨後恢復修正，三份完整 worker／runtime／outbox spec 的 **38 項通過**。沒有增加 timeout、忽略 SqliteError 或放寬原斷言。

最終完整原生回歸 **93 檔／805 項通過**，保留 Python bot **311 項**、時間投票 bot **15 項**及三語 bot 網站連結檢查均通過。這是可重現競爭缺陷的修正，不能當作正式長期負載、真實 QQ 平台或切換後實際 web／bot 版本組合已通過；本批未部署。保留 Python worker，B01–B15 仍須持續驗收。
