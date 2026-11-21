# 契約建置輸入與原操作編號

日期：2026-11-21。候選變更範圍：`both`；建置設定涵蓋 web 與 bot，尚未部署、未整合 main。既有 Python bot、schema／outbox 與正式資料不變，完整 bot 與候選映像組合仍須驗收。

第 172 號原 image job `136684387509` 在建置步驟失敗：`build:rebuild` 已加入契約生成檢查，Docker build stage 卻未包含 `tools/rebuild/build-http-contracts.ts`。原 run `44851728801`、artifact `14685781248` 的 ZIP digest／CRC／bytes 與 terminal log 已核對保存；只有 source receipt，沒有映像驗證結果。原 unit／browser 工作繼續觀察，不重啟該 run。

此次將生成工具加入 Dockerfile 的 COPY 及其專用 dockerignore allowlist。工具只進 build stage；執行映像仍取編譯產物與已裁剪的依賴。獨立複製建置輸入時，也發現本機根目錄 tsconfig 與容器省略根 tsconfig 的情況會產生不同 API bytes。`build-api.mjs` 的所有入口現明確使用 `tsconfig.rebuild.json`，涵蓋 API、資料庫、包間工作及 bot 入口，不依所在目錄猜測設定。

新型別化 client 的 caller request ID 現透過原後端使用的 `Idempotency-Key` 傳輸，仍要求原 request scope；不改成自動產生識別或自動重試。實際 HTTP 測試從註冊、session／裝置驗證接到成分保存：同一編號重送取得同一原結果，改內容則回傳 `409 REQUEST_CONFLICT`，只有一筆保存 audit 與一筆 request result。本文內的 domain request ID 仍由原呼叫流程保管，沒有自動改寫為 header ID。

## 驗證

- 三檔／34 個既有案例全部通過，逐項符合原固定 inventory。擴充實際 HTTP 情境，沒有新增、刪除或跳過案例；未合入 main 的 release source 拒絕仍是預期測試結果。
- 本機完整建置、型別檢查及生成索引檢查通過。API／保留 worker 依賴與網站資源仍和第 172 號本機回歸的 bytes 一致；固定原 Python 55 個 blobs、71 次原 worker、9 次 native consumer 及交接證據保持適用。這不是正式版本組合確認。
- 在新的隔離目錄，依 Dockerfile COPY 與專用 allowlist／測試排除範圍組合九項輸入，重新 `npm ci` 後完整建置。固定編譯設定後，246 個生成檔與工作目錄逐檔 bytes 相同。先前未正確模擬目錄複製／排除範圍的測試準備與失敗輸出另存，不當成成功。
- 上述獨立目錄驗證在本機 macOS 執行；本機 Docker daemon 未運行，沒有啟動它。實際 Linux 映像建置與版本組合由本提交自己的原 CI 驗證，不能以本機建置代替。

完整預期維持 181 檔／2,992 unit、81 檔／843 browser。完整 OpenAPI 的 query／permission／response 綁定與網頁 client 接入仍待完成；既有前端 durable 操作尚未改用新 client。166 capabilities 仍為 0 fully accepted，`releaseEligible=false`，不部署。
