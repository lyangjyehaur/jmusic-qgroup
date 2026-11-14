# 合作方公開活動唯讀 API 與 Bearer 鑑權

2026-11-14 20:18（Asia/Taipei）完成 server2 部署，發布範圍：`web`。提供公開活動列表、單場詳情、報名人員與預分／實際包間；整組 API 均需合作方 Bearer 金鑰。未配置即停用，金鑰不能以網站登入 Cookie 或網址參數代替。資料範圍與呼叫範例見[對接文件](../public-api.md)。

## 來源與服務版本

功能提交已整合並推送遠端 main，在乾淨工作目錄以完整 SHA 執行 `deploy/check_release_source.py` 通過後，只封存該提交。Archive SHA-256：`f56d4398e7dd28b5f839e47b65279699d3832aede581a6b777a41b7df6440bde`；乾淨建置目錄 `/opt/qgroup-releases/partner-api-0c2279d`，僅建置一次。候選映像匯入本機後 image ID 相同，沒有重建另一份映像。

| 階段 | 服務 | 完整來源 commit | 映像引用 | 實際 image ID |
| --- | --- | --- | --- | --- |
| 切換前 | web、bot | `07defc429d619a7558ab7218372886f531813ae3` | `qgroup:20261114-rooms-07defc4` | `sha256:e9d93c4441e2a34989722d7a5a86f87c8fa99cbc638b37cfe75a712fe6aa6720` |
| 切換後 | web | `0c2279d175f4b629b5c88bdca12b092774e0cd98` | `qgroup:20261114-partner-api-0c2279d` | `sha256:981f8400fb34f493bee3b9bdd20cadf6a71ef5fc364bf656fa820228d9f4b769` |
| 切換後 | bot（保留） | `07defc429d619a7558ab7218372886f531813ae3` | `qgroup:20261114-rooms-07defc4` | `sha256:e9d93c4441e2a34989722d7a5a86f87c8fa99cbc638b37cfe75a712fe6aa6720` |

web 實際 Compose 使用明確 image ID override；版本標籤用於來源識別。bot 容器 ID `85d4c7c6f4cb6d99ac99674501236b41eb96f138a8287bc2e5fd088558daacf1`、image ID 及啟動時間 `2026-11-14T11:10:05.414454701Z` 均未變。`/opt/qgroup/release-manifest.json` 記錄兩服務實際來源、映像與各自檔案摘要。

## 相容性與驗證

- 本機原生 Python 682 項與全部 15 組前端測試通過，API 專項 14 項涵蓋鑑權、輪替／撤銷、錯誤配置、日誌遮蔽、可見性、ID 對照、認領、註銷及包間快照；簡繁產物已重建。
- 同一個正式候選映像在本機 OrbStack 以 linux/amd64 跑 682 項測試（skipped=8），307.614 秒，退出碼 0、OOMKilled=false。無外部網路、無正式資料或憑證，UID:GID 994:992、唯讀根目錄，限制記憶體 1 GiB、禁止額外 swap、CPU 2、PID 256、單輪 420 秒；未在正式機跑完整測試。
- 正式機準備時可用記憶體大於 350 MiB，依序執行配對備份與輕量演練。容器限制 192 MiB、禁止額外 swap、CPU 0.5、PID 64，遷移演練最多 90 秒、bot 讀取最多 60 秒。資料副本完成兩次初始化，保留全部原表原欄位值，驗證圖片、SQLite 完整性及外鍵；schema 維持 19。
- 實際線上 bot 容器內 52 個核心／bot 檔案摘要與新版來源完全一致。新版 web 使用的演練資料庫由原 bot image ID 以唯讀方式讀取，活動、名單統計、報名狀態及包間查詢正常，資料庫前後雜湊一致。沒有 schema、outbox、共用設定或 bot 網頁入口變更，允許這次混合版本及 web 單邊回退。
- 取得部署鎖，確認兩服務原容器、映像、manifest 及 Compose 環境無漂移，追加配對備份後只重建 web；未停 bot、未還原資料庫、未向正式資料寫入驗收活動或款項，未向真實 QQ 群投遞測試訊息。
- 切換後 web／bot healthy，web restart 0、OOMKilled=false。web 183 個映像內檔案摘要符合核准來源；正式 schema 仍為 19，完整性及外鍵檢查通過。
- 正式 HTTP 與 HTTPS 各驗證 7 場公開活動的詳情、名單及包間：無金鑰／錯誤金鑰 401，有效金鑰 200，帶金鑰寫入 405，HEAD 200；沒有設定登入 Cookie。另驗證 1 場非公開活動的三個查詢端點，即使帶有效金鑰也全部 404。本機對外 HTTPS 再確認無金鑰 401、有效金鑰 200。
- 正式首頁、隱私頁、手冊及 rooms.js 共 4 個資源摘要符合核准來源。這些結果不代表第三方網站已完成串接。

## 金鑰與保全

首把合作方金鑰保存在 server2 `/etc/qgroup/public-api.env`，root 所有、0600，只由 web 載入。交付副本在本機 `artifacts/private/`，未進 Git、映像、發布紀錄或對話正文。請由合作方後端透過 HTTPS 帶 `Authorization: Bearer <API_KEY>`，不能放在網頁前端。正式換鑰與撤銷仍須按文件重新載入 web 環境。

演練配對備份 `/var/backups/qgroup/kanban-20261114-120838-858146.sqlite3`；切換前配對備份 `/var/backups/qgroup/kanban-20261114-121801-963958.sqlite3`。各自同前綴 `.images.tar.gz` 成套保留。`/opt/qgroup-backups/partner-api-0c2279d`（0700）保存原來源／Compose 環境／manifest、基線、建置、映像測試、演練、混合版本探測、切換與驗收紀錄；舊映像保留。

## 回退與後續操作

回退目標為表列原 web image ID，bot 維持原 image ID；相同 schema／核心／outbox 可相容。先取得 `/run/lock/qgroup-deploy.lock`、核對沒有後續發布並追加備份，恢復保存的舊來源、Compose 環境與 manifest，再以 `/opt/qgroup-backups/partner-api-0c2279d/rollback-compose.json` 的固定 image ID override，只執行 web 的 `up -d --no-deps --no-build`；重新驗證健康及 bot 容器未變。回退不覆蓋目前 SQLite 或圖片，舊 web 不提供這組合作方 API。

本次使用 `/opt/qgroup-backups/partner-api-0c2279d/active-compose.json` 固定切換的兩個映像。Compose 仍共用 `QGROUP_TAG`，不具全域獨立鎖版或自動保障；後續整組啟動、重建或主機恢復前須重新核對實際版本組合，不可只追隨共用標籤。

本發布紀錄及 README／對接文件的後續狀態提交範圍為 `none`，不重新建置或重啟；正式 web 來源維持 `0c2279d175f4b629b5c88bdca12b092774e0cd98`。
