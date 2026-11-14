# 成分站隔離部署與舊帳號對照

2026-11-14 23:25（Asia/Taipei）完成 server2 初次發布，23:29 完成成員詳情可見範圍修正。發布範圍：`web`，另新增獨立 music 容器；bot 全程不重啟。入口：https://kanban.danndann.cn/music/ 。

## 行為與資料

- 成分站使用獨立容器、`127.0.0.1:8788` 及 `/var/lib/qgroup-music`，看板僅轉接 `/music/`。原 1Panel、TLS、首頁、API、管理後台與 QQ 回調設定不變。
- 沿用現有 QQ 互聯應用及 `https://kanban.danndann.cn/auth/qq/callback`。授權返回看板既有確認畫面，完成後回到成分站；不把 OpenID、QQ App Key 或看板登入 Cookie 提供給成分站前端。
- 初始資料為使用者提供的 2026-11-14 匯出副本：50 位會員、132 個條目，不與原成分站持續同步。複製後停用舊管理口令及舊管理接口；不發布會員、口令 hash、QQ、私人對照或任何金鑰。
- 20 筆舊看板 ID 中，14 筆唯一且對應有效帳號，匯入為管理員預先對照；其使用者登入看板即可進入原成分，不需再輸入舊口令。QQ 身分在正常登入後由後端補入對照。
- 另 6 筆涉及重複目標，全部列待核對，不猜測覆蓋。46 位有舊口令；未預先對照且無口令的 3 位須管理員核對。私人逐筆清單只留在保全目錄。
- 其他老會員以 QQ 號＋原口令登入，再完成 QQ 互聯授權，建立一次性對照；成功後不再接受該檔案的舊 PIN 登入。原口令不保存在 localStorage。QQ、user_id、App ID/OpenID 的衝突不直接覆蓋。
- 舊登入證明與授權前的看板 session 摘要綁定十分鐘；關聯須由同一次發起 session 的已完成 QQ 授權確認，不能只憑現有登入狀態、前端 QQ 或公開 ID 認領。
- 身分、寫入所有權及留言可見範圍由後端檢查；成員詳情的非公開性別不向其他人回傳。個人偏好、匹配及分房功能沿用成分站；分房仍為建議，不寫回看板正式安排。

## 版本組合

| 服務 | 來源 commit | 實際映像 ID |
| --- | --- | --- |
| 更新前 web | `0d8dfbca3928e2c5f4926ca75f4f5a78213169f4` | `sha256:5a1ee43facaa136b7cf2c7b7b115d79357f48ee6121534b6bb4eb78bcffcbea0` |
| 更新後 web | `ff719e9ac397ddbdecec08e5f8484c96ea4ec080` | `sha256:f1b37ec8420d293f411867ebb59ad5bf93cdcb5968692e99bbe788acc5bf9256` |
| 全程保留 bot | `07defc429d619a7558ab7218372886f531813ae3` | `sha256:e9d93c4441e2a34989722d7a5a86f87c8fa99cbc638b37cfe75a712fe6aa6720` |
| 最終 music | `660886fe1ebe5bd5c2830502daf9e21969a88f97` | `sha256:05cd356b4ed0d9fe4280f886757a40b44d6d625bb1a5185aa515727576ddbab1` |

初次 music 映像為 `sha256:ee64e89b7931fe223c8673516acc9e4a7fa87009e3dfb95d62c72694a888aebd`，來源同 web；最後只更新 music，保留 web 和 bot 的容器、映像及啟動時間。

兩次發布使用的來源提交均先整合、推送遠端 main，乾淨工作目錄執行完整 SHA 的 `deploy/check_release_source.py` 通過後，只封存該提交，在新暫存目錄各建置一次。初次封存 SHA-256 為 `29f0e80e544c2910561683b211157426ab65951b6e7553e658e957a0cd3c39e7`；music 修正封存為 `50f7b336020eef664f4153a50b91be7459d2263304b09d2c9bbe10ca429c0d3c`。

## 相容性與驗證

