# 第五十批實作：TypeScript bot 事件處理與 worker 隔離

日期：2026-11-18（Asia/Taipei）。分支 `codex/unified-rebuild`。發布範圍 **`none`**：只修改隔離重構程式與驗證，未合入 main、未部署；未使用正式 bot、群、憑證或待送工作。schema 維持 **14／94 張表**，保留 Python bot 與正式 Compose。

## 已實作

新增 `@qgroup/bot/dispatch` 與 `.rebuild-dist/bot/dispatch.mjs`，提供明確建構的 dispatcher 與兩個 business worker。`.rebuild-dist/bot/dispatch-task.mjs` 是 worker entry；在主執行緒匯入時不開資料庫、網路、worker 或輪詢。尚未提供正式 runtime 啟動入口。

- 訊息與按鈕接入既有原生指令、公開查詢及縮寫／引用／續讀服務。普通訊息與 GROUP_AT 都須確認實際提及本 bot；全部／全體提及和 bot 作者不回覆。直接提及及 everyone 判斷與實際 Python 函式差分，涵蓋 fullwidth、XML 與 Unicode 邊界。
- 按鈕只接受 type 11／12；18／19／20 不執行指令。每個有效 interaction 先 ACK，再觀察群及處理業務；ACK 例外不洩露錯誤原文，未取消時可繼續業務。回覆只用外層 event.id，interaction ID 不冒充 msg_id。缺少有效被動回覆識別時不改成主動群發。
- 消息 ID／interaction ID 保留 10 分鐘，訊息指紋保留 30 秒。指紋包含群、作者、去 mention 的內容、timestamp／ID 及穩定排序的引用 elements；不同引用不互相吞掉。兩種訊息事件對同一訊息只回答一次。各去重集合最多 8,192 筆，滿額拒絕新指令而不淘汰尚有效的 ID。群發現最多保留 500 個記憶體節流項目；一般非提及訊息每群最多每分鐘更新一次，重要事件仍更新。
- Dispatcher 預設最多 64 個背景工作、每個 30 秒，連結 Gateway 連線的取消訊號；接收後快速返回，獨立處理按鈕 ACK。拒絕滿額工作時不先消耗 interaction ID。連線取消、期限到期或關閉後不開始新的平台請求。
- SQLite／公開回覆在 public worker；縮寫 HTTP、JSON、完整詞庫建庫／遮罩、快取及續讀檔案在另一 worker。每個 business lane 預設最多 32 件未完成工作；取消後仍保留容量到 worker 確認完成，防止 CPU 或 DB 鎖延遲取消造成無界隊列。發送前的政策檢查使用 public worker 與獨立的有界保留容量，避免等待自身回覆占用的 business slot。Worker 預設各設 256 MiB V8 old-generation 上限；這不等於程序總記憶體或 CPU 配額。
- Business worker 的設定採執行期白名單，只傳資料／回覆所需欄位；環境清空，不傳 QQ secret、token 或原始環境。QQ API 與 Gateway 留在主執行緒；每次 RPC 發送都核對原工作、群及被動回覆 ID，並在主執行緒再次檢查取消。任一 worker 啟動／執行緒失效時取消全部工作並拒絕後續使用，不自行啟動第二個投遞者或重播輸入。

## 政策與資料保全

公開查詢只要求群允許回覆及 replies_enabled，不要求廣播 enabled 或活動 bot_enabled。準備前、縮寫查詢後、各段及各提示發送前重新讀目前群／回覆／dry-run 政策。`QQBotAPI` 新增可選 beforeSend，在取得 token 後、每次實際 HTTP POST 前執行，也涵蓋 auth retry；token 等待期間撤權不會使用先前的政策繼續發送。檢查與平台接收無法成為跨系統原子交易，已開始的 HTTP 仍依既有不確定投遞規則處理。

政策阻止發送與儲存失敗分開：不把撤權變成「儲存失敗」通知，也不為尚未開始的完整回覆建立不確定續讀。分段既有的預先保存游標保全維持；段落間撤權不跳過未送段落。續讀根目錄沿用資料庫旁的 `bot-abbreviation-results`，不另建不相容位置。設定明確接入 KANBAN_BOT_BASE_URL 與 KANBAN_BOT_SENSITIVE_WORDS_FILE；額外詞檔無效時只允許安全的失敗提示，不傳回未遮罩結果。

