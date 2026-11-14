# 用戶內部備註與手動 QQ 關聯

2026-11-14 21:39（Asia/Taipei）完成 server2 部署，發布範圍：`web`。只更新 web，保留原 bot 容器及映像。

管理後台「用戶管理」新增「編輯備註與 QQ 號」。內部備註最多 1000 字；手動 QQ 號可留空，填寫時為 5 至 12 位 ASCII 數字、首位非零。同一 QQ 號只可手動關聯一個帳號，清空並保存後可重新關聯。可按備註或 QQ 號搜尋，保留原文及換行。

這兩個欄位僅管理員可讀寫，不進入一般帳號／活動回應或合作方 API；手動關聯不驗證 QQ 所有權，不改變登入、OAuth 身分、UnionID 或報名歸屬。對外維護對照仍使用既有 `user_id`。合作方接入文件與 API 契約維持原樣。

## 儲存與權限

- schema 20 新增 `admin_user_metadata` 及非空 QQ 號唯一索引，保留既有表和資料。記錄最後修改時間與操作者，不建立包含舊備註／QQ 號的永久歷史。
- `POST /api/admin/users/metadata` 使用既有管理員權限、同源及 CSRF 檢查；寫入在 `BEGIN IMMEDIATE` 交易內完成。
- 備註／QQ 號使用獨立於管理員權限的 `metadata_revision`；過期的 `base_revision` 回 409。清空後保留版本，避免舊頁面覆蓋；儲存失敗保留輸入，可明確重新載入。
- 帳號註銷及備份恢復的刪除意圖重播均清除這兩欄，已註銷帳號不可重新填寫。

## 本機驗證

- Python 688 項與 JavaScript 15 組通過；已重新產生操作手冊與繁簡產物。
- 覆蓋管理員／一般用戶權限、CSRF、跨站拒絕、搜尋、格式與長度、QQ 重複、版本衝突、清空重新關聯、註銷及恢復重播、schema 19 升級與注入失敗後的交易回退。
- 一般活動回應、合作方活動／參與者／包間接口均驗證不洩露備註及 QQ 號。
- 實際瀏覽器驗證保存、重新開啟、QQ 號搜尋、重複提示、失敗保留輸入，以及原文、換行與 HTML 跳脫。
- 與線上 bot 來源 `07defc429d619a7558ab7218372886f531813ae3` 的隔離混合版本驗證通過：新核心建立 schema 20、用戶備註及活動；舊 bot 的初始化、活動查詢和 outbox 模擬投遞正常，備註原值保留，完整性與外鍵檢查通過。沒有呼叫真實 QQ。`qgroup_bot/` 與 bot 使用的業務契約未改動，故可只發布 web。

## 發布與回退限制

功能已整合並推送 main，乾淨工作目錄執行完整 SHA 的來源檢查通過後，僅封存該提交，在新的乾淨目錄建置一次。候選映像匯到本機後核對 image ID 相同，沒有重建另一份映像。切換前取得部署鎖、再做配對備份並核對基線未漂移。

schema 20 為新增表，舊 bot 可繼續運行。舊 web 不認識新欄位的註銷清除邏輯：已有備註／QQ 號寫入後，不能直接回退到舊 web 並恢復註銷服務；須保留本次清除邏輯的修正版本，或在維護狀態先完成新表資料清除及刪除意圖重播核對。不可用舊資料庫備份覆蓋後續正式寫入。

## 正式來源與版本組合

| 階段 | 服務 | 來源 commit | 實際 image ID |
| --- | --- | --- | --- |
| 切換前 | web | `0c2279d175f4b629b5c88bdca12b092774e0cd98` | `sha256:981f8400fb34f493bee3b9bdd20cadf6a71ef5fc364bf656fa820228d9f4b769` |
| 切換後 | web | `0d8dfbca3928e2c5f4926ca75f4f5a78213169f4` | `sha256:5a1ee43facaa136b7cf2c7b7b115d79357f48ee6121534b6bb4eb78bcffcbea0` |
| 全程保留 | bot | `07defc429d619a7558ab7218372886f531813ae3` | `sha256:e9d93c4441e2a34989722d7a5a86f87c8fa99cbc638b37cfe75a712fe6aa6720` |

新版標籤 `qgroup:20261114-user-metadata-0d8dfbc`；封存 SHA-256 `f529cf9386567e50ba5e978a5a629e0f0c16ea1f1623ce2ca22218ace9b489d9`。建置目錄 `/opt/qgroup-releases/user-metadata-0d8dfbc`；操作、基線及驗收紀錄位於 `/opt/qgroup-backups/user-metadata-0d8dfbc`（0700）。

## 正式候選與上線驗收

- 同一正式候選映像在本機 linux/amd64 隔離容器完成 688 項 Python 測試（skipped=8），295.32 秒，退出碼 0、OOMKilled=false。略過的是映像未安裝 Git 的 8 項發布來源測試，已在本機原生完整測試通過。無外部網路、正式資料或憑證，UID:GID 994:992、唯讀根目錄，記憶體 1 GiB、禁止額外 swap、CPU 2、PID 256、測試上限 420 秒。完整測試未在正式機執行。
- 正式備份副本完成 schema 19→20 遷移並重複初始化，全部原表原欄位值、圖片、完整性及外鍵檢查通過；原 bot 實際映像讀取遷移後 8 場活動與包房正常，資料庫雜湊未變。舊 web 映像亦驗證可初始化 schema 20 的空 metadata 資料副本且無資料異動；此結果不解除上方已有 metadata 後的回退限制。
- 正式機的輕量容器依序執行，限制記憶體 192 MiB、禁止額外 swap、CPU 0.5、PID 64、遷移上限 90 秒、各版本相容性探測上限 60 秒。
- 切換前配對備份 `/var/backups/qgroup/kanban-20261114-133936-245579.sqlite3` 及同前綴 `.images.tar.gz`；未還原正式庫，也未寫入驗收用帳號、活動或 metadata。
- 正式 schema 20，metadata 表結構、SQLite 完整性及外鍵正常；web 183 個運行檔案摘要與核准來源一致。繁簡後台、admin.js、隱私頁及共用 CSS 共 7 個外網資源摘要核對通過。
- HTTP 與 HTTPS 健康檢查正常；管理 session／用戶列表及 metadata 寫入未登入均回 401。合作方無／錯誤金鑰 401，有效金鑰 200；兩個入口各驗證 7 場公開活動、名單及包房，未新增 metadata 欄位。
- web 與 bot 均 healthy；web restart 0、OOMKilled=false。bot 容器 ID `85d4c7c6f4cb6d99ac99674501236b41eb96f138a8287bc2e5fd088558daacf1`、image ID 與啟動時間 `2026-11-14T11:10:05.414454701Z` 全程未變。沒有真實 QQ 驗收投遞。

`/opt/qgroup/release-manifest.json` 記錄實際版本、schema 及兩服務各自檔案摘要；`/opt/qgroup-backups/user-metadata-0d8dfbc/active-compose.json` 使用固定 image ID。`rollback-compose.json` 保存原版本組合，只有在停止候選 web 並確認 metadata 為空時可套用，其他情況須向前修復。Compose 仍共用 `QGROUP_TAG`，後續整組啟動、重建或恢復主機前須重新核對版本，沒有自動獨立鎖版保障。

本發布紀錄的後續文件提交範圍為 `none`，不重新建置或重啟；正式 web 來源維持 `0d8dfbca3928e2c5f4926ca75f4f5a78213169f4`。
