# 第四十五批實作：TypeScript bot 連線與診斷基礎

日期：2026-11-17（Asia/Taipei）。分支 `codex/unified-rebuild`。發布範圍 **`none`**：新增尚未接替正式服務的隔離 TypeScript 模組與建置驗證，未整合 main、未部署。schema 維持 14／94 張表；既有 Python bot、正式啟動設定及 outbox 不變。

## 已實作

`apps/bot/` 提供同專案的原生 TypeScript transport library；不包裝或執行 Python。建置輸出 `.rebuild-dist/bot/transport.mjs`。沒有自動執行、資料庫連線、outbox claim、正式發送迴圈或 `start:bot` 入口；匯入模組不讀取環境檔、不寫入日誌或開啟網路。測試與本機平台 fixture 不進入 bundle。

- **設定**：沿用 QQBOT／KANBAN 環境變數、部署預設 dry-run、Markdown opt-in、intents、輪詢／租約參數、URL allowlist 與日誌位置。可選環境檔僅解析 KEY=VALUE，既有環境優先，不執行 shell。檢查憑證是否設定、SQLite header／讀寫與 API URL；診斷不輸出憑證或完整群 ID。非有限數字與不安全整數拒用並回預設。
- **OpenAPI**：原生 fetch，15 秒期限、1 MiB 回應上限、不跟隨 redirect。token 共用並行刷新、新舊 host fallback、提前 120 秒刷新及至少 60 秒快取，沿用 Python token 壽命公式。單一等待者取消不取消其他 token 等待；關閉 client 取消所有等待。
- **投遞結果**：沿用 `code`／`err_code` 非零優先、永久拒絕／群授權／頻控／暫時錯誤分類。只有 HTTP 200 且結構正常、無平台錯誤才確認群訊息成功；其他 2xx 保留未確認狀態。只對 401／11241／11242 刷新 token 並重試一次，不在 transport 自動重送超時、頻控或未確認訊息。互動 ACK 支援 200／204；Markdown 與普通 content 互斥，保留 msg_id／event_id／msg_seq。面板使用 scope／panel.items，既有群面板不重建。
- **Gateway**：原生 Node WebSocket，Identify／Resume、READY／RESUMED、主動心跳及平台要求心跳、ACK 健康時間、HELLO／READY 期限、2–60 秒重連退避、三次 Resume 失敗清除會話、op 9 清會話及 op 7 重連。預設只准 WSS；本機模擬須明確開啟 loopback WS。
- **事件處理**：業務 callback 有序，最多 128 項（含執行中），每項預設 30 秒；callback 不阻擋心跳。Resume sequence 只推進到成功完成的 callback，保留連線實際收到的另一個 sequence 供心跳使用。失敗、滿佇列、超時或斷線會取消本次 signal，丟棄未完成佇列，不將舊 callback 晚結果寫入新連線狀態。非法 READY 在呼叫業務前拒絕。停止時清理連線 listener、心跳、期限與退避計時器。
- **診斷**：AsyncLocalStorage 保持非同步 trace；群／事件／訊息／session 使用雜湊 reference，endpoint 遮罩群與 interaction ID。預設只記文字長度／hash；明確啟用內容時遮罩憑證、網址、提及與授權值。安全錯誤只保留類型及有限檔名位置。JSONL 沿用 Python 檔名、5 MiB 輪替＋4 份備份、0600，拒絕 symlink／hardlink；寫入失敗保留 console。health 使用私人暫存檔 fsync 後 rename，沿用 Compose 所需檔名、秒時間欄位及 ACK 語意。

Close code 依 [QQ 官方 gateway 錯誤碼表](https://bot.q.qq.com/wiki/develop/api-v2/gateway/error/error.html)（2026-11-17 查閱）：4001／4002／4010–4014／4914／4915 停止重連；4006／4007／4900–4913 清除 session 後 Identify；4008／4009 可 Resume。未列出者使用有退避的 Resume；不套用其他平台的 close code 定義。

## 隔離驗證

新增 **4 檔／26 項測試**：

- 以實際 Python `Config`、`api_code`、`classify_error`、`text_fields` 差分預設／環境語意、錯誤分類、Unicode metadata 與 opt-in 遮罩；只傳入合成環境。
- token 併行刷新／取消／到期／fallback、一次 auth retry、HTTP 200 內的業務錯誤、畸形資料、未確認 202、204 ACK、互斥回覆及面板 schema。原生 fetch 連本機 HTTP server，檢查 redirect／大回應／畸形內容及日誌不含原始憑證、群、訊息或 interaction。
- fake socket／時間驗證 Identify／Resume、未完成事件保全、失敗／逾時／佇列滿、從未 ACK、正常 ACK、invalid session、平台重連、三次 Resume 失敗、close-code 政策、連線期限、畸形 frame、退避上限、停止清理與 replay 去重。另以原生 Node WebSocket 連本機 RFC6455 fixture，實際完成握手、心跳 ACK、斷線 Resume 及事件處理。
- 日誌私有權限、四份備份、重開、IO 失敗、symlink／hardlink 拒絕、並行 trace、內容遮罩及 Python／Compose health 欄位。

`test:build:rebuild` 另匯入實際 bot bundle，在阻止 fetch／WebSocket 的情況確認匯入不開網路、不改環境或建立檔案；再以本機 HTTP／原生 WebSocket 驗證 token、Identify、ACK、Resume 及 202 只發一次。原有 API、分房 worker、SQLite／sharp、配對備份／恢復啟動封鎖與 SPA smoke 同時保留。

完整回歸 **77 檔／605 項通過**；既有 Python bot **311 項**及時間投票 bot **15 項通過**。strict TypeScript、重構建置、既有 UI 產物、capability ledger、diff check 與完整 built smoke 通過。本批未修改網站互動或畫面，未重跑瀏覽器全套；上批分房流程的證據仍見 50 號檢查點。bot bundle 約 37.1 KiB；前端仍為 1,121.84 kB（gzip 327.94 kB）、CSS 122.22 kB，API 約 679.7 KiB、分房 worker 約 80.8 KiB。前端大 bundle 及正式規模資源門檻仍未完成。

## 尚未完成與接續工作

這是供完整 worker 使用的 transport 基礎，**不是完整 TypeScript bot**。B13／B14 改為 `in_progress`，不標記通過；所有 166 項仍保留，0 項完整驗收，`release_eligible=false`。

接續仍須完成所有既有指令／別名／被動回覆、按鈕事件去重與每次驗群／權限、群設定與模板版本、限流／勿擾、縮寫與敏感詞、outbox 租約／重試／模擬／不確定投遞、完整 runtime 與統一後台。callback 的取消 signal 仍須由未來業務處理器配合，在外部操作及資料庫寫入前檢查；transport 不能撤銷已發生的副作用，也不承諾恰好一次投遞。群授權與身份限制不能由 transport ID 格式驗證代替。

保留 Python bot 直到新 worker 的 B01–B15 及跨領域功能完整驗收。合成本機平台不等於實際 QQ、線上版本組合或正式投遞驗收；沒有使用正式憑證、資料、群設定或待送工作。本批不提供切換入口，不改正式 Compose，也不啟動第二個投遞者。

public v1／舊網址 adapters、PWA／持久草稿、簡繁語系、完整後台、正式副本對帳、實際運行 web／bot 組合、全量規模資源與回退演練仍依原計畫持續處理。使用者指定先不部署。
