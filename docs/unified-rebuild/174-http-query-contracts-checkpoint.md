# 共用 HTTP 查詢契約

日期：2026-11-21。候選變更範圍：`both`；共用契約改變編譯輸入與部分 bot／web 產物雜湊，按兩邊驗證。未部署、未整合 main，不修改原 Python bot、schema／outbox 或正式資料。

## 實作

將 28 個 API 模組的 42 處原查詢驗證移到 23 個共用 Zod schema，保留各自 coercion、預設值、strict 模式、Unicode 長度、游標範圍與 custom refinement。獨立 AST oracle 逐處展開原局部 `version`／`cursor`／`query`／`pageSchema` 與新共用定義，42 處語法及引用完全等價；原 handler 中的驗證與權限順序不變。沒有順便放寬原限制。

生成索引仍對齊實際 Fastify 的 194 個 v2 操作，其中 85 個有本文、47 個有查詢驗證。來源分析追蹤詞法 helper 與迴圈路由，涵蓋三個 bot delivery 清單入口及活動／投票、帳本、裝置歷史、通知、成分與管理查詢。拒絕裸讀 query、inline schema、歧義 schema 或未納入路由圖的 query helper。OAuth 非 v2 callback 保留原獨立協議。每個操作都有 query descriptor；`null` 表示原 handler 不使用 query，保留原先忽略額外參數的行為，不改成 strict empty。

型別化 client 現依路由提供 query 欄位型別，先編碼為實際傳輸字串，再以共用 Zod 驗證。保留原網址，不將預設值、trim 結果或 `BigInt` 輸出重新寫入 query。呼叫方仍持有 request ID／scope、原稿與未知結果，client 不自動重試或重播。既有網頁 durable 呼叫尚未接入新 client。

參考產物共 296 個具名 Zod schema，記錄所有受掃描 API 模組與共用契約的來源 hashes。`querySchemasBound=true`、`queryWireValues=strings`、`queryZodValidationRequired=true`；input JSON Schema 仍不足以表達任意 coercion／refinement。`permissionBindingsComplete=false`、`responseSchemasBound=false`、`openapiComplete=false`、`releaseEligible=false`，完整 OpenAPI 的參數描述、權限及回應綁定仍待完成。

## 驗證

- 新增 16 個案例，完整預期為 182 檔／3,008 unit、81 檔／843 browser。三個契約相關檔案／48 案與跨領域 30 檔／349 案全部通過，逐項符合固定 inventory；包含原 HTTP 註冊、裝置、成分冪等保存、有效歷史游標、client 傳輸前拒絕及伺服器直接拒絕無效游標。
- 型別檢查、完整建置與 compiled smoke 通過。共用 exports 改變了部分模組排列與 hashed URLs，沒有沿用舊資源 hashes。82 個靜態資源及 85 個 precache 的原 bytes、Brotli／gzip 解壓、hash／大小均已核對；precache 合計 1,721,238 bytes，最大批次 619,252 bytes，仍最多四個資源、一個 cache 操作，沒有強制啟用新版 worker。
- 三檔／16 個 PWA 與按需載入 browser 案例全部通過，原 IDs／名稱／位置一致，無跳過、重試或 flaky；實際 precache keys 與 85 個資源 bytes 逐項一致。
- 保留 Python 的完整隔離回歸通過並由獨立 oracle 核對：固定原版 55 個 blobs、178 個編譯 API inputs、71 次原 worker、9 次 native consumer、532 次 HTTP 與 314 個不同入口。通知、回呼、原樣回覆／鍵盤、重試／不確定／模擬狀態及七類順序交接保留。沒有真送 QQ 或正式版本切換。

## 原始 CI

第 173 號原 image job `136688487673` 已成功。原 artifact `14686811529` 的 13 個檔案、ZIP digest／CRC／解包 bytes、來源與 terminal log 已核對保存；實際 Linux 映像、Compose、web／bot 版本、候選 manifest 與固定原 Python 映像配對均通過原驗證及獨立核對。候選 manifest 身份相符仍不代表正式來源授權、完整功能或正式版本組合放行。

第 172 號原 unit job `136684387759` 也已成功：181 檔／2,992 案全部通過，固定 inventory 一致；原 artifact `14687420413` 的四個檔案與原契約來源 hashes 已核對。該版 image 原失敗保留，不能記為整組成功。第 172／173 號其餘原工作繼續觀察，不重啟；本提交自己的完整 Linux CI 另行核對。

166 capabilities 仍為 0 fully accepted，完整 bot B01–B15、來源／reset 世代、media／browser pending、實際版本組合及切換驗收尚未完成，`releaseEligible=false`。完整重構目標保持不變，本輪不部署。
