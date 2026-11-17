# 第四十七批實作：TypeScript outbox consumer

日期：2026-11-17（Asia/Taipei）。分支 `codex/unified-rebuild`。發布範圍 **`none`**：新增隔離 consumer 與驗證，未整合 main、未部署，未使用正式憑證、群、資料或待送工作。schema 維持 **14／94 張表**；保留 Python bot 與正式 Compose。

## 已實作

`@qgroup/bot/worker` 提供原生 `BotOutboxWorker`，另建置 `.rebuild-dist/bot/outbox.mjs`。呼叫者明確提供資料庫、設定、部署政策預設、同專案的 TS 組合服務與 API。它不執行 Python、不啟動 HTTP 服務，匯入不開資料庫、寫檔、開網路或開始輪詢；尚無正式 bot 啟動入口或完整 runtime。

- **claim／回寫**：同一 SQLite immediate writer transaction 依 due／retry／過期 lease 取得有界批次，逐筆生成新 token。發送前、上傳後及所有回寫檢查所有權，舊 token 不能改寫新 claim；發送期間續租，資料庫交易不跨網路等待。同一實例拒絕重疊輪詢，逐筆錯誤不阻斷其餘可處理工作。
- **設定與權限**：同一份共用政策決定開關、種類、群與 dry-run，記錄實際讀取 revision。發送前重新核對 revision、目的群、公開性、群同步、活動／投票狀態與提醒 key；變更設定即延後重組。私人未綁定工作維持不可改送群聊。恢復候選資料庫拒絕 claim、輪詢及回寫。
- **組合與安全檢查**：提醒使用當前名單與安排重建，時間投票排除已過期候選；既有事件通知仍保留凍結事實，僅從最新模板與相同安排的當前倒數狀態重新組合。普通文字、Markdown 與跳轉按鈕共用域名檢查，保留 4000 codepoints、控制字元、空內容與媒體欄位限制。QQ 請求不會同時攜帶普通 content 和 Markdown；平台拒絕 Markdown 不自動改送普通文字。
- **重試與延後**：沿用 15 秒指數退避、900 秒上限與最大失敗次數；頻控延後 60 秒且不花失敗次數；勿擾與最小發送間隔使用持久 pacing。模擬保留實際組合內容／設定版本／群 reference，不寫 sent_at；改回實際模式不重播模擬紀錄。HTTP 201／202 等結果不確定時停止自動重試，保留人工核對原因。
- **收款碼**：核對最新結算版本、原發布者目前的 settlement scope、group_notice 及凍結碼的完整描述。缺少有效結算版本的碼工作拒用。每張碼獨立工作，對應文字未確認送出前不發圖；以私有 Base64 上傳及 `srv_send_msg=false` 取得 file_info，上傳後再驗 claim、版本、群、公開性與權限，才發圖片消息。重試單圖不重送已確認文字／其他圖片，持久紀錄不存平台 file_info 或上傳原文。
- **群授權**：沿用按群 hash 的 refusal 檔名與舊部署群檔案 fallback，0600 私有檔案、原子替換，拒絕 symlink／hardlink 或過大畸形檔案。拒絕按每批快照讀取，避免第一筆寫入 refusal 後漏掉同批其他筆的有界處理；下一批重新載入持久狀態。I/O／解析異常保守失敗，不忽略既存損壞狀態而直接發送。
- **取消與確認回寫失敗**：取消／外層期限中斷已開始的請求，保留不確定狀態，不自動重送；未開始的批次工作釋放回 pending。平台已確認送出但本機 sent 回寫失敗時，嘗試保存 skipped 人工核對狀態與已組合內容，不轉一般重試。若連保全都不能寫入，本次輪詢失敗，不能把已開始工作當未發送工作釋放。

