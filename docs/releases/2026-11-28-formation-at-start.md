# 2026-11-28 開始時間成團判定

發布範圍：`both`（web 的 frontend／API 與正式 TypeScript bot）。東八區 2026-11-28 21:30:57 切換前端，21:31:00 啟動 API、21:31:07 啟動 bot，21:31:14 完成健康驗證。來源 `5bd474bc052ecc54acae35930429bfefe83c481f` 已合入並雙推 main，兩個遠端 SHA 一致。沿用正式資料、刪除權威、檢查點、憑證、群政策與通知工作；schema 15／schema_migrations 20 不變，沒有資料遷移。

## 行為

- 到預定開始時間，正式報名未達最低成團人數就實際取消、關閉報名，移入往期「未成團」。保存判定時的人數、原因與一次系統稽核，使用既有取消通知及提醒失效規則。
- 達門檻則保存成團結果並進入進行中，保留報名截止與開關；後來退出不重新取消。發起者確認成團、手動開始、最低人數為 0、草稿、刪除與歸檔保留原管理行為。
- 未來活動納入自動判定，服務中斷後補判定；首次啟用時已過預定結束、未曾納入的歷史活動不追溯改寫。名冊、備註、出席、結算與款項保留。

完整邊界與驗證見[實作說明](../unified-rebuild/activity-formation-at-start.md)。

## 實際版本

| 產物 | 發布前 | 發布後 |
| --- | --- | --- |
| 前端 commit | `6147e781ed36a01345bc715c5ae1516d305a1ad0` | `5bd474bc052ecc54acae35930429bfefe83c481f` |
| API commit | `15cac112cbbbeff8b485857d785c018f432f2b1f` | `5bd474bc052ecc54acae35930429bfefe83c481f` |
| API image ID | `sha256:49a3c4f071d8d648d26d01273100c490fac4f20e35900e2d13900062f2340920` | `sha256:4eca7f900a5898a6329ea32c6d2a2977f8710a59b9723a72d220b0300b78c5fb` |
| bot commit | `7b0914ffd05b4418b9065932592d9bd5c33a71c7` | `5bd474bc052ecc54acae35930429bfefe83c481f` |
| bot image ID | `sha256:2b55e3d15df8035dbe5ed6334723c275f1e52061695c4ebc67edc09b369e8e00` | `sha256:4eca7f900a5898a6329ea32c6d2a2977f8710a59b9723a72d220b0300b78c5fb` |

- API container：`c411522e2a24c3ac791d590b4d0b0774a15f5975e526996c21aaa9245c11de33`；bot container：`60a60ca4d3435d517ea13714e9e0ea54a8c5681bfb2de207dd3c538672325973`。兩者 healthy、restart count 0。
- 前端 release：`5bd474bc052ecc54acae35930429bfefe83c481f-81f2bab0d71e721b`；PWA build ID：`92927b020dadb71f46f575b3256ea7b84646b748aafcb7f6d8ba09d69dc1f4b9`。
- 前端 manifest SHA256：`81f2bab0d71e721b838a0c7fef26b2216b486b03bd7dd12d8ac98bf7cb087f9f`。
- 前端包 SHA256：`2cb94e9de8777892ac2f1b9a8f4f564cafdf345acd3dbe6e82aad59ebd30bdd8`；映像包：`ff4457d275c8613094b29ef05dcc07f5caad2b8fd0a0b18ee8b173b6759e3070`；核准 source archive：`6539aa33f050d8acfd302ca24a87b97c555983368fa9aa305f51f3425f9e06bd`。
- 正式暫存 `/opt/qgroup-releases/formation-20261128-5bd474b/`；本機私人證據 `artifacts/private/formation-release-20261128/`，資料庫、圖片、個資與日誌不提交。

## 驗證與切換

