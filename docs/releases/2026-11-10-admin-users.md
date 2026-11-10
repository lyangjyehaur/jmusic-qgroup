# 用戶管理與帳號管理員上線

2026-11-10 部署至 server2，網站 <https://kanban.danndann.cn/admin>。

## 行為

- 後台新增用戶列表、搜尋及每頁 20 筆分頁，顯示站內帳號 ID、稱呼、第三方綁定暱稱與註冊時間。
- 後台可授予或撤銷管理員。被授權的帳號登入後可直接訪問 `/admin`，不需再輸入管理憑證；獨立管理憑證保留作首次授權及恢復入口。
- 每次請求檢查當前帳號及權限。CSRF 綁定 session、帳號及授權版本；切換帳號、撤銷及重新授權後，舊頁面的寫入失效。
- 禁止帳號方式撤銷自身權限；須由其他管理員或獨立憑證操作。角色變更與追加式審計同事務提交，註銷帳號撤銷角色並從列表隱藏。
- 帳號方式退出後台會同時登出當前瀏覽器帳號；其他裝置保留。

## 驗證

- 本機 Python 369 項、JavaScript 9 組通過；桌面與 390px 手機版的搜尋、授予及撤銷流程已驗證，無水平溢出。
- server2 新映像在無正式環境變數、無網路、非 root、唯讀根檔案系統的隔離容器內重跑 Python 369 項，全數通過。
- 正式備份的隔離副本連續遷移兩次：48 個原有表、175 筆原有資料逐值保留；圖片雜湊、完整性、外鍵及遷移可重複性通過。
- 正式庫為 schema 14，8 個帳號、8 筆第三方身份、1 筆 UnionID 保留；完整性 `ok`、外鍵錯誤 0。新角色及角色歷史表為空，部署未自動授權任何帳號。
- 外網 `/api/health` 正常；繁簡兩版 `/admin`、`/admin.js` 均回 200 且內容與提交檔案一致；未登入的 `/api/admin/session`、`/api/admin/users` 均回 401。
- web、bot 使用同一新映像，皆 healthy、重啟次數 0。web 無啟動例外，bot 心跳 ACK 與健康檔持續更新。
- 後台機器人政策仍為 revision 0，生效 `dry_run=true`；備份 timer 保持 active。

## 部署與回退

- 程式提交：`139e8fee6f78926a9c30884baaa295948194d0b9`，已推送 `origin/main`。
- 映像：`qgroup:20261110-adminusers1-139e8fe`；映像 ID `sha256:1b06dd036094393dd0725b7bba87589bfda1024ca168bd812623a0fca4dc27ca`。
- 程式封存 SHA256：`7308d36282f04360650ce9e7ab08424eb2b180d77d682d8fc816068f0a138471`；`/opt/qgroup/release-manifest.json` 記錄 200 個部署檔案雜湊，部署前後均核對通過。
- 配對備份：`/var/backups/qgroup/kanban-20261110-122427-679198.sqlite3` 與同名 `.images.tar.gz`。
- 回退目錄：`/opt/qgroup-backups/admin-users-139e8fe`，含 `compose.env`、`old-source.tar.gz`、`old-release-manifest.json`、遷移演練輸出、容器測試輸出、正式庫檢查及 `report.json`。
- 新程式來源保留於 `/opt/qgroup.adminusers-staging-139e8fe`；隔離演練用資料副本已移除。
- 切換順序：備份、建置及隔離測試通過後，更新程式與 `QGROUP_TAG`，先重建 web 完成遷移且 healthy，再重建 bot。
- 回退可還原上述 `compose.env` 與舊來源，再以 Compose 重建 web 與 bot，回到 `qgroup:20261110-botalign1-75dd5e8`。schema 14 只新增表，程式回退不需還原或降版正式資料庫。

首次使用請以既有管理憑證進入後台，在「用戶管理」核對並指定所需帳號。此次部署未替任何正式帳號設定管理員。
