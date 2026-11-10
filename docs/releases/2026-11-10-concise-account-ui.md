# 帳號介面文案精簡

2026-11-10 已部署至 <https://kanban.danndann.cn/>。

- QQ 重新登入提醒縮為 bot 無法識別帳號的原因、網站仍可使用，以及「重新登入 QQ」「稍後處理」兩個按鈕。移除 UnionID 術語、重複說明和大面積留白，桌面及手機均使用置中小視窗。
- 帳號頁精簡 QQ 狀態；已綁定 QQ 的設備連結改稱「備用：連接另一台設備」。保留連結授權影響、隱私同意及註銷警示。
- 後台精簡用戶管理、登入方式和 UnionID 補齊說明。繁簡版同步更新，相關資源版本為 `20261110-copy1`。
- 本次僅調整文案、呈現及對應既有測試斷言，沒有修改授權、提醒間隔或資料庫結構。

## 驗證

- JavaScript 10 組通過，語法及 diff 檢查通過；最後文案調整後再跑 QQ 引導與繁簡語系檢查。
- 本機瀏覽器確認稍後處理、重新載入不重複提醒、手動開啟提醒，以及 390px 手機版無橫向溢出。預覽截圖位於忽略的 `artifacts/copy-ui/reminder-mobile.png`。
- 正式備份副本連續初始化兩次，50 個表、179 筆資料及圖片保留檢查通過。正式庫 schema 14、完整性正常、外鍵錯誤 0、管理員角色 1，bot 政策未變。
- HTTPS 首頁、後台及 identity/app/admin 腳本繁簡版和 CSS 與發佈來源逐位元組一致；健康接口 200，未登入管理接口 401。
- web、bot 同一映像、healthy、重啟次數 0；web 無啟動例外，bot 首次心跳 ACK 與輪詢正常，dry_run 維持 true，備份 timer active。

## 部署與回退

- 提交：`ff31325d99a51cfc1a7f9d84b8c880037fd4dea9`，已推送 `origin/main`。
- 映像：`qgroup:20261110-copy1-ff31325`，ID `sha256:b39d39a6fe224bad39ebe0264cb2c608314c109c23243cef6897d2b7dc6a533f`。
- 來源封存 SHA256：`a528bff2065db101d26067ffdfcd7e3a4d307915b73182972b9966e4afa3ee6e`，manifest 記錄 203 個檔案；發佈前後核對通過。
- 配對備份：`/var/backups/qgroup/kanban-20261110-130116-465172.sqlite3` 及同名 `.images.tar.gz`。
- 回退：`/opt/qgroup-backups/copy-ff31325` 保留舊來源、環境、manifest、檢查與部署報告。還原舊來源及環境，使用 `qgroup:20261110-unionprompt1-d371f09` 重建 web、bot；不覆蓋正式資料庫。
- 新來源：`/opt/qgroup.copy-staging-ff31325`。部署先更新 web，健康後再更新 bot；隔離演練資料副本及臨時上傳檔案已清理。
