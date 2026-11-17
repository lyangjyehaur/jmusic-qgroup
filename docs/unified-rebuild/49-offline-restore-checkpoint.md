# 第四十三批實作：原生備份的隔離恢復候選庫

日期：2026-11-17（Asia/Taipei）。分支 `codex/unified-rebuild`。發布範圍 **`none`**：只做本機隔離實作與驗收，未整合 main、未部署。schema 升為 **14**，保留 59 張相容表並新增一張儲存來源表，共 94 張；不修改既有 Python bot。schema、投遞恢復及來源識別的跨服務影響仍按 **`both`** 評估，不能以本批合成驗證宣稱正式版本組合相容。

## 實作與輸入

`npm run restore:rebuild` 產生新的私有恢復候選目錄。所有輸入都必須是停止寫入後保存的完整、不可變副本；工具不讀活動中的主庫、不停止服務，也沒有取得正式跨服務維護鎖的能力。

```sh
npm run restore:rebuild -- \
  /private/copies/paired-backups/SELECTED_NATIVE_ID \
  /private/copies/paired-backups/LATEST_NATIVE_ID \
  /private/copies/latest.erasures.jsonl \
  /private/copies/bot-logs \
  /private/candidates/recovery-001 \
  --quiescent-copy
```

上述路徑是佔位範例；原生 ID 須符合實際備份清單。`--quiescent-copy` 是操作者對停寫副本的明確聲明，工具不會自動證明停機、來源完整或「latest」確實最新。目標父目錄須已存在且由操作者控制；目標本身必須不存在，包括 dangling symlink。重跑拒絕覆蓋既有候選庫或新寫入，不把上次 manifest 當作覆蓋授權。

五個輸入依序是選定原生備份、最新完整原生檢查點、獨立保存的最新刪除 ledger、該次停機的 bot 外部狀態／診斷檔副本、新候選目錄。兩個備份可以相同。外部 bot 目錄必須明確提供，即使空白；操作者仍須確認沒有遺漏自訂 `KANBAN_BOT_LOG_DIR` 的內容。支援群授權狀態 JSON、bot-events 的目前及四份輪替紀錄、bot-health；未分類檔、symlink、非一般檔及無效群授權 JSON 拒絕處理。

## 資料對帳與刪除重播

schema 14 的 `rebuild_storage` 為單例，包含隨機且持久的 `lineage_id`、初值 0 的 `recovery_required`。遷移在交易內完成，衝突不覆蓋既有證據，重開不重新產生來源識別；限制新增／更新／刪除及 `INSERT OR REPLACE` 覆寫識別。它是來源關聯資訊，SHA-256 是完整性資訊，均不取代可信來源保管或正式維護流程。

新原生 manifest 為 v2／schema 14，帶相同 lineage；舊 v1／schema 13 仍可驗證並在記憶體升級，供既有歷史 JSON 下載。完整恢復要求兩份 v2 的 lineage 相同，最新檢查點的 sequence／時間不早於選定備份。v1 沒有可證明的原生來源識別，只保留歷史下載，拒絕完整恢復。所有原表、新表、索引與 trigger 必須符合目前完整 schema；未知結構停止並要求明確審查。

開啟原生包時先檢查目錄名稱、分類、manifest／每檔 size 與 checksum、SQLite integrity／FK、ledger／已套用標記／新式回執及全部圖片配對。輸入原件不開為可寫 SQLite；在獨立記憶體副本上重播最新 ledger。最新 ledger 必須包含兩份歷史的每個原始意圖，不得缺失、截斷或改寫；衝突意圖拒絕。可重播已持久但尚未提交的成分刪除、帳號關閉及管理 DELETE／RESET，保留刪除回執並避免資料復活。

重播後比較所有權威業務表，只有明列的短期認證表及六張 bot 表不納入業務相等比較；users 的登入 hash 另行撤銷。不會把舊活動庫與較新 bot 列硬拼接。若活動、名冊、帳務、音樂、身份關聯、設定、業務回執或其他權威表存在差異，拒絕選定備份並要求使用最新完整檢查點。本批**不提供丟棄新業務寫入的時間回退，也不提供有衝突業務資料的自動合併**。

對帳通過後使用最新完整檢查點作候選來源，保留其全表與新工作；再套已核對的最新刪除意圖及認證撤銷。逐表保留兩份的 `sqlite_sequence` 最大高水位，避免重新使用已消耗的 ID。只複製刪除重播後仍有引用的外部原圖；壁紙 BLOB 仍隨 SQLite 完整保留。

## bot 保全

逐一核對選定備份的 outbox ID 仍存在於最新檢查點，活動／投票、kind／dedupe、channel／target、原 payload、到期與建立時間、收件人身份不變，attempts 不倒退，已凍結 payload 不遺失。sent／skipped 終態及任何 simulated 工作不得改寫，sending 不可倒退 pending；舊 bot 設定歷史須完整存在。差異不符合時停止，不能假定未確認工作「尚未送出」。

