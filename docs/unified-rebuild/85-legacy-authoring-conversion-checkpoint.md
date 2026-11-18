# 第七十九批實作：舊活動／投票草稿轉換與來源映射

日期：2026-11-18（Asia/Taipei）。分支 `codex/unified-rebuild`。變更範圍 **`web`**，實際發布範圍 **`none`**。只使用隔離 fixture 資料庫、瀏覽器 context 與 mock QQ；未合入 main、未部署，未操作正式 bot、憑證、群設定或待送工作。

## 實際帶入新版表單

舊看板本機紀錄現在可將完整活動／複製活動及時間投票稿，經檢查、時間對照與明確確認後，帶入真正的新版 TSX 編輯器。支援原 `fields/dataset`、日曆投票 `fields/slots/intent`、更早的 `option_count/slot_i/deadline` 及目前 `{react:1,value,revision}` 格式。原 `kanban-local-v1`、保全快照與原欄位保持可查／可下載；帶入不會送出網站建立、更新或原 POST 請求。

原文字不 trim，原人數空輸入仍為空，設定、修改原因、建立 UUID 與候選順序保持。未知／重複欄位拒絕轉換；投票動態欄位須與 slots 的 key、日期、時間逐項一致，早期 slot 欄位须完整符合 option_count。額外候選、缺失候選、重複 key、空值不一致及混合兩種候選协议均不能被靜默略過。投票提交時才嚴格轉換整數，metadata 不進 API payload。

原建立 UUID 先走只讀 create-intents 查詢。已建立活動帶入目前草稿或安排的固定 ID，後續文字保持；原 revision 保存於 metadata，缺失／恢復 sentinel 不當成可直接保存的版本。保存、發布與刪除按鈕在完成「核對目前安排，保留輸入」前停用；載入最新版本只更新基準、顯示對照，不替換輸入。已建立投票的後續稿保持只讀，連到原投票，禁止另建或改寫既有候選。

原 `ui/board/recovery.ts:markEventCreated()` 會在原 form key 內保存新 ID 與 revision -1；原 JavaScript 也可能在清除失敗前於 event:new/copy key 捕捉已分配 ID。本批辨識這些合法恢復格式，要求有效原 UUID 且伺服器結果 ID 一致。缺回執、ID 不符、無權限或未知版本仍保全並拒絕另建。這補充檢查點 84 對 form key／ID 一致的描述，不能將所有原 new key 內的已建立 ID 當成損壞。

## 時間與確認

活動原 wall time 按保存的 IANA 時區解析，轉為新版固定台北 UTC+08:00 輸入。凌晨隔日使用日曆加日，不以經過 24 小時推算；依原 JavaScript ±36 小時 offset 搜尋規則拒絕 DST 重複、缺失時段、跳過日期及無效日曆。日期投票截止沿用原選定日 23:59；精確投票保留明確 UTC 時刻，日期候選維持日期與原順序。

沒有保存原時區時不推測裝置時區，提供明確補填欄位。未完成日期、凌晨偏移或歧義時間保留原文字與原因，目的時間留空，需於表單補齊。轉換前逐項显示原值／帶入值／原時區與未解決事項，确认只帶入而未送出。補填時區的可及性名稱與提示分開，提示透過 aria-describedby 關聯。

## 提交與競爭保全

`qgroup-legacy-local-v1` 保全庫升級為版本 2，保留 snapshots／state，新增 mappings；映射記錄原 SHA256 快照、採用來源、目的 key／route 與 device epoch。登出在同一保全庫交易清除快照和映射、增加世代，並沿用原來源清除流程。既有版本 1 原資料及 epoch 升級保全有瀏覽器驗證。

目的草稿以 strict transaction／CAS 保存後，才提交來源映射；兩個 IndexedDB 不能宣稱跨庫原子提交。目的提交成功、映射交易失敗時，不回報成功，也不解除來源阻擋；精確相同 staged raw 可明確重試完成映射。目的已有不同稿須先勾選保全，舊目的稿進版本庫；已有 pending 一律不能覆寫。競爭目的稿保持，嘗試帶入稿進衝突保全庫，沒有成功映射。

來源／目前 session／頁面與 device epoch 在關鍵階段重新驗證，切帳號、登出、世代改變及原來源更新均拒絕繼續。準備及目的保存後重新讀取相關來源，將相同意圖的歷史稿與原確定性請求一併保全。映射後才出現的 pending→done 快照可由「核對後續原建立請求」明確歸入原映射；不替換已採用的目的稿、不重送原請求。不同或未知意圖仍阻擋相關操作，不推測它們已被覆蓋。

活动與新投票在建立新 pending 前重新核對本機舊紀錄，避免編輯器開啟後才出現的來源被忽略，或先寫入 pending 再被遷移阻擋。已保存的精確 pending 重試維持原 payload／UUID。這是應用層再驗，並非與舊頁寫入共用原子鎖；同源舊頁停寫、所有未映射來源解決及切換成套驗收仍是正式切換條件。

## bot 與驗證

本批只修改前端本機草稿／轉換流程，沒有改動 schema、API 業務、outbox、模板、網址或 Python／TypeScript bot。帶入不排入 bot 工作；活動仍由既有草稿／發布規則處理，投票仍用原 create-intent 去重及通知 hook。發布來源與實際候選版本組合尚未驗收，不能把本機測試當成可正式單邊發布的證據。

- strict TypeScript 與 React／API／bot build 通過，既有 bundle 大小警告仍存在。
- 轉換／原稿保全、原結果／建立識別、草稿／投票、身份／活動／管理 bot、隱私及 outbox 共 **96 項原生測試通過**。含與原 JavaScript 時區解析差分、DST／日曆邊界、早期候選欄位 coverage、原 Python 回執及 mock bot 保全。
- 擴大回歸 **134 項瀏覽器場景通過**，含 23 項新增轉換場景，以及原保全、建立識別、草稿／投票、財務／結算／原圖、共用原稿、音樂詞條、登入／裝置／隱私。最後補嚴格的來源 request key 對應後，受影響轉換與原保全 **37 項重跑全部通過**。
- 建置後 API、bounded room worker、bot HTTP／WebSocket／ACK／Resume／原生 runtime／SIGTERM、未知投遞與備份 smoke 通過；沒有真實 QQ 投遞或正式 worker 操作。
- 360px 時間對照元件人工檢視通過；瀏覽器操作流程檢查無水平溢出。合成截圖 `test-results/unified-legacy-time-review-mobile.png`，測試重跑會清除此目錄。
- 最初一次瀏覽器執行使用了尚未重建的前端 bundle，該次結果不作驗收證據；重建後補修時區 label 與測試的 preview 完成等待，再全數重跑。沒有跳過測試或停用限流。
- 能力台帳檢查保留 166 IDs，0 項完整驗收，`release_eligible=false`。

## 剩餘工作

包廂、款項、結算含原圖／收款碼的逐欄位轉換仍未完成。不同建立意圖或未知競爭稿的明確保留／分類流程、已採用原稿退休後的來源目的查回、非建立原命令的精確 adapter、特殊身份／授權入口、匯出重新匯入，以及原裝置／QQ WebView 與實際 web／bot 候選版本組合仍待完成。

本批活動／投票轉換是隔離實作與部分驗收，完整本機遷移、全部 166 項、B01–B15 成套相容性、完整資料對帳及新寫入回退未驗收。台帳全部保持 `in_progress`，`release_eligible=false`；完整重構目標持續進行，依使用者要求不部署。
