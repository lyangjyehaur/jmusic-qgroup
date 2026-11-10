# QQ 圖片僅用於未登入入口

2026-11-10 部署。未登入首頁及登入視窗保留 QQ 登入圖片；已登入首頁改為站內樣式的「帳號與設備」按鈕，個人資料移除重複的 QQ 圖片入口，未綁定帳號的「綁定 QQ」改用一般文字按鈕。QQ 頭像及 OAuth 流程保留。已登入時帳號入口不依賴 QQ 供應者是否可用。

- 程式提交：`90e0ea827e15658ee4075546e1f994e6aa044ab6`；app、identity 版本 `20261110-qqbutton1`，繁簡版同步。
- JavaScript 10 組、語法及 diff 檢查通過。本機瀏覽器確認已登入且綁定 QQ、已登入未綁定 QQ、未登入三種狀態；已登入頁面與帳號視窗沒有 QQ 登入圖片，未登入首頁及登入視窗仍顯示圖片，帳號入口可開啟。
- 正式 HTTPS 首頁、app、identity 繁簡版逐位元組一致；健康接口 200，匿名管理接口 401。
- 無資料結構變更。正式配對備份副本連續初始化兩次，50 個表、179 筆資料與圖片保留檢查通過。
- 映像：`qgroup:20261110-qqbutton1-90e0ea8`；配對備份 `/var/backups/qgroup/kanban-20261110-131524-242119.sqlite3` 及同名 `.images.tar.gz`。
- 回退：`/opt/qgroup-backups/qqbutton-90e0ea8`，保留舊來源、環境、manifest 與驗證報告；舊映像 `qgroup:20261110-profile1-88071e5`，回退不覆蓋正式資料庫。
- 新來源 `/opt/qgroup.qqbutton-staging-90e0ea8`。來源檔案、服務健康、bot 心跳與 dry_run、資料完整性及權限保留檢查記錄於回退目錄的 `report.json`。
