# 活動時間投票與 QQ 通知發布

2026-11-13 15:49（Asia/Taipei）完成 server2 切換，15:50 完成運行與外網驗證。發布範圍：`both`。新增時間投票、共用 schema 16–17 與投票 outbox 工作，web／bot 成套切換。

## 行為

- 發起者提供 2–6 個候選時段，群友逐項選擇可以／可能／不行，提交後可改票。發起者核對票數後定案，建立正式活動；投票不占報名名額，其他人仍需自行報名。
- 新投票預設開啟 QQ 群通知，群消息列出全部候選時段、地點、截止與投票連結；逐次投票不廣播。定案沿用同步設定並發出正常活動通知。發起者可查看投遞狀態及重送失敗／模擬消息。
- 新建公開活動「發布到 QQ 群」預設勾選；編輯既有活動及還原本機草稿保留原設定，邀請活動仍不允許群同步。
- bot 忽略包含 @全員 的消息，只有明確 @ 到 bot 才回應一般群消息；保留既有「待確認結束」近期活動篩選。

## 來源與版本

正式來源 `472db939b4a806e39de4a9aff6e9a56929a8c2f3` 已整合並推送遠端 main。在乾淨工作目錄執行完整 SHA 的 `deploy/check_release_source.py` 通過後，僅封存此提交。Archive SHA-256：`ec7fddc7d8c210309efa520b7ad410cca5e9fabd47075e3f3179787bdefdcaa8`，249 個來源檔摘要符合封存。

| 階段 | 服務 | 完整來源 commit | 映像引用 | 實際 image ID |
| --- | --- | --- | --- | --- |
| 切換前 | web、bot | `f3731477a73fe33ec1ce85c929a5fa2a802628e3` | `qgroup:20261113-overdue1-f373147` | `sha256:bb3e3ed6dce88490e984e7cc5f64a275441ef1c8109d9cb93ccc49f8c47f1d6a` |
| 切換後 | web、bot | `472db939b4a806e39de4a9aff6e9a56929a8c2f3` | `qgroup:20261113-polls1-472db93` | `sha256:a78e6fd567954ac81fe4726baa25becc277c927037e485470e23a135fdcb1047` |

乾淨建置目錄 `/opt/qgroup-releases/polls-472db93`，共用映像只建置一次，帶完整來源與版本 label。正式 `/opt/qgroup/release-manifest.json` 記錄實際兩服務版本。

## 驗證與資料契約

- 本機完整 Python 547 項通過，前端 Node 13 組通過；手冊與簡繁產物重建。隔離本機 UI 已驗證建立、投票／改票、定案、分享連結、歷史導覽與手機尺寸。
- 正式映像無網路、無正式憑證、唯讀根目錄、UID:GID 994:992 下，bot 開關 0／1 各 547 項通過（各 skipped=8）。
- 正式配對備份的隔離副本完成 schema 15 → 17 及重複初始化，檢查原表各欄位值、圖片摘要、完整性與外鍵。舊映像在遷移後但尚無新投票／設定的副本上初始化與查詢通過，原資料未變。
- Schema 16 增加投票資料表；17 增加同步設定並重建 outbox，新增 nullable event_id／poll_id 互斥來源，保留既有 ID、claim fence、狀態、不可改寫 payload 與自增序號。新通知類型為 `time_poll_published`。
- 新 web／舊 bot 不作為運行組合：舊 worker 不會投遞新投票工作，舊設定驗證不接受新版通知類型。停止 bot 後停止 web，以非 root 新映像遷移，核對原有表各欄位摘要不變，再依序啟動 web、bot。

## 正式驗收與設定

- 切換時 schema 15 → 17，原有表每欄資料摘要一致。兩服務均 healthy、restart 0，實際映像與完整來源符合預期，各自 99 個運行檔摘要符合封存來源。
- Bot 出現本次啟動後的新 READY／ACK／poll，reconnect 0，啟動錯誤數 0。
- 保留其餘 bot 政策，使用新版 `bot_settings.save` 只加入 `time_poll_published`；revision 5 → 6，worker applied_revision 6，主動通知已啟用、有效 dry_run=false。未替歷史資料新增通知工作。
- 外網簡繁首頁、app.js、手冊、i18n.js、time-polls.js、client.js 共 12 項均 200 且摘要符合來源；style.css 摘要及 `/api/health` 正常。既有超時活動仍不列入 bot 近期選單，純文字／Markdown 組裝通過。
- 沒有向正式 QQ 群發送驗收消息，也沒有在正式資料建立測試投票或選票；真實投票通知畫面待使用者試用，不能將模擬投遞當作正式送達證明。
- 演練配對備份 `/var/backups/qgroup/kanban-20261113-074709-442276.sqlite3`；切換前配對備份 `/var/backups/qgroup/kanban-20261113-074909-011220.sqlite3`，各有同名 `.images.tar.gz`。
- `/opt/qgroup-backups/polls-472db93` 保存原來源、環境、manifest、映像建置／兩輪測試／演練／舊映像相容性日誌、原資料摘要、設定變更前快照及啟用摘要、prepared／report／runtime-report。舊映像保留。

## 回退限制

舊映像、來源、Compose 環境及 manifest 保存在 `/opt/qgroup-backups/polls-472db93`，目錄 0700。切換前的舊映像相容性只驗證於尚未接受新投票寫入且未啟用新通知設定的 schema 17；不能延伸成發布後任意回退保證。

若已產生新投票或啟用新通知類型，優先向前修復。需要回退時先取得部署鎖、停止兩服務，另存目前資料與圖片，使用新版設定 API 移除 `time_poll_published` 及其模板並保留其他設定，核對及處理未送投票工作，使用當時實際資料副本重新驗證舊版；不允許未驗證的新舊組合。舊版不提供投票介面及通知，保留投票資料供後續恢復。**不得以發布前備份覆蓋已有新寫入的正式資料庫。**

本紀錄後續提交範圍為 `none`，不重建或重啟；正式運行來源維持上述程式 SHA。