候選保留最新 `bot_outbox` 的所有欄位、所有新增工作、claim／retry／sent／simulated／凍結 payload，以及 bot 設定、群政策、runtime 和歷史。sending／failed 及非模擬 skipped 列入私有 manifest 的人工核對清單，清單只列 ID／狀態／次數／模擬時間，原始 claim 與診斷仍保留在庫及原件。不執行投遞、不重新排入 pending、不把模擬改為真送。

`bot-group-state.json` 與每群雜湊後綴檔的原始 bytes 同時保存至候選 `bot-logs/` 及 `bot-evidence/`，保留 `push_authorized:false` 和預設群 fallback 語意。診斷原件全部保存至 `bot-evidence/`，包括資料庫未落盤但平台可能已送出的紀錄；舊 health 檔只作歷史證據，不放入新 bot 的運行健康目錄。已用實際 Python OutboxWorker 的只讀方法核對群阻擋、用實際 Python 共用核心核對名冊／身份／outbox，均無真實 QQ 呼叫。

**原 Python worker 不讀取新恢復標記，且會重領過期 sending。不得將候選庫掛入舊 worker 或直接啟動它。** 候選庫不是可直接恢復服務的成品；平台不確定投遞、外部群政策、兩個實際版本、獨立設定／憑證與停寫完整性必須另行審核。本批沒有正式啟用指令，也沒有自動平台去重保證。

## 認證撤銷、發布與啟動封鎖

候選清空 browser／visitor／admin session、OAuth／QQ 嘗試、裝置授權、短期 auth 回執及成分找回意圖，輪換所有 users 舊登入 hash；停用匯入的舊 sessions／entry_intents 證據並更新其 migration 狀態。保留外部身份關聯、PIN 與限流、角色、業務 UUID 回執、刪除回執、使用者內容及活動／認領／協辦邀請語意。

stage 為 0700、每檔 0600，逐檔及目錄 fsync、最後 rename 至新目錄。候選包含 `unified.sqlite3`、最新 `unified.erasures.jsonl`、仍被引用的 `images/`、`bot-logs/`、`bot-evidence/`、私有 `recovery-manifest.json`。manifest 記錄來源 fingerprint、lineage、業務摘要、產物 checksum 與未完成審核，標記 `recoveryRequired=true`／`releaseEligible=false`。發布前重驗所有來源檔、ledger、外部證據及 canonical 路徑；失敗清掉尚未發布的 stage，保留輸入。目標旁的排他 reservation 防止同工具並發發布，並非正式服務維護鎖；父目錄中的其他寫入者仍須停止。rename 後若檔案系統同步失敗須檢查目標，不能假報不存在或直接再覆蓋。

資料庫內 `recovery_required=1` 標記隨 DB 檔一起保留；一般 UPDATE／REPLACE 不能清除。`openDatabase` 及 `createApp` 都先拒絕候選，已 bundle 的 start 也在 migrations、隱私恢復、備份排程或 listen 前停止。只有手動改檔／改 schema 的維運者仍能繞過標記，因此不能將其當作不可繞過的正式發布權限控管。沒有在前台加入裝飾文案或恢復捷徑。

## 隔離驗證與剩餘門檻

- 本批 33 項離線恢復測試與 2 項 schema 13→14 遷移測試：非空 bot 各狀態、設定／群歷史、ID 高水位、Python 只讀差分、群授權 fallback、圖片／壁紙／權限、認證撤銷、待重播與已提交的三類刪除、私有回執、較新業務拒絕、v1 歷史讀取、異庫／過舊檢查點、ledger 遺失／衝突／截斷、投遞回退、來源晚變更、checksum／symlink／未知檔、既有目的地／reservation、不發佈半套及 CLI 輸出。
- 本批既有 5 個備份下載瀏覽器流程通過。已 bundle API 的煙霧測試涵蓋 SQLite／sharp 原圖、新 v2 manifest、目前／歷史下載、離線 CLI 與候選啟動拒絕。
- 最後完整後端回歸 **71 檔／569 項通過**；既有 Python bot **311 項**、時間投票 bot **15 項通過**。strict TypeScript、重構建置、既有 UI 產物檢查、capability ledger、diff check 與 built smoke 通過。本批未重跑全站瀏覽器，不引用上一批完整瀏覽器數字作本批全站驗收。
- 首輪失敗來自 macOS `/var` canonical 測試路徑、合成 fixture 重複插入 bot 單例／寫入唯讀 registrations、Python 只讀 fixture 缺 db 欄位及新表 trigger 的舊結構比較；改用 canonical 副本、正確合成資料與明確舊表結構後，上述完整回歸重驗通過。
- 前端仍為 1,097.25 kB（gzip 319.46 kB）、CSS 121.08 kB；API 約 665.6 kB。大 bundle 提示仍存在，正式規模資源／效能未驗收。

O12／O13 保持 **in_progress**，166 項能力仍保留，0 項完整驗收，`release_eligible=false`，原生包仍為 `restoreEligible=false`。正式來源擷取、跨服務維護鎖、候選審核／啟用、平台送達不確定對帳、歷史兩站舊備份 adapters、回退匯出、正式規模記憶體／磁碟／停寫時間、實際版本組合及 P6／P7 演練仍未完成。全案的音樂分房、完整 TypeScript worker、PWA／草稿切換及其他台帳缺口繼續處理；未部署。
