# 第五十一批實作：原生 bot runtime 與投遞所有權

日期：2026-11-18（Asia/Taipei）。分支 `codex/unified-rebuild`。發布範圍 **`none`**：本機隔離實作與驗證，未合入 main、未部署，未使用正式 bot、憑證、群或待送工作。schema 維持 **14／94 張表**，正式 Compose 及 Python bot 保留。

## Runtime 與啟動入口

新增 `@qgroup/bot/runtime`、`.rebuild-dist/bot/runtime.mjs`、`maintenance-task.mjs` 及明確執行的 `start.mjs`。Library 與 worker entry 在主執行緒匯入時不開資料庫、網路、輪詢或 worker；只有 CLI 或明確呼叫 `runBot` 才啟動。CLI 沿用既有環境設定與政策預設，不自動建立或遷移業務資料庫。啟動要求既有、非恢復候選且版本正確的重構資料庫。

Gateway 與 QQ API 在主執行緒，公開查詢與縮寫沿用兩個隔離 business worker；新增 maintenance worker 負責 outbox、目前政策、部署預設群、applied revision 與健康檔。outbox 不等待 Gateway READY 或連線成功，可在 Gateway 離線時消費。Worker 設定採執行期白名單、空環境，沒有 QQ 憑證；maintenance RPC 最多 32 個未完成工作，取消後保留佔位直到 worker 回覆。worker 設 256 MiB V8 old-generation 上限，不宣稱程序總資源受控。

面板註冊獨立於輪詢，依資料庫當前 dry-run 決定，取得 token 後及 auth retry 前再驗。成功結果只適用同一設定 revision；較晚完成的舊請求不能把新設定記成已註冊。設定 revision 改變後重新核對／註冊，包含快速模擬→實送切換。health 保留原欄位，新增 runtime 狀態、Gateway 連線布林與政策 revision；停止時保留實際 last_poll／ACK，不用設定已套用冒充連線正常。子 worker 的 opt-in 文字預覽回到主執行緒後再遮罩實際 QQ secret，也處理 secret 跨越預覽截斷邊界留下的前綴。

## 單一投遞者與啟動保全

TypeScript `BotOwnership` 與 Python `qgroup_bot.ownership` 共用資料庫目錄下持續存在的 `.bot-owner.sqlite3`。使用獨立 SQLite 連線的 `BEGIN EXCLUSIVE` 持有 OS 鎖，不持有業務資料庫 writer；檔案 0600，拒絕符號連結／硬連結，後續平台請求檢查資料庫與鎖檔的 device／inode。正常關閉／程序崩潰由 OS 釋放，不刪除、不搶鎖。TypeScript 限制主執行緒取得鎖，並在 global symbol registry 保留同程序所有權，避免重複開關 raw fd 解除既有 POSIX 鎖；Python 同程序使用同步保留集合。

兩個更新後的官方入口在任何業務／平台請求前取得鎖。若已有任一 `sending` 工作則拒絕啟動、保留原資料與嘗試次數，等待離線核對投遞結果；不把租約逾時當成可以重播，也不自動把未知結果轉回 pending。恢復候選與不支援 schema 同樣拒絕。原生 CLI 以安全診斷原因區分啟動拒絕，不記資料、路徑或錯誤原文。

**鎖的保證只涵蓋使用此協議、共用同一 canonical 資料目錄的程序。** 尚在線上且沒有這段協議的舊 binary、另一主機／資料副本及明確繞過 runtime 的 library 不受此鎖排除；鎖檔被外部移除或資料被替換時只能拒絕後續請求。正式切換仍必須停止並核對原投遞者，不能用本機互斥測試取代操作流程。

## 發送與停止

outbox 每次圖片上傳／群訊息送出，在 token 取得後及重認證重送前透過 worker RPC 再驗 claim、政策 revision、目的群與事件適用性。等待 token 跨入勿擾時段會延後至允許時間，不耗失敗次數；不重做 pacing 預約而等待自身的保留時段。政策阻止與請求失敗分開，保留 deferred／skipped 結果。檢查與 QQ 接收無法成為原子交易，已開始的 HTTP 仍可能有不確定結果。

