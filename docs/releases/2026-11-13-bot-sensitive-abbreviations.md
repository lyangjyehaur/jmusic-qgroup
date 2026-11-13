# Bot 縮寫敏感詞與完整投遞發布

2026-11-13 19:10（Asia/Taipei）完成 server2 切換及運行驗證。發布範圍：`bot`。部署成熟社群詞庫、簡繁與跨候選遮蔽、查詢整體逾時、非同步收訊及長結果續讀。候選數量、順序、重複項目與釋義長度仍完整保留；命中詞表以 `[已遮蔽]` 取代。

## 審查與來源

本次審查未發現阻擋發布的問題，未額外修改運行程式。正式來源 `09d61458046c58d3f88f4c07101db3efbf304cae` 已整合並推送 main；乾淨工作目錄執行 `python3 deploy/check_release_source.py --commit 09d61458046c58d3f88f4c07101db3efbf304cae` 通過後，只封存該 SHA。Archive SHA-256 `7c0f411f4ccd0e4f022a3945acf07b19177d6c4ea079ff27e1e1454205318e5d`。乾淨建置目錄 `/opt/qgroup-releases/sensitive-09d6145`，建置一次，沒有上傳工作目錄或正式資料庫。

| 階段 | 服務 | 完整來源 commit | 映像引用 | 實際 image ID |
| --- | --- | --- | --- | --- |
| 前後相同 | web | `675984b34cef4255b0eee1f16d10e82486399c07` | `qgroup:20261113-flex1-675984b` | `sha256:1b41f6a4e21b37dbfec46e80fa23d40e5f98136deac395da50a57e9ac11ae0c8` |
| 切換前 | bot | `333eb9b0c665673691567782c23d621a10649216` | `qgroup:20261113-abbrev2-333eb9b` | `sha256:33f6ce1850c776014bc0f4f6f9e2e218899fa712f82b804ef2baf96815668585` |
| 切換後 | bot | `09d61458046c58d3f88f4c07101db3efbf304cae` | `qgroup:20261113-sensitive-09d6145` | `sha256:9f92ca6442f2a15d843f1f7ed785806f5f3fd92aa1b1b6d754be1746e9d49001` |

運行差異限於 bot；共用核心、schema、outbox、設定語意、網頁入口、Dockerfile 及 Compose 均不變。正式 manifest 同時保存兩服務各自的來源、映像與檔案摘要。Compose 仍共用 `QGROUP_TAG`，本次只執行 `up -d --no-deps --no-build bot`；整組重建或主機恢復前須按 manifest 核對版本組合，尚未實作獨立版本鎖定。

## 驗證結果

- 本機 288 項 bot 測試通過。涵蓋完整候選與符號保留、Unicode／簡繁／跨候選遮蔽、規則更新與錯誤時關閉輸出、4 秒整體網路等待、非同步收訊／心跳、快取容量，以及多輪續讀／失敗段保留／不確定投遞不自動重送。
- 新映像使用 UID:GID 994:992、唯讀根目錄、隔離暫存資料庫、無網路及無正式憑證，全域 bot 開關關閉／開啟兩輪完整 Python 測試各 619 項通過（各 skipped=8）。
- SQLite／圖片配對備份副本使用新映像執行遷移演練，schema 18 → 18，兩次初始化保留所有原表原欄位值及圖片；完整性和外鍵檢查通過。
- 實際線上 web 映像與新 bot 映像分別讀取同一份演練後資料庫，設定／原指令／投票契約正常，重複初始化不改資料。兩邊共用運行檔摘要相同，支持單邊發布及回退。
- 切換後 web 容器 ID、image ID、啟動時間與 restart 次數保持原樣；兩服務 running／healthy、restart 0。Web 100 個、bot 110 個運行檔摘要符合各自來源。
- 新 bot 的 READY、ACK、poll 均晚於啟動，reconnect 0；啟動錯誤數 0，外部 `/api/health` 正常。資料庫仍 schema 18，設定與 worker revision 均為 6，未修改群組或發送政策。
- 新映像切換前公開 API 查詢成功；切換後正式 bot 容器查詢 `yyds,nbnhhsh` 成功，產生 313 字回覆，並確認政治詞遮蔽。以生產 UID 在私有暫存目錄模擬 QQ 長度拒絕、多輪續讀與重建投遞器，拼接結果完整、檔案清理正常，目錄 0700。沒有實際向 QQ 發送；真實群聊驗收尚未完成。

本機詞表可能誤判或漏判，無法保證等同 QQ 的審核標準。詞庫與效能資料見[功能說明](../bot-abbreviations.md)及[效能紀錄](../bot-sensitive-words-performance.md)。

## 保全與回退

演練備份 `/var/backups/qgroup/kanban-20261113-110659-433626.sqlite3`；切換前備份 `/var/backups/qgroup/kanban-20261113-110909-200658.sqlite3`，各有配對 `.images.tar.gz`。`/opt/qgroup-backups/sensitive-09d6145`（0700）保存舊來源／環境／manifest、基線、測試、演練、混合版本驗證及運行報告；舊映像保留。

回退目標為表列原 bot `333eb9b` 與不變的 web `675984b`。取得部署鎖，確認尚無後續發布及當前 schema／契約相容，停止 bot，移除僅本次新增的來源檔，再還原保存的來源、環境與 manifest；以明確舊 image ID 的 Compose override 只重建 bot。核對 web 保持原樣及 bot 新 READY／ACK／poll。保留現有資料庫及圖片，不覆蓋發布後資料。回退會停用此次本機敏感詞遮蔽與續讀功能。

本紀錄及功能文件的後續提交範圍為 `none`；不重新建置或重啟正式服務，bot 運行來源維持表列功能 SHA。
