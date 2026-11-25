# 活動按預定結束時間歸入往期

2026-11-25 已正式發布。發布範圍：`web`；只更新網站活動分類與顯示，bot 保持原容器運行。本文與 README 的後續文件提交範圍為 `none`，不重新建置或部署。

## 來源與實際版本

來源提交先整合至 main，推送 git.dan.tw 與 GitHub 並核對相同 SHA，通過 `python3 deploy/check_release_source.py --commit caa41409c7cb324ddda8637da35bc06ae56352a6`。僅封存該提交，在乾淨暫存目錄建置 linux/amd64 映像；驗證、傳輸、載入和運行使用同一映像，並核對傳輸摘要與 image ID。

| 服務／階段 | 來源 commit | 實際 image ID |
| --- | --- | --- |
| web 更新前／回退目標 | `54107b8a3c07444b1a3bd31188824bcfadaad4a8` | `sha256:2a7f4e9d9a9e1ed6cef6edc011ff366f0310f04509121c318d0abe891564c137` |
| web 更新後 | `caa41409c7cb324ddda8637da35bc06ae56352a6` | `sha256:f35de635af060de206be25167f83ec7ff026279e7b93ffca4a7032cb0f4d9493` |
| bot 更新前後，未重啟 | `54107b8a3c07444b1a3bd31188824bcfadaad4a8` | `sha256:2a7f4e9d9a9e1ed6cef6edc011ff366f0310f04509121c318d0abe891564c137` |

## 行為與資料相容性

活動到達「開始時間＋持續時間」後，無須手動結束、結算或歸檔，直接歸入往期。搜尋、狀態篩選、分頁、近期摘要與個人首頁採相同判斷；過期但未確認實際結束者顯示「已過預定時間」。延長活動至未來且尚未結束／取消／歸檔，可回到近期。列表與個人首頁每 30 秒重新讀取。

沒有 schema 遷移、資料重匯或業務資料改寫；lifecycle、實際結束時間、結算／金流／名冊、outbox、共用設定與 bot 網址契約不變。沿用正式庫 `/var/lib/qgroup-unified/data/kanban.sqlite3`，刪除權威 `/var/lib/qgroup-erasure` 與固定檢查點 `/var/lib/qgroup-checkpoint`。現行新 web 與保留 bot 可並行，沒有啟動第二個投遞者。

## 驗證與正式結果

- 31 項 API／領域／生命週期測試、15 項瀏覽器整合／生命週期回歸、型別檢查、建置、編譯產物 API／bot smoke 與 diff 檢查通過。案例範圍見[實作紀錄](../unified-rebuild/258-activity-history-by-end-time.md)。
- 實際候選映像以 release 目的驗證通過。候選映像與保留 bot 映像的 9 份 bot 編譯產物逐一摘要相同；schema、outbox 及共用業務規則未變，並完成隔離產物 smoke。沒有人工試發真實 QQ 消息。
- 正式資料副本唯讀驗證及發布後公開 API 均得到近期 3 場、往期 12 場；其中 8 場已過預定時間、未手動結束的活動由近期轉入往期，近期由 11 場降至 3 場。兩類 ID 無交集，近期摘要一致，近期無過期活動。
- 正式 `/api/v2/version` 回報核准的完整 SHA 與 `origin-main`。瀏覽器確認近期 3 場，切至「往期與歸檔」可見過期活動及「已過預定時間」狀態。
- web healthy、restart count 0；bot 容器 ID、image ID、啟動時間與 restart count 保持不變，健康檢查正常。
- 發布前後 `qgroup-backup.service` 成功，備份 timer 為 active，輸出至 `/var/backups/qgroup-unified`。既有新版備份適配器改為從目前 manifest 讀取兩服務版本，備份與檢查點流程不變。

## 維運與回退

本次發布目錄為 `/opt/qgroup-releases/activity-history-20261125-caa4140`，其中保存核准來源、實際 manifest 與映像證據；目前 manifest 同步保存於 `/opt/qgroup/release-manifest.json`。目前 Compose 為該目錄的 `source/deploy/unified-compose.yaml`；沿用 `/opt/qgroup-releases/unified-20261125-54107b8/runtime.env`，只更新 `QGROUP_WEB_IMAGE`，保留 bot、資料與私有環境檔引用。README 原路徑的相同 Compose 配合此環境檔仍可查詢目前服務。

本次僅更改讀取分類與介面，更新前網站可讀取相同 schema 與目前資料。必要時將 `QGROUP_WEB_IMAGE` 改回表中已保存的回退 image ID，使用上述 Compose 僅重建 web，核對 web 版本、兩服務健康及 bot 容器不變，並同步更新 manifest。回退會恢復原先的活動分類；不得覆蓋成發布前資料庫，必須保留發布後寫入、刪除權威及 bot 工作狀態。