原生 runtime 停止時取消平台請求與背景工作，等待 dispatcher 與 maintenance 工作結束、寫最終健康並關閉 worker，最後才釋放所有權。business／maintenance worker 崩潰會停止整個 runtime；maintenance 無法在關閉期限內結束時強制終止、回報失敗，後續重啟仍須通過 `sending` 核對。已開始但未確認的投遞按既有不確定結果保全，未開始的 batch 工作釋回 pending，停止後不啟動下一筆。

Python 官方入口同步接入所有權與啟動核對，SIGTERM 會取消閒置 Gateway 的主工作，不必等下一個事件。關閉時取消全部 asyncio 工作，等待 default executor 的實際執行緒結束後才釋放鎖；停止後經共用 HTTP 入口的新請求會被拒絕。這些是原始碼修改，正式 Python 程序沒有更新或重啟。

## 隔離驗證

新增 runtime 8 項、ownership 6 項與 outbox 勿擾跨界 1 項，共 **2 檔／15 項**。涵蓋 Gateway 離線時消費、真實本機 HTTP／WebSocket 訊息／按鈕、模擬不重播、面板設定競態、token 等待期間撤權、in-flight 停止及未開始工作保全、secret 遮罩、兩類 worker 崩潰、Python／TS 雙向與同程序互斥、持鎖程序 SIGKILL 後重取、鎖檔替換、Python 閒置 SIGTERM，以及 executor 尚未結束時持鎖並拒絕 late HTTP。全部資料與平台均為合成／loopback。

Built smoke 實際執行建置後 CLI 子程序，核對 outbox、鎖、SIGTERM、最終 health 及再次取鎖。測試透過 preload 把 CLI 固定的官方 token 端點導向本機合成平台，拒絕其他非 loopback fetch，沒有真正取得 QQ token 或投遞。既有 transport／Resume／dispatch／公開回覆／縮寫／恢復封鎖 smoke 保留。

完整重構回歸 **88 檔／704 項通過**；保留 Python bot **311 項**及時間投票 **15 項通過**。strict TypeScript、重構建置、built smoke、舊 UI 產物、capability ledger 與 diff check 通過。前端未修改，JS 維持 **1,152.94 kB／gzip 336.99 kB**；runtime 約 **156.2 KiB**、maintenance 約 **182.5 KiB**、CLI 約 **160.5 KiB**。首次同時跑建置／Python／Vitest 時，既有九次 Python 啟動的差分案例超過 5 秒；獨立全套重跑通過，再將九個輸入放在同一 Python 程序逐一比對，保留全部斷言及原期限。另修正 runtime 測試的觀測競態：收到 HTTP 不等於投遞確認已寫回，改為等待持久 sent 狀態後再斷言；本機平台只容許取消造成的 ECONNRESET／EPIPE，其他 socket 錯誤仍使測試失敗。

## 未完成驗收

**166 項保留、0 項完整驗收、release_eligible=false**。本批提供可執行的隔離 runtime，不表示正式 worker 已可替換。仍缺 UnionID 存在／站內布林匹配診斷、通用投遞列表／手動重送、正式待送與續讀對帳、完整 B01–B15 版本組合、真實 QQ／長期連線、正式資料副本與切換／回退演練。去重仍在記憶體，沒有 durable inbox／恰好一次；程序崩潰可能遺失已接受但尚未完成的被動回覆。

巨量縮寫結果跨 worker 傳遞及 QQ JSON 序列化仍可能占用主執行緒，正式規模的延遲／總記憶體尚未驗收。其餘後台、全部舊 URL／public-v1、PWA／持久草稿、簡繁與正式資料完整對帳繼續依主計畫完成。使用者指定先不部署；保留 Python bot，不啟動正式雙投遞者。
