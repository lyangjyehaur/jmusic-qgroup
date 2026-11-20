# 頁面按需載入與 PWA 回歸

日期：2026-11-20。變更範圍：`web`；路由頁面、公開靜態服務及隔離驗證。schema、outbox、bot 設定與既有入口不變，沒有部署。

77 個頁面元件改為 React lazy 載入；原路由 path、元件 props、LegacyLocalGuard、LegacyEntryLayout、MusicWorkspace 與外層 providers 保留。每頁的 Suspense 位於既有 layout／guard／workspace 內，下載時不移除導覽或重建共用狀態。只有必要的載入狀態文字；下載失敗沿用具體的重新整理／返回提示。原路由宣告逐字核對，只有說明頁原個別 Suspense 換成共用載入方式；這不代表所有功能已完整驗收。

本機主入口 JS 從第 153 號的 **1,483,325 bytes 降至 292,108**，Brotli 從 **359,218 降至 84,140**。其餘頁面與共用依賴分成獨立 chunks；目前共 82 個 JS／CSS。這是主入口檔大小，不能等同整個首次載入、記憶體或互動時間；PWA 仍保有完整資源 precache，背景安裝下載總量仍須量測。

實際 compiled API 的 **277 次 HTTP 檢查**逐一驗證所有 JS／CSS 的 identity／Brotli／gzip 與原建置 bytes，並檢查 entry bundles 的 conditional／HEAD、直接 sidecar 拒絕、SW／manifest／翻譯 shell。初次驗證發現靜態下載消耗全域 180 次／分鐘的 API 配額。現在只對靜態插件註冊、同一 build root、GET／HEAD 的檔案路由排除 API 限流；不依 request URL 前綴或 header 放行。新增案例驗證連續 181 次資源下載仍正常、隨後 API 的前 180 次正常而下一次為 429；已受限時公開資源仍可讀。

**2 檔／26 個不同 unit 案例、6 檔／48 個不同 browser 案例**通過；新靜態案例與 4 個新 browser 宣告以 AST 獨立核對，其餘固定 inventory 逐項保留。browser 涵蓋活動入口不下載不相關頁面、延遲下載保留 layout 且不提前操作、失敗後重新整理恢復目的地、衝突 bot 舊連結在頁面載入前拒絕，以及成分工作區／詞條、舊導覽、管理匯出與完整 PWA 回歸；沒有 skip／retry／flake，重跑不重複計数。

原 PWA QQ 登入測試在 lazy 登入頁尚未 mount 時以 `count()` 判斷同意框不存在，跳過勾選而等待 disabled 按鈕超時；頁面仍正確要求必要同意。改為等待同意框並勾選，保留全部原授權／確認／成分保存斷言。初版 47 passed／1 failed 的報告、trace 與 error context 保留；修正後整組 48／48 通過。strict、完整建置、built smoke 及固定原 Python bot plain／rich／dry-run 隔離驗證通過，仍不聯絡 QQ 或正式服務。

重新獨立 esbuild 比較本機 API bundles 的 **177 個 runtime inputs**；API 已修改，不能沿用第 153 號 runtime hashes。全量固定來源預期 **167 檔／2,677 unit、79 檔／837 browser**，仍須核對新提交的原 Linux reports 與實際 image。

第 152 號 run `44755576359` 已完整 success：原 unit ZIP `378c2328316eea326cb163af58f39e6bdef88474a19918ad6feaf62990252c4a`、browser ZIP `ea73248ec7a9bc2067605d5d5f9a9fedeba954467509d46a36c5577a7b4b872b`、image ZIP 均核對 metadata／CRC／所有 bytes，固定 unit 166／2,657、browser 78／833、三份原 job logs、image pair、55 原 Python blobs 及 176 個 compiled runtime inputs 均獨立驗證。第 153 號 run `44760849199` 的原 image／browser 與 compiled Python 已核對：image static 3 assets／40 HTTP 與本機 proof 完全相同，browser 78／833 零 skip／retry／flake；unit 仍在執行。

166 capabilities 保持未完整驗收、0 accepted、`release_eligible=false`。整個系統的資料／來源恢復、實際 bot 版本組合／B01–B15、資源規模與切換驗收持續待辦。保留 Python bot，不合入 `main`、不部署。
