# 共用 HTTP 請求契約與型別化傳輸

日期：2026-11-21。候選變更範圍：`web`；未部署。先按 `both` 檢查共用契約影響：原 Python、schema／outbox、bot 設定語意及網站深連結不變，保留 worker 的三個編譯依賴與上一版 bytes 相同。這不能取代正式運行版本組合驗收。

原架構要求共用 contracts 產生 OpenAPI 與 client。此次建立完整 v2 **請求路由／本文索引**與型別化傳輸，尚未完成完整 OpenAPI：查詢、權限及回應的逐路由綁定仍待補齊，既有網頁 API 呼叫尚未改用新 client。

## 實作

- `tools/rebuild/build-http-contracts.ts` 從實際 API 註冊程式讀取路由與共用本文 schema，產生凍結的 `HttpOperations`。支援現有詞法常數、迴圈、tuple、條件及 template 路由，拒絕未解析或歧義的本文；實際 Fastify `onRoute` 清單須逐項一致。共 194 個 v2 操作，85 個操作有本文，引用 74 個不同 schema。
- 撤銷裝置連結改用既有 `Confirm`；bot 預覽的相同本文 shape 移到 `PreviewBotPolicy`。保留預覽原驗證順序：本文、policy、允許的 kind。不把 kind 提前改為 enum，避免改變既有錯誤結果。
- `@qgroup/contracts/http` 提供 literal 操作 key、必要路徑參數及 `z.input` 本文型別，傳輸前使用原 Zod schema 正規化。路徑與 query 值編碼，拒絕整段 `.`／`..`，固定同源 credentials 並拒絕 redirect。
- client 不產生 request ID、不重試、不重播。呼叫方保留原稿、待確認結果及 domain receipt 邏輯；提供 request ID 時必須附原 request scope，送出前與當前 context 核對。獨立 receipt namespace 不取代 account／device 與 CSRF headers，不從 `/admin/` 字串推斷權限。
- JSON 回應由呼叫方指定 Zod schema；附件／圖片保留 Response stream。伺服器錯誤保留 status、code 與簡繁訊息對，格式錯誤及網路中斷維持未核對狀態，不猜測已提交結果。

## 產物與驗證

```sh
npm run check:http-contracts:rebuild
npx tsx tools/rebuild/build-http-contracts.ts --write
npx tsx tools/rebuild/build-http-contracts.ts --output /absolute/new-directory
```

輸出 273 個具名 Zod schema 的 input JSON Schema 與 194 個請求操作，記錄來源檔案 hashes。JSON Schema 無法表達任意 custom refinement；例如重複成分選擇仍由 Zod 拒絕。產物明確保留 `zodRuntimeValidationRequired=true`、`serverDomainValidationRequired=true`、`querySchemasBound=false`、`permissionBindingsComplete=false`、`responseSchemasBound=false`、`openapiComplete=false`、`releaseEligible=false`。沒有新增公開 API 參考入口。

建置先檢查生成索引，CI unit artifact 保存契約產物及 receipt。新增 32 個案例；相關五檔／52 案本機全部通過且逐項符合固定 inventory，包含實際 HTTP 註冊、session 切換、裝置連結與過期 scope 拒絕。型別檢查、完整建置及編譯服務 smoke 通過。82 個網站靜態產物及 85 個 precache 資源與上一版相同；新 client 尚未影響既有畫面。

本提交完整預期為 181 檔／2,992 unit、81 檔／843 browser；自己的原始 Linux CI 另行核對，不沿用上一版結果宣稱本版完整通過。

本機完整保留 Python 回歸也已通過並由獨立 oracle 核對：固定原版 55 個 blobs、177 個編譯 API inputs、71 次原 worker、9 次 native consumer、532 次 HTTP 及 314 個不同入口；通知、按鈕回呼、原樣回覆／鍵盤、投遞恢復與七類順序交接均保留。所有投遞為合成受控輸入，`actualQQ=false`，沒有正式版本切換。

## 原始 CI 核對

第 171 號原 run `44845679125` 已完整成功。原 unit artifact `14683933738`、browser artifact `14684868892` 及 image artifact `14682239578` 的 ZIP digest、CRC、解包 bytes、來源與 terminal logs 均已保存核對。179 檔／2,960 unit、81 檔／843 browser 與固定 inventory 一致，無跳過、重試或 flaky；85 個 precache keys 與資源 bytes 逐項一致。

第 170 號原 run 的 browser 與 image 成功；unit 有 2,905 passed、3 failed、52 skipped，失敗為既已在第 171 號修正的候選時間問題。第 169 號 browser 成功，image／unit 原失敗仍保留。沒有重啟原 CI，也沒有把部分成功算成整組成功。

上述原 browser／image 中的固定 Python bot 與 compiled TS 依賴驗證包含 71 次原 worker、9 次 native consumer、314 個不同網站入口及七類順序交接，涵蓋重試、不確定投遞、模擬及限流保留。這些是隔離受控驗證，未真送 QQ、未確認正式運行的 bot 版本組合。

166 capabilities 仍為 0 fully accepted，`releaseEligible=false`。完整 OpenAPI／網頁 client 接入、bot B01–B15、來源／reset 世代、media／browser pending、實際版本組合及切換驗收仍須完成；本輪不部署。