查詢以 existing-file readonly 開啟，不遷移或建立資料庫；群觀察／拒絕原因才寫入既有表，恢復候選拒絕操作。不推斷 QQ 作者的站內身份，也不產生報名、付款或 outbox 工作。Markdown 輸出不合格式／域名時使用經檢查的普通文字；平台拒絕 Markdown 後不自動補發普通文字。輸入及引用完全不記預覽，即使開啟 content log 也不記原文；診斷只保留必要狀態、命令及雜湊。

## 隔離驗證

新增 dispatch 兩檔測試及 API guard 案例，涵蓋去重 TTL／容量、引用差異、回呼 ACK 次序／失敗／取消、授權事件不執行、ID 選用、群觀察節流、工作期限／滿額／關閉、公開回覆政策、縮寫中途撤權／段間撤權、token 等待及 auth retry 前撤權、域名、Markdown 拒絕不重送、恢復候選／缺檔不建庫、額外詞庫失效與診斷隱私。

實際本機 HTTP／WebSocket 測試把縮寫 worker 持續占用 CPU 一秒，期間 Gateway 仍處理心跳、按鈕 ACK、另一公開查詢並推進序號；驗證原生 QQ HTTP payload 的 msg_id／event_id。另以 SQLite writer 鎖住觀察工作，確認按鈕已先 ACK，連線取消能結束主執行緒等待；不把這一項說成鎖定資料時仍可完成業務查詢。Worker 無法立即處理取消時，主執行緒仍阻止後續 QQ 發送；取消未確認的工作保持佔位。故意使 worker 崩潰驗證停止接單及不記錯誤原文。測試 worker 檢查未收到憑證欄位或 bot 環境；縮寫上游只收到縮寫，無 QQ Authorization。

Built smoke 額外匯入 dispatcher 及 worker entry 驗證沒有副作用，並實際啟動建置後的兩個 worker，走訊息／重複訊息／按鈕／公開查詢／恢復封鎖及關閉。前端沒有變更，不重跑無關瀏覽器流程。新增 **2 檔／21 項**案例（含既有 API 測試新增案例），完整重構回歸 **86 檔／689 項通過**；保留 Python bot **311 項**與時間投票 bot **15 項**通過。strict TypeScript、重構建置、built smoke、既有 UI 產物、capability ledger 與 diff check 通過。前端主 JS 維持 **1,152.94 kB／gzip 336.99 kB**，獨立 dispatcher 約 **107.7 KiB**，worker bundle 約 **2.8 MiB**（含完整詞庫）。原預設併發全套曾有一項九次 Python 差分超過 5 秒，沒有內容斷言失敗，之後以受控 worker 數重跑核對，沒有放寬業務期限或跳過案例。

## 剩餘工作與切換限制

**166 項保留、0 項完整驗收、release_eligible=false**。這批完成隔離事件接收至原生回覆的連接，不等於正式 bot 已可替換。輸入接受後 Gateway 可推進序號，去重只在記憶體；程序崩潰可能遺失尚未完成的被動回覆，不宣稱 durable inbox／恰好一次。平台待回覆窗口與續讀仍保留既有五次限制，不自行重播已接受事件。

仍需完整 runtime 的 outbox／Gateway 統籌、panels／health／revision 更新、UnionID 布林匹配診斷、程序間唯一投遞者與續讀互斥、停止／崩潰與待送對帳、通用手動重送／投遞後台。巨量回覆跨 worker 傳遞、QQ 請求序列化仍在主執行緒；無界上游結果與正式規模的延遲／總記憶體要另做資源驗收，不能用本機一秒 CPU 測試取代。現有額外遮罩／長結果行為不因此截斷。

全部實際 web-bot 版本組合、真實 QQ／長期連線、正式資料副本、切換／回退仍依 B01–B15 與主計畫驗收；保留 Python bot，不開正式雙投遞者。其餘後台、所有舊入口／public-v1、PWA／持久草稿及簡繁繼續實作。使用者指定先不部署。
