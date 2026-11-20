# 完整離線快取的分批安裝與版本識別

日期：2026-11-21。變更範圍：`web`；PWA 建置、安裝與隔離驗證。沒有部署，保留現有 Python bot。

Service Worker 保留全部公開資源，改為每批最多 4 個 request、逐批等待 `cache.addAll` 完成。任何一批失敗都刪除整個新快取，安裝失敗不強制啟用；既有 active worker 與舊快取保持可用。沒有把頁面 lazy loading 當成刪減離線功能的理由。版本 digest 現在包含 root／retirement worker 的完整 compiled dependency graph；使用固定 placeholder 避免循環 hash，匯入檔案的行為改變也會產生新版本。

新增 **4 個 unit、3 個 browser** 案例。unit 執行真正編譯後 worker，驗證每批上限、逐批等待、後段失敗清理，以及只改 imported dependency 也更新版本。browser 使用真實 compiled worker 與隔離 HTTP public assets，驗證所有快取 paths／bytes／SHA、最後一批未完成時不得變成 waiting，以及後段失敗保留 active cache 並能完整重試。原始 baseline 的失敗報告保留；修正後共 **7 檔／64 個不同 browser 案例**通過，包含完整 PWA、lazy pages、成分共用工作區、簡繁與 bot 投遞恢復，沒有 skip／retry／flake。

本機建置包含 **85 個快取資源，合計 1,720,579 decoded bytes**。compiled worker recorder 的最大單次原子快取操作為 **619,197 decoded bytes／4 個資源**，同時只有 1 個 cache operation；實際隔離 Chrome HTTP host 觀察到最多 3 個並行 request，所有 browser cache bytes 與 compiled recorder 一致。這些數字描述 decoded response working set，沒有量測 encoded wire bytes、瀏覽器 heap／RSS 或正式負載；不能宣稱原 Chrome 同時下載 85 個檔案。`smoke-build` 與實際 image verifier 都接入完整 inventory／每批上限的證據，browser 另驗證真實 Cache Storage 與 worker lifecycle。

第 154 號原 Linux run `44768937282` 完整終態為 **failure**：unit、image jobs 成功；browser 固定 79 檔／837 項為 **836 passed／1 timed out**，零 skip／retry／flake。失敗的簡體跨分頁 bot retry 測試，第二分頁 review 尚未完成，第一分頁已保存 pending command；第二分頁正確顯示恢復畫面，因此新命令確認框不再存在。原 trace／report／ZIP 保留，測試改為先等待第二分頁確認框 enabled，再送第一個命令；保留版本衝突、兩份原稿與單次 command 的全部斷言，沒有修改 retry runtime。

strict、完整建置、built static **82 JS／CSS／277 HTTP 檢查**、built smoke，以及固定原 Python plain／rich／dry-run 隔離測試通過。API bundles 的 **177 runtime inputs 與兩份 compiled hashes 完全等於第 154 號**；本批没有 schema、outbox、bot 設定或 bot 網頁入口變更。原 Python 合成模式不等於正式 bot 版本組合或真實 QQ 驗收。

新固定來源的全量預期為 **168 檔／2,681 unit、80 檔／840 browser**，仍須取得並逐項核對原 Linux reports、job logs 及實際雙映像。第 153 號原 run `44760849199` 已完整 success，其 unit／browser／image 原 ZIP、固定 inventory、三份 job logs、55 原 Python blobs、177 compiled runtime inputs、實際雙映像與清理均已獨立核對。

166 capabilities 保持未完整驗收、0 accepted、`release_eligible=false`。完整來源 ancestry／epochs、最新刪除歷史、瀏覽器與媒體待完成操作、停止 capture、實際 bot 候選組合／B01–B15／QQ、正式規模資源與切換驗收持續待辦。不合入 `main`、不部署。
