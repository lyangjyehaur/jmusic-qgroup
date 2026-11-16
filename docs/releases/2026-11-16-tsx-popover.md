# TSX 與報名成分浮層正式發布

2026-11-16 23:35:15（Asia/Taipei）完成 server2 發布。發布範圍：`web`，包含看板及獨立 music 服務；bot 保留原容器、映像與啟動時間。

## 畫面與功能

- 看板與管理後台改為直接 React TSX，移除執行時對舊畫面控制器的依賴。React 原始碼統一使用 TypeScript，啟用 strict 型別檢查。
- 成分站的已選詞條、熟悉程度、保存列及回到頂部改為直接 TSX，修正分段選項空隙與浮動按鈕位置。其餘成分畫面仍逐步遷移，尚未全部移除轉接層。
- 移除展示型介紹文字、活動分類標識和連結下劃線；成分站連結移入看板頁首，恢復 ICP 備案號 `渝ICP备16002872号-1`。
- 報名名單的頭像或名稱開啟 Yahha Popover 成分卡，定位在對應成員旁；點外側或 Esc 關閉，同時只顯示一張，不疊加第二個彈窗、不展開名單、不新增歷史紀錄。手機版限制浮層範圍。
- 新增唯讀成分查詢橋接，依活動存取權、報名者目前身分關聯和查看者成分關聯驗證；同行者不沿用代報人的成分。只回傳已選成分與共同喜好，不回傳 QQ、OpenID、性別或私人備註；內部入口拒絕未授權與偽造上下文。

## 正式版本

| 服務 | 來源 commit | 實際 image ID |
| --- | --- | --- |
| 更新前 web | `9f8be713da511351ff14c8f9259cb0783dfcc903` | `sha256:c7418fea93357753a213bcca6263fb7b7b1b568223ae7ac2ed5a2348bcfe2a6f` |
| 更新前 music | `9f8be713da511351ff14c8f9259cb0783dfcc903` | `sha256:7a5e8a004ec109e480e45dc36439059f3405c05c61184f5e1088e91b84b49558` |
| 更新後 web | `be51e065bd0d64a2df3a783ca14672d92ba6d49a` | `sha256:7a9ded728d988d05399a3518faae52d19eeb556d7b964928806894a16ebb4ef5` |
| 更新後 music | `be51e065bd0d64a2df3a783ca14672d92ba6d49a` | `sha256:2f066c1b478a4240b38fa45ee6a31337e9fc100fc8ca0400c9f7994718c66d0f` |
| 保留 bot | `07defc429d619a7558ab7218372886f531813ae3` | `sha256:e9d93c4441e2a34989722d7a5a86f87c8fa99cbc638b37cfe75a712fe6aa6720` |

功能提交先合入 `main` 並推送 git.dan.tw 與 GitHub，兩邊 SHA 核對一致。完整提交通過 `python3 deploy/check_release_source.py --commit be51e065bd0d64a2df3a783ca14672d92ba6d49a`；只封存該提交，封存 SHA-256 為 `78f351f6ad4d194a0bcced6b83f1ba90a24921b419a735858c7f803aec2afd32`。

在本機乾淨封存目錄，以正式 Dockerfile 建置 linux/amd64 映像，標籤 `qgroup:20261116-tsx-popover-be51e06`、`qgroup-music:20261116-tsx-popover-be51e06`，記錄完整 revision label。首次快取建置因快取摘要缺失、尚未產生候選映像而失敗；後續停用快取，各建置一次，限額 1 GiB、不允許額外 swap、2 CPU、單次 360 秒。驗證並傳輸同一份確切映像至 server2，未在正式主機重新建置。

核准來源保存於 `/opt/qgroup-releases/tsx-popover-be51e06`，保全與驗證結果位於 `/opt/qgroup-backups/tsx-popover-be51e06`。

## 驗證與相容性

- 本機 **742 項 Python 測試、16 組 JavaScript 測試**通過；`npm run test:ui`、`npm run check:ui`、strict 型別檢查與 `git diff --check` 通過。隔離瀏覽器驗證報名、同行、分房、結算、帳務、投票、管理操作、成分保存及浮層的定位、關閉、焦點、歷史紀錄與名單版面。
- 確切新版 web 映像以 Python 3.11 執行 **102 項 music／報名／隱私／簡繁測試**通過。web **239 個**、music **34 個**執行檔案雜湊符合核准來源；正式運行容器再次核對通過。
- 正式 SQLite 備份隔離副本通過遷移演練、完整性、外鍵及重複初始化檢查。新版 web 與保留 bot 的實際映像各自讀取 **9 場活動**及包房，**60 張資料表逐值不變**，schema 維持 **20**。測試不帶正式服務憑證、無外部網路，以非 root、唯讀 rootfs 及記憶體／CPU／PID 限額執行。
- `qgroup_bot/` 與保留 bot 提交沒有差異；新增 `qgroup_core/music_profiles.py` 是 web 使用的唯讀橋接，沒有 schema、outbox、設定語意或 bot 網頁入口契約變更。既有 locale 文案不變，只增加新字串，因此驗證後按 `web` 單邊發布。
- 切換時取得部署鎖與最新看板備份；停止 music 後取得服務鎖，保存完整資料。啟動後確認 **57 位會員、138 個詞條**、設定、喊話與身分 SQLite 原資料列保留。沒有建立正式測試帳號或提交驗收寫入。
- web、music、bot 均 healthy。bot 容器 `85d4c7c6f4cb6d99ac99674501236b41eb96f138a8287bc2e5fd088558daacf1`，啟動時間 `2026-11-14T11:10:05.414454701Z` 均不變。
- 外網 HTTPS **25 項檢查**通過：HTML／CSS／模組／Service Worker 逐位元符合來源、JavaScript MIME、健康與匿名資料／管理／匯出／內部成分入口保護。正式匿名手機瀏覽器驗收通過看板、成分站、兩個管理頁、手冊與兩站隱私頁；無 JavaScript 例外、模組載入失敗或橫向溢出。登入後操作使用隔離測試驗證，真實 QQ 授權仍由會員本人操作。

## 保全及回退

最新看板備份為 `/var/backups/qgroup/kanban-20261116-153459-152905.sqlite3`，對應圖片封存一併保留。保全目錄包含舊程式、manifest、環境設定、服務原版本、核准來源、映像 ID、驗證與切換結果，以及停止狀態的完整 `music-before/`；私人資料與憑證不加入 Git。

正式 `/opt/qgroup/release-manifest.json` 已記錄實際版本、檔案雜湊與相容組合。整組維運須使用 `/opt/qgroup/compose.yaml` 加 `/opt/qgroup-backups/tsx-popover-be51e06/active-compose.json` 固定 web／bot；music 的 `/opt/qgroup-music/.env` 固定新映像 ID。共用 `QGROUP_TAG` 仍無法單獨表示這組版本，獨立版本自動鎖定尚未實作。

回退目標為表中的更新前 web、music，加上保留 bot。前版可讀取目前 schema，新增橋接不改寫資料。回退前先保全最新資料、核對實際版本組合；使用保全的 `rollback-compose.json` 固定舊 web／bot，恢復 `music-env-before` 的映像設定，只重建受影響服務。保留目前資料庫、JSON、刪除 ledger、圖片及發布後新寫入，不用舊備份覆蓋即時資料。

此發布紀錄屬後續 `none` 文件提交，不重新建置或重啟服務。
