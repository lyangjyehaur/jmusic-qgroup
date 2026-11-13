# Bot 縮寫查詢完整結果

2026-11-13 17:44（Asia/Taipei）完成 server2 bot 切換與運行驗證。發布範圍：`bot`。縮寫查詢移除每個縮寫 5 個候選、每個釋義 40 字及上游回應 64 KiB 的限制，按 API 回傳順序完整列出候選並保留重複項目。Web 容器、映像、啟動時間保持原樣。

## 版本與來源

正式來源 `333eb9b0c665673691567782c23d621a10649216` 已整合並推送 main；乾淨工作目錄執行完整 SHA 來源檢查通過後才封存。Archive SHA-256 `362d93a81da9b6e73b7ae519bd58ce3324f2b03000bc39a0da1cc36202fa89c7`。只從該封存包解開至乾淨建置目錄 `/opt/qgroup-releases/full-abbrev-333eb9b`，建置一次，沒有上傳未提交工作目錄或資料庫。

| 階段 | 服務 | 完整來源 commit | 映像引用 | 實際 image ID |
| --- | --- | --- | --- | --- |
| 切換前後均相同 | web | `675984b34cef4255b0eee1f16d10e82486399c07` | `qgroup:20261113-flex1-675984b` | `sha256:1b41f6a4e21b37dbfec46e80fa23d40e5f98136deac395da50a57e9ac11ae0c8` |
| 切換前 | bot | `675984b34cef4255b0eee1f16d10e82486399c07` | `qgroup:20261113-flex1-675984b` | `sha256:1b41f6a4e21b37dbfec46e80fa23d40e5f98136deac395da50a57e9ac11ae0c8` |
| 切換後 | bot | `333eb9b0c665673691567782c23d621a10649216` | `qgroup:20261113-abbrev2-333eb9b` | `sha256:33f6ce1850c776014bc0f4f6f9e2e218899fa712f82b804ef2baf96815668585` |

正式 `/opt/qgroup/release-manifest.json` 記錄兩服務各自的實際來源與映像。Compose 仍共用 `QGROUP_TAG`，本次將其指向新版 bot 標籤，只執行 `up -d --no-deps --no-build bot`。後續整組啟動、重建或主機恢復前須依 manifest 核對兩個服務的映像；本次單邊切換沒有實作獨立版本鎖定或自動發布門檻。

## 測試與相容性

- 正式來源相對線上來源的運行程式差異只有 `qgroup_bot/abbreviations.py`；共用核心、schema、outbox、設定語意、網頁入口、Compose 與 Dockerfile 相同。
- 本機 247 項 bot 測試通過，包含大量候選、完整長釋義、順序與重複候選、超過 64 KiB 的正常回應，以及完整結果傳入模擬 QQ 發送介面。
- 正式映像以 UID:GID 994:992、唯讀根目錄、隔離暫存資料庫、無網路及無正式憑證執行完整 Python 測試；全域 bot 開關關閉／開啟兩輪各 578 項通過（各 skipped=8）。
- SQLite 與圖片配對備份的隔離副本，以新映像執行 `deploy/verify_migration.py` 兩次初始化，schema 18 → 18，所有原表原欄位值及圖片摘要保留，完整性及外鍵檢查通過。
- 使用實際線上 web 映像與新版 bot 映像，分別讀取同一份經演練的隔離資料庫副本；重複初始化不改任何資料，原有活動指令、投票可分享判定及設定讀取正常，沒有向 QQ 投遞。兩版所有共用運行檔摘要相同，支持本次 web／bot 版本組合及 bot 單邊回退。

## 正式驗證與保全

- 取得部署鎖後，只停止／重建 bot。Web 原容器 ID、映像、啟動時間及 restart 次數均不變；兩服務皆 running／healthy、restart 0。
- 各服務 100 個運行檔摘要分別符合自己的來源版本。新版 bot 的 READY、ACK、poll 均晚於啟動，reconnect 0；啟動錯誤數 0，外部 `/api/health` 正常。
- 資料庫維持 schema 18，無正式遷移、無資料庫還原；完整性與外鍵檢查通過。Bot 設定 revision 6，worker 已載入 revision 6，未變更群組、通知或發送政策。
- 新映像上線前查詢公開 API 成功。切換後在正式 bot 容器再次使用實際 client 查詢 `yyds,nbnhhsh`，收到 47 與 1 個候選；全部釋義出現在產生的回覆文字，共 302 字。此查詢沒有向 QQ 發送消息，不等於真實群聊驗收；長結果的 QQ 投遞測試使用模擬。
- 演練配對備份 `/var/backups/qgroup/kanban-20261113-094148-917633.sqlite3`；切換前配對備份 `/var/backups/qgroup/kanban-20261113-094357-815581.sqlite3`，各有同名 `.images.tar.gz`。
- `/opt/qgroup-backups/full-abbrev-333eb9b`（0700）保留原來源、環境、manifest、兩服務基線、建置與測試、演練、混合版本驗證及運行報告；舊映像保留。

## 回退

若需回退，取得部署鎖並確認未有後續發布，核對目前 manifest；只停止 bot，使用保存的原始碼／環境及明確舊 image ID，配合保存的 Compose override 僅重建 bot，再確認 web 容器保持不變、bot 健康且有新 READY／ACK／poll。舊版會恢復候選數量與釋義長度限制。Schema、outbox 與設定契約相同，回退保留當前資料庫與圖片，不得覆蓋發布後資料。

本紀錄及功能文件的提交範圍為 `none`，不重建或重啟正式服務；正式 bot 運行來源維持表列功能 SHA。