- 看板 schema 維持 20，`qgroup_bot/`、storage、活動、報名、包房、帳務及 outbox 程式未變。共用 accounts 模組只放行固定的 `/music/` 授權返回路徑，既有根頁返回規則不變；新增代理僅由 web 匯入。繁簡訊息只新增成分站錯誤字串，沒有改動原字串。
- 本機完整 706 項 Python、15 組 JavaScript 通過。最終 music 可見範圍修正後，19 項 music 權限、關聯、遷移、備份與刪除重播測試通過。
- 初次正式 web 候選映像匯到本機，核對 image ID 相同，於 linux/amd64 隔離容器執行 706 項測試，305.604 秒、退出碼 0、OOMKilled=false；略過 8 項未安裝 Git 的來源檢查測試，原生完整測試已通過。無外部網路、正式憑證或資料，UID:GID 994:992，唯讀 rootfs，記憶體 1 GiB、不允許額外 swap、CPU 2、PID 256、上限 420 秒。
- music 兩份確切映像均做實際啟動、預先關聯、身分所有權及成套備份探測；最後修正映像另驗證他人非公開性別／留言隱藏，以及自己的資料及公開性別正常。最終探測僅在正式機的隔離容器使用合成資料，network none、128 MiB、不允許額外 swap、CPU 0.5、PID 64、上限 60 秒。
- 新 web 與線上舊 bot 的實際映像，依序用正式備份副本驗證初始化、8 場活動與包房讀取；60 張原表內容完全不變，完整性及外鍵通過。各限制 192 MiB、不允許額外 swap、CPU 0.5、PID 64、上限 60 秒。完整測試未在正式主機執行。
- 切換前取得部署鎖、核對 web／bot 基線未漂移，建立 SQLite／圖片配對備份；初次切換前備份為 `/var/backups/qgroup/kanban-20261114-152502-119373.sqlite3`（實際路徑亦記於保全目錄的 `board-backup-path.txt`）。未還原正式看板資料庫，未建立測試用正式帳號、活動或關聯。
- 瀏覽器驗證合成舊帳號登入、成分顯示及重新整理保持登入，未見前端 console error。真實 QQ 授權、原匯出中各會員的口令仍須由本人驗證；不把模擬官方回應或同域部署當成真實授權成功。
- 外網 HTTPS 驗證原看板 7 個資源狀態及內容雜湊與切換前完全一致；成分站頁面、資源、隱私說明與健康正常。未登入的成分、會員查詢被拒絕；舊資料匯出被拒絕；偽造身分標頭不能繞過後端。原 QQ callback 說明頁和合作方未帶金鑰拒絕規則正常。
- 初次 web 的 116 個運行檔案摘要核對來源通過。最終三服務均 healthy、restart 0；bot 容器 ID `85d4c7c6f4cb6d99ac99674501236b41eb96f138a8287bc2e5fd088558daacf1`、映像及啟動時間 `2026-11-14T11:10:05.414454701Z` 全程未變。

## 保全與回退

- 初次來源及操作保全：`/opt/qgroup-backups/music-ff719e9`；乾淨建置來源 `/opt/qgroup-releases/music-ff719e9`。
- music 修正來源與操作保全：`/opt/qgroup-backups/music-privacy-660886f`；建置來源 `/opt/qgroup-releases/music-privacy-660886f`。
- `/opt/qgroup/release-manifest.json` 按服務記錄實際來源與映像。看板固定映像覆寫為初次保全目錄中的 `active-compose.json`；music 獨立 Compose 為 `/opt/qgroup-music/compose.yaml`，`.env` 固定最終映像 ID。共用 QGROUP_TAG 的看板 Compose 仍須在整組操作前人工核對，沒有宣稱新增自動鎖版保障。
- music 資料使用獨立 JSON、SQLite、配對備份及刪除重播 ledger。修正前停 music，另做配對備份，更新後逐項核對會員、條目、喊話及所有關聯均未改動；不拿初始匯出覆蓋新寫入。
- 如需停用入口，可只停 music，或回退 web 至原 `5a1ee43…` 映像，保留 bot 原版本。看板資料庫無新增 schema，不還原舊 DB。music 新關聯及偏好繼續保留；含性別可見範圍問題的初次 music 映像不作公開回退目標，故障時先停服務並向前修復。

本發布紀錄為 `none` 的後續文件提交，不重新建置或重啟服務。