- release-source 檢查通過，只封存核准完整 SHA，在新目錄建置 linux/amd64 API／bot 映像與 API pin 相同的獨立前端包。來源 Dockerfile 未改；額外建置檔只移除外部 syntax directive，沿用同一 Dockerfile ignore。初次建置因替代建置檔未載入相應 ignore 而失敗，補回同內容 ignore 後成功。
- 21 個相關 Vitest 檔案／252 項、另 5 個契約／時間摘要檔案／87 項、保留 Python bot 對照 107 項通過；其中有重複測試，沒有相加冒充不重複總數。涵蓋活動、投票、名冊、結算、指令、身份、群政策、通知與恢復邊界；正式 worker 維持 TypeScript，Python 只供對照。型別、218 個 HTTP operation 契約與完整建置通過。
- 確切映像的 bot smoke 通過本機 HTTP／WebSocket、ACK／Resume、公開查詢、縮寫、按鈕與身份限制、未確認／模擬／恢復投遞阻擋、owner 鎖與 SIGTERM。測試沒有正式凭證或外部 QQ 網路。amd64 模擬下先遇到 5 秒啟動逾時及多程序測試 512 MiB 記憶體上限；僅將 harness 等待延至 30 秒、本機整組測試上限增至 1024 MiB 後通過，runtime bundle 與所有断言不改。正式單服務仍為 512 MiB、1 CPU、128 PID、無額外 swap。
- 東八區 2026-11-28 20:58:04 唯讀擷取最新一致性副本：20 活動、116 報名、63 帳號。保留並核對刪除紀錄、圖片與完整性，清除正式憑證和待送工作、關閉投遞。確切 API 映像配合独立前端驗證 3／4 人活動取消、近期排除、往期包含、報名關閉；116 筆報名、3 筆結算、3 筆結算歷史、款項與原副本逐表相同，沒有新增 outbox。94 個原始靜態資源及快取規則通過。
- 舊 API 映像能讀取消後副本並維持 registrationOpen=false；舊 bot 映像的往期查詢正常顯示取消、schema 15 可讀。曾誤以「名額」回覆應包含階段文字作測試，改為實際負責顯示階段的「往期」查詢後通過，未修改產品。
- 部署鎖內核對 Compose 只換兩個映像引用；服務環境、群政策、資源、資料掛載與唯讀根檔案系統一致。先保存兩個舊映像、runtime.env、manifest、前端指標／receipt，執行完整備份，再停 bot、停 web、切換前端、啟動 web、最後啟動 bot。沒有並行投遞者。
- 初次部署前置檢查把 image config digest 當作 Docker image ID，載入後查不到引用而停止，尚未停任何服務。依伺服器實際 image ID 重新核對、更新產物摘要後才切換；映像內容沒有重建或更改。
- 前置備份 `/var/backups/qgroup-unified/kanban-20261128-133053-073990.complete.json`，SHA256 `d5cbf590bdc903e34d49af3b83c66b0b59d5d7ad36bbfc5579289efe89813bc6`。發布前後 backup service success、timer active。切換期間逐表驗證名冊與帳務相同，既有 sent／simulated／unconfirmed outbox 状態未重設。
- 正式 HTTPS 的版本、94 個原始資源摘要／快取、7 個深連結 shell／安全標頭通過，沒有測試業務寫入。線上 3／4 人活動已取消、往期可查、報名關閉，系統自動取消稽核恰好 1 筆，既有 `event_cancelled` 工作恰好 1 筆且狀態為 sent。這是授權自動規則產生的實際取消通知；沒有額外發起測試活動、測試報名或 QQ 測試指令。
- bot 原生版本與映像一致，gateway connected、policy resolved、ACK／poll 持續更新，reconnects 0。保持原政策 revision 6；DB 政策為實際發送，部署預設 dry-run=true 維持原設定。

## 回退

保存的前端 `6147e781ed36a01345bc715c5ae1516d305a1ad0`、API `15cac112cbbbeff8b485857d785c018f432f2b1f`、bot `7b0914ffd05b4418b9065932592d9bd5c33a71c7` 及上表原映像作為回退組合。暫存保留 `previous-web-image.tar`、`previous-bot-image.tar`、`previous-runtime.env`、`previous-release-manifest.json`、前端指標和 activation receipt。舊前端完整包仍在獨立 releases 目錄。

回退必須取得同一鎖，先停 bot、再停 web；恢復保存的映像引用與前端指標／receipt，再啟動舊 web、最後舊 bot，核對版本、健康、現有資料及最新刪除權威。不能把發布前資料庫蓋回已有新寫入的正式庫。正式切換後沒有觸發回退。

舊版本可讀 schema 與取消結果，但沒有新自動判定；成團後退出造成的人數下降可能被舊列表／統計錯標未成團。延長使用回退組合前須核對這些活動，不能只憑 schema 相同宣稱行為完全等價。