consumer 直接重用本次重構的新 TS 業務組合函式與圖片讀取，並非舊 Python 包裝；目前這些服務部分仍位於 `apps/api/src/`，後續完整 runtime／依賴整理時應抽至共同服務層。新增 outbox bundle 與 transport 分開，不將資料庫／組合服務帶入純連線 bundle。

## 隔離驗證

新增 **1 檔／19 項測試**，其中包含 **22 組真實 Python worker 差分**：比較回傳計數、全部 outbox 欄位（排除隨機 claim token／claimed_at）、實際 API body 與 runtime。涵蓋成功、部署／政策模擬覆寫、永久／授權／暫時／HTTP 頻控／Markdown 拒絕、202 不確定、空／控制字元／過長 Unicode／未報備域名／缺失媒體、私人／錯群／停用／空政策、勿擾及最大重試。

其他案例驗證雙連線排他、過期 claim 與晚回寫、慢請求續租、取消與重疊輪詢、外層期限、設定中途變更、恢復候選封鎖、凍結事實與新版模板、當前名單提醒、跨重啟 pacing、模擬不重播、畸形工作逐筆有界處理、平台已確認但本機回寫失敗、跳轉域名與不自動降級。結算覆蓋先文字後圖片、模擬不傳原圖、父文字失敗／重試、單圖重試、上傳後換群／撤權／撤公開／換版／失去 claim、缺 file_info、凍結碼不符及持久拒絕檔保全。

既有 API 的兩項測試擴充為 **新 TS 與保留 Python worker 雙向差分**：使用真實新結算 API 產生文字與三張收款碼，逐個比較 7 個平台請求；使用真實時間投票 API 產生工作，比對延遲消費後只保留有效候選的內容、計數與不重送。所有網路投遞均為合成 adapter。

完整重構回歸 **81 檔／635 項通過**。既有 Python bot **311 項**及時間投票 bot **15 項通過**。strict TypeScript、重構建置、既有 UI 產物、capability ledger 與 diff check 通過。built smoke 在禁止 fetch／WebSocket 時匯入兩份 bundle，確認無副作用，再以真實本機 HTTP 驗證 built consumer 的 202 不重播、模擬保全及恢復候選封鎖；transport 的本機原生 WebSocket、API／分房 worker／備份／恢復 smoke 保留。

本批沒有改畫面、導覽或操作文案，未重跑瀏覽器全套；上一批後台 6 項瀏覽器證據保留。前端約 **1,152.94 kB（gzip 336.99 kB）**、CSS **122.22 kB**、API **694.7 KiB**、分房 worker **95.5 KiB**、transport **38.8 KiB**、outbox **171.1 KiB**。大 bundle、正式規模資源與長期穩定性門檻仍未完成。

## 尚未完成與切換限制

B10 從 planned 改為 `in_progress`；其餘對應能力追加證據而不標記通過。**166 項保留，0 項完整驗收，`release_eligible=false`**。

這是可顯式呼叫的 outbox consumer，並非完整 TypeScript bot。仍須完成全部指令／別名／被動回覆、縮寫與敏感詞、按鈕去重與每次群／身份授權、Gateway 群發現與授權事件接入、完整 runtime／啟停／健康、通用人工重送與投遞後台，以及 B01–B15 及跨領域的實際版本組合／QQ 驗收。保留 Python bot，禁止同時啟動新舊正式投遞者。

claim fencing 和續租不承諾恰好一次。程序在 HTTP 發出後崩潰、資料庫無法記錄最終結果或失去 lease 時，仍可能存在無法只靠本機資料判斷的投遞；切換／回退前須保全待送、重試、claim、模擬與不確定紀錄並人工對帳。既有 transport 回傳的一般暫時錯誤沿用有界重試，不能把它解讀為平台保證未送達。新 consumer 的外層中斷／確認回寫保全已測，尚無正式版本組合與切換演練證據。

正式資料副本、舊入口／public v1、PWA／持久草稿、簡繁語系、其餘後台、全量效能與回退驗收仍依原計畫處理。使用者指定先不部署。
