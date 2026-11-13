# 待確認結束活動清單篩選發布

2026-11-13 14:33（Asia/Taipei）完成 server2 `/opt/qgroup` 切換。發布範圍：`both`，網頁近期清單與 bot 活動選單都需更新。

## 行為

- 「待確認結束」不列入首頁近期活動及其數量；「我參與的」、原活動連結及管理入口仍可查看，確認實際結束後才進入往期。
- bot `/活动`、裸 @ 及報名、名額等近期選單排除超過預計結束時間的活動。篩選先於清單上限，近期指令的序號保持一致；純文字與 Markdown 共用此篩選。
- 仍可指定活動短碼查詢，管理／待辦／結算入口保留；延長預計時間後可重新出現在近期選單。沒有預計結束時間的進行中活動仍保留。

## 版本與來源

| 階段 | 服務 | 完整來源 commit | 映像引用 |
| --- | --- | --- | --- |
| 切換前 | web、bot | `9ca7bb57ae33b5adc4d2f1a66f06d733e0edf7a4` | `qgroup:20261111-withdraw1-9ca7bb5` |
| 切換後 | web、bot | `f3731477a73fe33ec1ce85c929a5fa2a802628e3` | `qgroup:20261113-overdue1-f373147` |

兩服務切換前實際 image ID 均為 `sha256:3dee5aa5df27f874b330ebfd7624febc290d1c4dcd4e592b5c1e63a0de217e76`，切換後均為 `sha256:bb3e3ed6dce88490e984e7cc5f64a275441ef1c8109d9cb93ccc49f8c47f1d6a`。正式 `/opt/qgroup/release-manifest.json` 記錄兩服務實際映像及來源。

功能分支 fast-forward 整合並推送遠端 `main`，在乾淨工作目錄執行 `python3 deploy/check_release_source.py --commit f3731477a73fe33ec1ce85c929a5fa2a802628e3` 通過後，只封存該提交。Archive SHA-256：`9c3c4f5d6ff6eea9af94ef392016404b2f80001753fda5bde972d841f6ec7577`；所有來源檔案摘要核對通過，在乾淨目錄 `/opt/qgroup-releases/overdue-f373147` 建置一次，帶完整 commit 及版本 label。

## 驗證與相容性

- 本機完整 Python 測試在 bot 開關 `0`／`1` 下各 516 項通過，Node 12 組通過；包含近期清單與計數、簡繁產物、延長後恢復、原入口保留、時區及先篩選再限筆數。手冊與簡繁產物已重建，語法及 diff 檢查通過。
- 正式映像以 UID:GID 994:992、唯讀根目錄、無網路且無正式資料／憑證掛載，在兩種 bot 開關下各跑 516 項通過（各 skipped=8）。
- 正式配對備份的隔離副本以 UID:GID 994:992 完成兩次初始化；原表欄位與值、圖片、完整性與外鍵保留。Schema 維持 15，沒有新增遷移。
- 相對原運行版本，`qgroup_core/`、`server.py` 與 Compose 無變更，schema、outbox 格式、設定語意及網頁入口契約相容，允許新舊版本並行。本次成套更新兩邊的清單行為，沒有改變正式 bot 設定或發送模式。
- 取得部署鎖並核對原映像、來源及設定無漂移；先停 bot／web，由非 root 容器初始化並核對所有使用者表摘要完全一致，再啟動 web／bot。資料與設定保持原值，schema 仍為 15。
- 兩服務皆 healthy、restart 0，實際 image ID 與來源正確；各自 95 個運行檔案摘要符合核准來源。Bot 有新 READY／ACK／poll，reconnect 0，啟動檢查未發現錯誤。
- 外網簡繁首頁、app.js、手冊與 i18n.js 共 8 項均為 200 且摘要符合來源，`/api/health` 正常。正式 bot 以唯讀連線確認現有 1 場超時活動不在各近期選單，純文字／Markdown 回覆組裝成功；沒有發送測試群消息，真實 QQ 指令畫面未另做人工驗收。

## 備份與回退

- 演練配對備份：`/var/backups/qgroup/kanban-20261113-063025-827810.sqlite3` 及同名 `.images.tar.gz`。
- 切換前配對備份：`/var/backups/qgroup/kanban-20261113-063249-562148.sqlite3` 及同名 `.images.tar.gz`。
- `/opt/qgroup-backups/overdue-f373147` 保存原來源、Compose 環境、原 manifest、映像／兩輪測試／遷移演練／切換日誌、資料摘要、prepared／report／runtime-report，目錄權限 0700。舊映像保留。
- 回退取得部署鎖並確認沒有後續發布，先停 bot／web，恢復上述原來源、Compose 環境與 manifest，核對原 image ID，再依序啟動 web／bot 並確認健康與新心跳。新舊版使用相同 schema／outbox／設定，保留目前 SQLite 與圖片，**不得覆蓋發布後資料庫**。回退將恢復原先清單會顯示超時活動的行為。

本紀錄後續提交範圍為 `none`，不重新建置或重啟；正式運行來源仍為 `f3731477a73fe33ec1ce85c929a5fa2a802628e3`。
