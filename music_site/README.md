# 成分站隔離部署與身分對照

發布範圍：`web`，另新增獨立 music 容器。看板與 bot 的 schema、活動、報名、包房及 outbox 契約不變。

來源：FORKSTICK/jp-music-fans `138ea2c27f0ad6aace4c96a36c217d8cd63fc891`。
原作者與來源：https://github.com/FORKSTICK/jp-music-fans 。原 README 允許修改為自己的群站；本副本保留來源，不主張原程式為本站原創或另行授權。

## 入口與隔離

- 公開入口 `/music/`，API `/music/api/*`；原 `/`、`/api/*`、`/admin` 及 QQ callback 保持原路由。
- 1Panel/TLS/上游設定不變。看板只新增可停用的本機轉接，獨立容器監聽 `127.0.0.1:8788`。
- 不轉傳看板／管理 Cookie、使用者提供的身分標頭或 Bearer key。後端共用隨機轉接金鑰，僅把伺服器核對的目前身分傳給 music；OpenID 不進瀏覽器回應。
- music Cookie 名稱 `music_session`，HttpOnly、Secure、SameSite=Lax、Path=/music/。原口令不存入 localStorage。
- Service Worker scope 為 `/music/`，只管理 `qgroup-music-*` 快取，不快取 API／登入頁導覽；不清理看板快取。
- music JSON 與身分 SQLite 都在 `/var/lib/qgroup-music`；不掛載、不寫入看板 SQLite。
- 只讀成分接口須登入。原成分站管理／備份下載接口停用；此首版只接受已有口令的舊會員，不開放舊式註冊。

## 關聯

1. 匯入時，既有 `boardUserId` 只在唯一、有效且帳號未註銷時保留為管理員預先對照。重複目標全部列待核對，不猜測誰正確。
2. 已預先對照者直接使用看板身分，正常 QQ 登入時補存 App ID、OpenID，來源標記 `admin_board_user_id`，不要求舊 PIN。
3. 其他會員先以 QQ＋舊 PIN 登入；前往 QQ 授權之前，將本次舊站 session 與看板 session 的摘要綁定十分鐘。
4. 沿用看板 QQ 應用與 `/auth/qq/callback`。返回看板既有確認畫面，確認後回到 `/music/`，核對同一發起 session 的已完成授權，再單次提交關聯。
5. 看板已有帳號直接沿用；首次 QQ 登入仍走看板現有註冊。不得把成分站 PIN 當成看板登入憑證。
6. QQ、看板 user_id、App ID/OpenID 均避免衝突覆蓋。成功後舊 PIN 不再可登入該成分檔案，管理員處理例外。PIN 登入按 QQ 及 IP 持久化限流。

此關聯證明使用者能操作舊站帳號與授權的 QQ 身分，不代表騰訊回傳或驗證了相同的 QQ 號碼。

## 正式資料與運維

初始資料為使用者提供的匯出副本，不與原站持續雙向同步。不得把正式 JSON、SQLite、QQ、口令 hash、轉接金鑰或待核對清單加入 Git。

準備資料前以唯讀方式從看板匯出未註銷的帳號 ID 清單，執行 `deploy/prepare_music_snapshot.py`，輸出到新的私人目錄。結果只列總數，逐筆待核對清單留在私人檔案。缺口令的會員須由管理員核對，不能以任意新口令認領。

`deploy/music-compose.yaml` 獨立管理 music，使用固定映像 ID，記憶體 128 MiB、不允許額外 swap、CPU 0.5、PID 64、唯讀 rootfs；資料目錄 0700、檔案 0600、UID:GID 994:992。轉接金鑰在 `/etc/qgroup/music.env`，合作方唯讀金鑰在 `/etc/qgroup/music-partner.env`，均 root 0600；QQ App Key 仍只提供給原 web。

JSON 使用原子寫入，身分庫用 SQLite online backup，寫入時每小時最多保存一組到 `paired-backups/`，最多 30 組且不超過 14 天；趨勢定時保存也會觸發備份。首次發布前保全原站匯出及準備好的初始成套資料，禁止拿原始匯出覆蓋已建立的新關聯。

資料刪除先停 music，使用相同固定映像與資料掛載執行 `python3 -m music_site.maintenance erase --qq <已核對的QQ>`，再啟動。維護鎖會拒絕與在線服務共同寫入。刪除意圖先同步寫入 `erasures.jsonl`，再清理會員、關聯、會話、喊話及詞條建立者身分；每次啟動重播。恢復備份時保留獨立的最新 ledger，再啟動重播，不以備份覆蓋 ledger。原始匯出與私人待核對清單依申請另行核對。

移除轉接金鑰並重新建立 web，可停用入口而保留 music 資料。亦可回退到前一個 web 映像，原看板資料庫無 schema 變更；停止 music 容器，不刪除新增關聯，不以舊資料覆蓋。bot 全程保留原映像及容器。

真實 QQ 授權必須由帳號本人完成；模擬官方回應的整合測試不算真實授權驗收。
