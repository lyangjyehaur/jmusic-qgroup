# 2026-11-27 參與統計與未成團分類

發布範圍：`web`（`frontend`＋`api`）。台北時間 2026-11-27 00:06:14 切換前端，00:06:17 啟動新版 API。來源為已合入 main、雙遠端 SHA 核對一致的 `4ef5ff8fc6801434ba9f01c68b1b0285ec7240ed`。bot 保持原映像、容器及啟動時間，沒有重啟；schema、既有報名／出席／結算、outbox 與設定語意不變，沒有資料遷移。

## 功能

- [整體參與統計](https://kanban.danndann.cn/activities/participation) 位於活動頁籤；「我的」提供本人次數與紀錄。期間、類型篩選與分頁保留，列表有連續序號、頭像與稱呼；「紀錄」開啟可見的對話框，可返回或按 Escape。
- 只計已結束或已過預定結束時間、正式報名達最低成團人數的活動。每位已識別參加者每場一次，未認領同行列入人次。取消、草稿、未來活動、候補、待確認及已退出不計；這是正式報名次數，不表示核實出席率。
- 往期活動新增「未成團」狀態與篩選，顯示最低人數；不改實際 lifecycle、成團確認或帳務。11 月 14 日活動最低 4 人、正式 2 人，顯示未成團並從統計排除。
- 活動頁籤維持單行，手機左右滑動，選中頁籤自動保持可見。保留當天已發布的舊版草稿清除功能與 PWA 保存草稿後更新流程。

計數、身份、公開／私人權限及副本工具細節見[實作說明](../unified-rebuild/participation-statistics.md)。

## 實際版本

| 產物 | 發布前 | 發布後 |
| --- | --- | --- |
| 前端 commit | `26d12074b3cb6f8c32e722c90e569d0e31fba932` | `4ef5ff8fc6801434ba9f01c68b1b0285ec7240ed` |
| API commit | `7b0914ffd05b4418b9065932592d9bd5c33a71c7` | `4ef5ff8fc6801434ba9f01c68b1b0285ec7240ed` |
| API 實際 image ID | `sha256:2b55e3d15df8035dbe5ed6334723c275f1e52061695c4ebc67edc09b369e8e00` | `sha256:3021adaf924515cc73b129125f82623089f5bc8e33daf2796e9fc3a45ae1d9fa` |
| bot commit | `7b0914ffd05b4418b9065932592d9bd5c33a71c7` | 不變 |
| bot 實際 image ID | `sha256:2b55e3d15df8035dbe5ed6334723c275f1e52061695c4ebc67edc09b369e8e00` | 不變 |
| rebuild_schema／schema_migrations | 15／20 | 15／20 |

- 新 web 容器：`86d1d5d3d2575383147bf1b9d5a6d25cd3f0ec5b965ca31971996cb2245ec0a4`，StartedAt `2026-11-26T16:06:17.146240018Z`。
- bot 原容器：`9d3a349fa048df963eba1a2c8de4ea154bc9c5e28df61ee8a59a4a1bd5147e46`，StartedAt `2026-11-25T16:30:45.90367263Z`；發布前後一致。
- frontend release：`4ef5ff8fc6801434ba9f01c68b1b0285ec7240ed-058530da2ddebb2a`。
- PWA build ID：`3bd67168f20f169597ae209643235c08e0ce2d597f9129d9a701dba2cf534a7e`。
- frontend manifest SHA256：`058530da2ddebb2a42d81d0471e29ccda32b3cf248703a580da5fb309f8f46fc`。
- frontend archive SHA256：`39e1fd31ca3f759b3024db25764d21909812854e21101f122a2b1a793262814c`。
- API image archive SHA256：`94a024522164169e2e7e4cd6ee3cc19feadfd04cb0bfe481e7ee23e1b229d5e5`。
- source archive SHA256：`a355d0a825363682c4ab78f57ab1e34f4962bd9677120fb1c08097df153ae819`。
- 正式暫存：`/opt/qgroup-releases/participation-20261126-4ef5ff8/`。工作於 11 月 26 日開始，實際切換時間已跨日至 11 月 27 日；保留既有產物識別。
- 本機證據：忽略版控的 `artifacts/private/participation-release-20261126/` 與 `production-preview-20261126-release/`，不提交個資、資料庫或截圖。

## 驗證與發布

- 完整建置及 96 項 API／契約／bot 相關測試通過；整合最新 main 後的參與統計與舊版草稿清理瀏覽器回歸 11 項、線上副本瀏覽器驗收 3 項通過。
- `check_release_source.py --commit 4ef5ff8fc6801434ba9f01c68b1b0285ec7240ed` 通過。API 與前端分別只封存核准提交、在新乾淨目錄建置。API 為 linux/amd64，映像 label、runtime source、前端 API pin 及實際 image ID 一致。使用 BuildKit 內建 frontend，只從額外建置檔移除外部 syntax directive；核准來源 Dockerfile 保持原檔，兩份摘要均保存。
- API／資料庫及 bot 的編譯檔並非全部逐位元相同：新增統計契約、Zod 匯入別名及統計錯誤顯示使摘要改變。逐項核對後，資料庫與 9 個 bot bundle 移除新增未使用的契約／錯誤顯示並正規化匯入別名，即與保留版本相同；database、bot、domain 原始碼差異為空。沒有以原始摘要相等作為相容性結論。
- 確切線上 bot 映像搭配候選 API image 的資料庫 bundle，通過原生 HTTP／WebSocket、ACK／Resume、公開查詢、縮寫、回呼、身份限制、outbox 未確認／模擬／恢復阻擋、單一 worker 與 SIGTERM 隔離 smoke。新版 API 搭配保留 bot 的公開查詢 bundle，驗證直接發布、原請求重播、發起者同意、活動中報名、通知去重與截止狀態一致。所有投遞使用本機模擬端，沒有真實 QQ 發送。
- 台北時間 2026-11-26 23:42:33 唯讀擷取最新線上一致性副本：18 場活動、106 筆報名、56 個帳號，保留刪除紀錄、核對完整性／外鍵／圖片與檔案摘要，清除正式憑證及待送工作，停用通知。用確切 API 映像與獨立前端包驗證 6 組篩選、34 人全部次數與紀錄、分頁及本人 6 場紀錄；結果為 9 場／69 人次／34 人。真實副本瀏覽器專項 3 項通過，320px／390px 個人與整體頁無溢出、page error 0，沒有業務修改請求，業務資料、outbox 與原副本摘要不變。副本沒有私人活動，私人權限由隔離邊界測試驗證。
- 發布鎖內核對前後 Compose 只改 web image，bot 完整設定一致，資源、掛載、權限與固定映像驗證通過。先保存舊 web 映像、前端指標／receipt、runtime.env、release manifest，執行成套備份；停 web、切換完整前端、僅 `up -d --no-deps --no-build web`。bot 持續運行。
- 備份前置 complete marker：`/var/backups/qgroup-unified/kanban-20261126-160606-341438.complete.json`，SHA256 `1bc47e794b4f59281ff3aa5eaa733f515aa773e183fccd9e95803eea6d2e36e2`。發布前後 `qgroup-backup.service` success，timer active。
- 公開 HTTPS 的 6 組深連結 shell、86 個原始資源摘要／immutable 標頭、PWA／版本 no-store 與完整 commit／build ID 均通過。430px／1280px 驗證紀錄視窗、序號分頁／頭像、單行滑動頁籤，以及未成團狀態、篩選與重新載入；page error 0、業務修改請求 0。初次驗收把外部統計上報也計作業務修改，修正測試只計本站 API 並阻擋外部上報後通過，未修改產品。
- 正式 web／bot healthy、restart count 0；bot 原生健康檢查成功，gateway connected、policy resolved，ACK／poll 持續更新。個人登入效果以隔離真實資料副本驗證，未建立正式測試帳號或改動正式業務資料。

## 回退

保存的版本組合為原前端 `26d12074b3cb6f8c32e722c90e569d0e31fba932`、API／bot `7b0914ffd05b4418b9065932592d9bd5c33a71c7` 與原 image ID。schema、outbox 及原始資料語意不變，已核對保留版本與目前資料庫程式的相容性；沒有資料遷移，回退不覆蓋資料庫或刪除權威。

暫存目錄保留 `previous-web-image.tar`、`previous-runtime.env`、`previous-release-manifest.json`、`previous-frontend-pointer.txt` 與 `previous-frontend-activation.json`。舊前端完整包在 `/opt/qgroup-frontend/releases/26d12074b3cb6f8c32e722c90e569d0e31fba932-f3c2959241a2faa3`；其 manifest SHA256 為 `f3c2959241a2faa30727c1ad6f05f30f21e5369dad5d23eb9983db69ce01a5e2`。

需回退時先取得同一發布鎖、核對當時版本與資料相容性，只停 web；恢復保存的 web image 引用與原前端指標／receipt，再只啟動 web。若使用 `frontend_release.py activate`，在 web 停止期間以原 API SHA 和 manifest pin 離線切換；新版 API 的啟動檢查不允許直接搭配原前端 pin。恢復後核對 API／前端版本、schema、健康與 bot 原 ID／啟動時間，更新 manifest 的實際 web 容器資料。部署腳本在切換失敗時執行此流程；本次未觸發回退。不重啟 bot，不追隨移動標籤，不把備份資料庫蓋回已產生新寫入的正式庫。
