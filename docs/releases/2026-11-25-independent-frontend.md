# 啟用前端獨立發布

2026-11-25 19:21（Asia/Taipei）正式啟用。發布範圍：`web`（首次更新 API 靜態服務支援及啟用獨立 frontend）；bot 未重啟。後續純 UI 更新只建置並切換前端檔案包，不建置映像、不重啟 API／bot。

## 實際版本

| 產物／階段 | 來源 commit | 實際映像或 manifest 摘要 |
| --- | --- | --- |
| 更新前 web／整體回退目標 | `caa41409c7cb324ddda8637da35bc06ae56352a6` | `sha256:f35de635af060de206be25167f83ec7ff026279e7b93ffca4a7032cb0f4d9493` |
| 更新後 API 映像 | `b65e93b05eb8558f8c15d60eb15b2d0cc6cce4cc` | `sha256:c81f4ce7c90224314e0b6e1e9faeec370dd04a083a1306f690cf1985401bcf27` |
| 獨立 frontend 與發布工具 | `459dade75de124453621ae3829067d024f304505` | manifest SHA256 `643d6a21bf8bc131da923c515d0f4f811101f674e0325d9001672c50b99fcc0d` |
| bot，前後不變 | `54107b8a3c07444b1a3bd31188824bcfadaad4a8` | `sha256:2a7f4e9d9a9e1ed6cef6edc011ff366f0310f04509121c318d0abe891564c137` |

前端 PWA build ID 為 `58a19bcded4af2b435a97628a2572ca91147b672f236f83ac25467c3a0193cef`。這次沒有改變前端畫面內容，因此與上一版的內容 build ID 相同；來源提交與 manifest 另行記錄，不把 API SHA 當成前端 SHA。

來源先合入 main，雙推 git.dan.tw／GitHub 並核對遠端 SHA。API 來源與工具／前端來源分別通過完整 SHA 的 `check_release_source.py`，只使用各自乾淨 archive 建置。API 映像僅建置一次，同一實際 image ID 驗證、傳輸、載入與運行。前端來源的後端輸入指紋與 API 提交相同，前端只執行獨立建置，沒有重新編譯 API／bot 或建置 Docker。

## 發布與驗證

- 前端父目錄唯讀掛載至 API。HTTP 仍由既有 API 提供，沿用原網址、1Panel 上游、安全標頭與簡繁規則。首頁與新檔名資源不再固定於程序啟動時；完整版本先安裝，再原子切換 `current`，保留所有舊 hash 資源供已開啟頁面使用。
- 64 項相關單元／整合、4 項 Python 來源／權限／封裝測試、12 項 PWA／precache 瀏覽器回歸、型別、完整建置及編譯產物 smoke 通過。不同前端版本在同一 API 內切換／回退、錯誤版本拒絕、損壞產物保留舊指標、304／HEAD／壓縮、快取、深連結、限流及權限均在隔離環境驗證。
- 實際候選映像通過 release 來源、原生模組、刪除權威鎖／唯讀檢查點及正常停止驗證。使用相同候選映像搭配實際獨立前端包、隔離資料庫，另完成 268 次靜態 HTTP 檢查與完整 worker precache 核對。9 份 bot 編譯產物與保留 bot 映像摘要逐一相同；schema、outbox、共用業務規則及 bot 深連結契約不變。沒有試發真實 QQ 消息。
- 首次只重建 web 容器。正式 API 和 `/frontend-version.json` 分別回報表中來源；網站與 bot 均 healthy、restart count 0。bot 容器 ID、映像與啟動時間全程不變。
- 在正式 API 上重新執行同一版本的前端 `activate`，核對 web 與 bot 的容器 ID、映像、啟動時間及 restart count 均不變；僅更新 runtime manifest 的 frontend 紀錄。不同版本切換與回退的驗收在隔離環境進行。
- 公開 API 近期 3 場、往期 12 場，近期沒有已過預定時間的活動。獨立瀏覽器分頁確認正式活動頁正常載入，沒有操作使用者既有分頁或草稿。

首次傳輸包因 macOS 封裝附加的 `._*` 檔案，在切換前被完整性檢查拒絕；當時原網站／bot 容器均未變。改以 Python tarfile 封裝、在本機解包並逐檔驗證，再核對傳輸摘要後成功啟用。建置工具後續已內建相同的跨平台封裝及封裝摘要輸出，相關工具／文件提交範圍為 `none`，不再更新運行映像或前端內容。

## 資料與維運

無 schema 遷移、重匯或業務資料改寫。繼續使用 `/var/lib/qgroup-unified/data/kanban.sqlite3`、`/var/lib/qgroup-erasure` 及 `/var/lib/qgroup-checkpoint`，不回退資料庫或刪除權威。發布前後 `qgroup-backup.service` Result=success，timer 為 active；業務備份輸出仍為 `/var/backups/qgroup-unified`。

發布目錄 `/opt/qgroup-releases/frontend-bootstrap-20261125-b65e93b` 保存 API 與工具兩份核准來源 archive、映像、前端原始封裝／摘要、驗證及實際 manifest；目前 manifest 為 `/opt/qgroup/release-manifest.json`。首次失敗包的解包目錄及日誌另保留供核對。

運行使用上述發布目錄的 `source/deploy/unified-compose.yaml` 加上 `source/deploy/frontend-compose.yaml`；沿用 `/opt/qgroup-releases/unified-20261125-54107b8/runtime.env`，其中固定 web／bot 映像並新增 `QGROUP_FRONTEND_DIR=/opt/qgroup-frontend`。未修改私有服務環境檔、反向代理或 TLS。

`/opt/qgroup-frontend/current` 指向 `releases/459dade75de124453621ae3829067d024f304505-643d6a21bf8bc131`；`assets/` 保留各版本的 immutable 資源，不自動清理。前端產物與其原始封裝可恢復此目錄，不將它與業務庫／權威目錄混放。

後續純前端更新及回退使用[前端獨立發布流程](../frontend-release.md)。前端回退只切換已驗證、與目前 API 相容的保留 release；首次啟用後如需退回原整體網站，恢復表中原 web image ID，移除 frontend override 並只重建 web。舊網站仍相容目前未變的 schema／資料；保留 bot 及所有發布後寫入，不還原舊資料快照。
