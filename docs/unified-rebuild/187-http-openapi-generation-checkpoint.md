# HTTP OpenAPI 生成與驗證

日期：2026-11-21。變更範圍：`none`（開發工具與契約文件生成）；實際部署：`none`。未整合 main，保留 Python bot。

契約生成器現在從現有 handler 與共享契約輸出 `openapi.json`，並在 `--check` 和輸出前驗證 OpenAPI 3.1.0／JSON Schema 2020-12。包含全部 194 個 v2 操作、85 個 request body、47 個 query 操作，以及 423 個 component schemas（296 個原 request／shared schemas、127 個 response schemas）。現有操作與 schema 未改變；JSON、圖片 MIME、管理員 attachment 及 `ApiFailure` 有對應表示，遞迴 schema 的本地參照重新定位至各自 component，保留原 literal JSON、nullable 讀取與不可為 null 的保存回應。

驗證使用未修改的官方 2022-10-07 OpenAPI schema，完整來源與 Apache 2.0 license 納入專案。schema 為 33,992 bytes，SHA-256 為 `da01ba28852cac0de53893797cb8d1942bc3b05084f526dcc216717dec314ed0`。Hyperjump 執行完整 2020-12 驗證；另以獨立 Python jsonschema 4.23.0 核對生成文件及 591 個本地參照，拒絕外部／懸空參照和缺少必要內容的文件。生成文件 SHA-256 為 `4c0c0924690fc05ad05afebd721de41a515feaaf452c9d056787cea4365b9af8`。

權限綁定與精確 path constraints 尚未完成，文件明確標記為 false；path 目前描述為 string 並要求 server 驗證。沒有虛構全站登入要求，匿名入口、visitor、member、credential administrator 與 proof-based 操作仍須依實際 handler 逐項綁定。`openapiGenerated=true` 不代表 `openapiComplete=true` 或功能驗收通過。

## 驗證與運行影響

- strict、完整建置及 compiled smoke 通過。3 個相關 unit 檔案／16 個案例全部通過，其中 8 個新案例與獨立 AST inventory 一致。全站固定 inventory 現為 188 檔／3,102 案例；本輪未執行全套 unit。
- PWA 的 1 個原 browser 檔案／3 個案例全部一次通過，原 ID、標題、位置一致，無 retries、skips 或 flaky。precache attachment 的 requests、keys、bytes 與 hashes 逐項符合靜態資源。
- 81 個靜態資源、140 個壓縮表示、274 次 HTTP 檢查通過；84 個 precache 共 1,772,091 bytes，最大原子批次 575,463 bytes，數量及大小與 186 相同。
- 243 個 runtime 檔案中 239 個逐位元組相同，包括全部 3 個 API、9 個 bot 檔案及前端程式資源。4 個差異為 HTML、service worker 及 worker 的 br／gz；PWA fingerprint 包含整份 lockfile，新增開發依賴使 build ID 改變。獨立重新計算原／新 lockfile fingerprint，並正規化 ID 及解壓 sidecars，確認只有快取版本 metadata 不同。未改動應用程式、資料庫、設定、outbox 或 bot 網頁入口。
- 142 個契約輸入 hash、1,442 個受測來源 pins 及完整受測 runtime 副本均核對一致。提交封存另核對 exact commit；測試後僅新增本 checkpoint 與更新兩個 README，這三個文件不算受測程式。

初始 AJV 官方文件驗證對同一 resource 中的 dynamic anchor／reference 處理不符，錯把內部 Schema Object 套用 parameter 限制；原錯誤、文件與 log 保留，改用 Hyperjump，沒有修改官方 schema 或放寬驗證。初始完整建置另揭露 validator 的 JSON 型別不相容，改以實際 `Validator` 型別及 `z.json().parse` 驗證輸入，保留原編譯診斷。最終建置與 16 案例通過。

## 原 CI 的完成結果

185 的原 CI `44888159779`（`45297a0eee899cf1fdbffb1151fac58b9b24f7fa`）與 186 的原 CI `44889335523`（`16deba40cb226cb6d7af9a09c3631722ef4be593`）均已完成 success，未取消或重跑。185 的 186 檔／3,080 unit 案例、186 的 187 檔／3,094 unit 案例，以及兩輪各 81 檔／844 browser 案例均通過，原 ZIP digest、CRC、解包 hashes、固定 inventory 與原 precache attachment 已独立核對。186 初次 browser 稽核誤選本機 14 案例 inventory 而被拒絕，改用另外保存的 844 案例原 inventory 後通過，未改動報告或測試。

兩轮實際 Linux image 與固定原 Python image 的隔離配對、runtime manifest，以及 exact source 重建的 source／harness manifests 已核對，包含 55 個原 Python blobs、71 次 worker invocation、9 個 native consumers、314 個深連結與原 domains／recovery／handoff 模式。這些是禁止網路的 synthetic 驗證，不能取代實際線上 bot 版本組合及完整 B01–B15 驗收。

證據目錄：`http-openapi-generation-187/`；185／186 原 CI 收據分別保存在 `canonical-response-adoption-185/` 與 `structured-export-binding-186/`。166 capabilities 仍為 0 fully accepted，`releaseEligible=false`。完整權限、來源／reset、media、bot、切換與回退驗收仍待完成；未操作正式資料、真實 QQ 或正式服務。
