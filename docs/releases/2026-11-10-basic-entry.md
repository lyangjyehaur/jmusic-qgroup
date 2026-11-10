# 一般報名連結預設收起高級選項

2026-11-10 23:05:07（Asia/Taipei）完成正式切換。發布範圍：`web`。

## 行為與範圍

`routeBotEntry` 原本在分流前一律展開高級選項，導致群內「本人報名」連結也顯示所有進階管理工具。現在只對 `party`、`tentative`、`invite`、`withdraw`、`management`、`manage`、`attendance`、`onsite` 這些進階入口展開；`join`、一般詳情、安排確認、結算查看、款項、複製等入口保持活動詳情預設收起。

本人報名連結仍聚焦報名按鈕，須由使用者核對後提交，不會自動報名或占位。登入要求、活動權限、URL 參數、API 與提交流程不變；同行／補報／管理等目的操作仍能打開。更新 app 快取版本，重建簡繁產物及手冊。

## 實際版本組合

| 階段 | 服務 | 來源 commit | 映像引用 | 實際 image ID |
| --- | --- | --- | --- | --- |
| 發布前 | web、bot | `017e2329e70e8a7c3786e7c3d8c832abaccbcc6d` | `qgroup:20261110-activity1-017e232` | `sha256:7e41b1b509235056e9c52f20ff5db1cc422d9318a53ea6499dae7066b6e22707` |
| 發布後 | web | `c19ede40b7a796e82d02f8c81695d4c05556d2c6` | `qgroup:20261110-entry1-c19ede4` | `sha256:50d8b7d1284d29d53987d776d865244f9efa29ba4373d0d7b7a15ddc943130b4` |
| 發布後 | bot（未重啟） | `017e2329e70e8a7c3786e7c3d8c832abaccbcc6d` | `qgroup:20261110-activity1-017e232` | `sha256:7e41b1b509235056e9c52f20ff5db1cc422d9318a53ea6499dae7066b6e22707` |

來源壓縮檔 SHA-256：`4f46f34e3e4f3bf07d824ce95bc8cd881587fe6bb4bc45777251837a0f4e1791`，216 個追蹤檔案與正式來源 manifest 相符。映像以明確提交建置一次，具 revision 及版本標籤；正式 manifest 另外記錄每個服務的實際版本組合。

## 相容性與驗證

- `server.py`、共用核心／schema／語言 catalog、bot、部署設定共 49 個檔案與正式 bot 來源逐位元相同。只有前端展開邏輯、快取、手冊及回歸測試變更，因此可限於 `web`。
- 隔離新 web 映像透過 HTTP 建立並讀取測試活動，再由正式正在運行的原 bot image ID，在另一個無網路容器以唯讀資料庫查詢同一活動並生成既有 `action=join` URL。確認零自動報名、零新增通知、bot 零資料庫寫入；未掛正式資料或注入正式憑證，未呼叫真實 QQ 發送 API。
- 全部 11 組 JavaScript 測試通過。新增回歸測試直接執行原文、簡體、繁體的實際入口函式，涵蓋一般／進階入口、登入、拒絕權限、聚焦報名按鈕及不自動提交。
- 相關 Python 測試 53 項在本地及新正式映像內通過，包含 bot 指令、群組與多語系；正式映像測試無網路、無正式資料掛載、使用 UID:GID `994:992`。此小幅前端修正未重跑無關的完整 404 項測試。
- Chrome 簡繁手機實測：`join`／`detail` 收起、報名按鈕可見並聚焦、手動開關仍可操作、同行／管理入口可達、複製表單收起、未登入／無權限保護保持、活動 revision／人數／安排版本不變。
- 正式備份副本以服務 UID 完成兩次初始化及所有原值／圖片保留驗證；正式 schema 維持 15。切換前後完整活動資料、管理員數及 bot 設定摘要相同。
- web 為預期新映像，bot 保持原映像、原 container ID 及原啟動時間；兩者 `healthy`、restart count 0，原 bot 的心跳及 poll 仍新鮮，實際發送模式未改動。
- 外網簡繁首頁、app／activity／roster／admin 腳本、管理頁、手冊及共用 CSS 共 15 項資源均 200，摘要與來源相符；`/api/health` 200。

## 備份、單邊限制與回退

- 演練配對備份：`/var/backups/qgroup/kanban-20261110-150025-999311.sqlite3` 及同名 `.images.tar.gz`。
- 切換前配對備份：`/var/backups/qgroup/kanban-20261110-150500-163483.sqlite3` 及同名 `.images.tar.gz`。
- 回退保存目錄：`/opt/qgroup-backups/entry-c19ede4`，保留原來源／Compose 環境／manifest、基線、測試、混合版本驗證、演練、切換及外網紀錄。
- 當前 `.env` 共用 `QGROUP_TAG` 指向新 web 映像，原 bot 容器繼續使用舊映像。本次為人工核對的單邊更新，不代表已有獨立版本鎖定；後續整組 `up`、重建或主機恢復前，須先按上述 manifest 核對兩邊預期版本，不因標籤一致而重啟 bot。
- 直接回退目標為 web 恢復 `qgroup:20261110-activity1-017e232`，bot 保持原容器。取得部署鎖、核對沒有後續發布後，恢復對應來源、manifest 與原 `QGROUP_TAG`，校驗 Compose 並只執行 web 更新，最後核對兩個實際 image ID 及健康。schema／契約不變，保留現有資料，不還原舊資料庫，不重啟 bot。

本文件為發布後紀錄，文件變更範圍 `none`，不需再建置映像。
