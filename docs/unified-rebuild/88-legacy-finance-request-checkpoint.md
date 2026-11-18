# 第八十二批實作：舊款項原請求恢復

日期：2026-11-18（Asia/Taipei）。分支 `codex/unified-rebuild`。變更範圍 **`web`**，實際發布範圍 **`none`**。只使用隔離 fixture、瀏覽器 context 與 mock QQ；未合入 main、未部署，未操作正式 bot、憑證、群設定或待送工作。

## 沿用兩個原識別與原預覽

`舊看板本機紀錄` 新增原 `POST /api/events/:id/finance` 的檢查及明確重試。支援 fields 與 React 客戶端實際送出的八種命令、十種款項；不將待確認請求轉成另一筆新版操作。

原本機 key 的 SHA-256 指紋（method、path、`JSON.stringify(data)`）與原後端隨機 32 位十六進位 requestKey 分別保留。前端重驗本機內容指紋；後端沿用 Python sorted Unicode JSON 簽名計算，簽名使用未改寫的原 body。原 ID、revision、預覽 token、實際時間、金額、原因及欄位不換成新的操作決策。

解碼只接受已對應欄位。原不生效的已知欄位按 Python prepare 行為忽略；public 客戶端自訂人員附帶的 label 保留於來源與簽名，但不成為款項人員姓名。缺省 method、note、reason、custom_parties 及 refund funding 沿用原規則；reverse／reopen 的原因必須非空。未知欄位、未支援路徑或不合法的 active 欄位保持阻擋。

## 檢查、提交與回執

新增 `/api/v2/me/legacy-requests/finance/inspect` 與 `/retry`。兩者驗證目前 session、scope、Origin、CSRF、活動存取與命令權限。檢查不寫入業務資料；既有匹配回執只回傳已提交及目標活動。回執簽名不符、JSON 損壞或結果活動不同時阻擋，不展示原快取的私人內容。

缺回執時，檢查原 revision 並比較原預覽 token；不核發替代決策。新版帳本、名冊、原款項 ID 或申報決定與原 proof 不一致，就保留原請求並要求核對。重試仍在提交時重新檢查，且要求 `confirm:true`。

原生帳本寫入與恢復共用 `executeFinance`，維持 ledger、申報決定、audit、本人通知及 bot hook 的既有語意。恢復以 immediate SQLite transaction 將業務資料與原回執一併提交；回執失敗則全部回滾。原生 UUID／v2 簽名與原 requestKey／Python 簽名保持各自規則；並行重試只提交一次。

新恢復回執只保存 `{id,starts_at}`。原 Python `/api/requests` 與 replay 路徑看見 starts_at 會按目前權限重新 serialize 活動，避免保存凍結的 owner／私人活動快照。既有原回執不改寫。

## 實際核對與本機確認

核對畫面與原生帳本共用款項明細，顯示類型、金額、款項歸屬、實際人員、資金流向、店家、時間／方式、備註／依據與關聯記錄；並顯示操作後資金、申報／沖正目標及結清版本／帳本檢查點。只新增操作所需資訊。

檢查時保留 device epoch，提交與保存前後重驗 session、來源、頁面有效性及 epoch。已提交的方案在最終確認只再 inspect，不能因回執消失而改走 mutation。只有已證明 committed 才保存 `kind:'request'` 映射，目標指向該活動帳本及原 requestKey。來源原字節仍保留；同一個精確原請求且本機指紋一致的已保全歷史狀態可以一起核對，其他或未知來源仍阻擋新操作。

strict IndexedDB mapping transaction abort 不算成功。網站已提交但 HTTP 回應遺失、關頁或本機映射失敗時，可以重新 inspect 原編號並明確保存核對結果，不重複記帳。兩個 IndexedDB 仍沒有跨庫原子鎖；舊頁停寫、來源退休及目的版本查回依舊是切換條件。

## bot 與驗證

沒有修改 schema、outbox、群政策、模板、設定、bot 深連結、Python／TypeScript worker 或原生財務 API 契約。恢復產生的結清／重新開啟卡與私人款項通知，已由保留中的 Python OutboxWorker 在合成副本消費；group 兩筆各模擬送一次，第二輪不重送，私人通知不含交易備註。這是本機相容性證據，不能代替候選正式 web／bot 版本組合驗收。

- strict TypeScript、React／API／bot build 通過；既有大 bundle 提示保持。
- **130 項不同原生測試通過**：原財務請求恢復 11 項，共用財務／結算、原回執、活動／身份／管理 bot、投票與 outbox 88 項，原結算／包間／收支／活動投票轉換 31 項。恢復包含 Python 十種款項及八命令差分、自訂人員 label、原預覽、並行／衝突、損壞／錯誤目標回執、權限與安全邊界、required receipt 回滾及保留 Python worker 的模擬投遞。最後新增的損壞回執與恢復 worker 驗證已重跑該 11 項。
- **117 個不同瀏覽器場景通過**：新增原請求 16 項及既有 101 項。涵蓋兩種客戶端 payload、兩種 key、檢查不寫入、明確重試、原 body、已提交只查回、回應遺失／關頁、mapping abort、來源／指紋／帳號／epoch／登出變更、其他 key 提交後阻擋、同請求歷史來源一併保全、未知來源仍阻擋與核對後開放新表單。
- 360px 無水平溢出，人工檢視 `test-results/unified-legacy-finance-request-mobile.png`；測試會重新產生合成截圖。
- 首次新增瀏覽器驗證有四個測試設定問題：誤用不存在的活動編輯路徑、未等待來源重新讀取、對多快照使用單一 locator，以及預期訊息未涵蓋先發生的 revision 阻擋。已改用原生財務寫入推進版本、等待實際快照數、逐份核對及核對實際錯誤；完整 116 場景通過；最後再補同 body、錯誤本機指紋的晚到來源阻擋，完整 16 項原請求場景重跑通過。未跳過場景、放寬限流或修改正式資料。
- 隔離 build smoke 通過：API、bounded room worker、bot HTTP／WebSocket／ACK／Resume／原生 runtime／SIGTERM、未知投遞與配對備份；沒有真實 QQ 投遞。
- 台帳保留全部 166 IDs：161 項 `in_progress`、5 項 `planned`，0 項完整驗收，`release_eligible=false`。

其餘原請求 adapters、拒絕／失效原請求的明確退休、來源目的版本查回、匯出重新匯入、特殊授權入口、完整資料對帳、實際裝置／QQ WebView、正式副本、候選版本組合與新寫入回退仍需完成。重構目標持續進行，依使用者要求不部署。
