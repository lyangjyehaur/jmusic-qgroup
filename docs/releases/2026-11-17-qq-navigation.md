# QQ 登入跳轉緊急修復

2026-11-17 17:22:05（Asia/Taipei）完成 server2 發布。發布範圍：`web`，只更新看板 web；bot 與獨立 music 保留原容器、映像及啟動時間。

## 問題與修正

看板 TSX 確認框在 QQ 授權請求成功、執行 `location.assign()` 後自動關閉，關窗觸發的 `history.go()` 打斷尚未完成的導航，導致確認後回到帳號視窗。線上 `/api/auth/qq/start` 回傳 200，仍無法進入官方登入頁。

QQ 登入與綁定改為在導航時保留確認層，不執行關窗歷史回退；其他確認框維持原關閉行為。授權啟動錯誤直接顯示於確認框，可原地重試。沒有新增文案、schema、outbox、後端、QQ 設定或 bot 入口契約變更；簡繁前端產物已重新生成。

## 正式版本

| 服務 | 來源 commit | 實際 image ID |
| --- | --- | --- |
| 更新前 web | `be51e065bd0d64a2df3a783ca14672d92ba6d49a` | `sha256:7a9ded728d988d05399a3518faae52d19eeb556d7b964928806894a16ebb4ef5` |
| 更新後 web | `83eb54ce94f935a4048aaf63a410206723f09bd8` | `sha256:e26f55f0aa1c0a9d7d237d71fcf271bb52456a5f2a548f4679f3f5bd701920e9` |
| 保留 music | `be51e065bd0d64a2df3a783ca14672d92ba6d49a` | `sha256:2f066c1b478a4240b38fa45ee6a31337e9fc100fc8ca0400c9f7994718c66d0f` |
| 保留 bot | `07defc429d619a7558ab7218372886f531813ae3` | `sha256:e9d93c4441e2a34989722d7a5a86f87c8fa99cbc638b37cfe75a712fe6aa6720` |

修正先整合並推送 main，git.dan.tw 與 GitHub 的 main SHA 均核對為完整修正提交。通過 `python3 deploy/check_release_source.py --commit 83eb54ce94f935a4048aaf63a410206723f09bd8`，僅封存此 SHA，在本機新的乾淨暫存目錄依正式 Dockerfile 建置 linux/amd64 映像一次；映像包含完整 revision label，驗證及傳輸使用同一實際 image ID。

映像標籤 `qgroup:20261117-qq-navigation-83eb54c`；來源封存 SHA-256 `51929e520fb7069b0b0471f1a7346289571bd8de1780973e51c3cc33302d3d1e`。正式來源目錄 `/opt/qgroup-releases/qq-navigation-20261117`，保全及驗證目錄 `/opt/qgroup-backups/qq-navigation-20261117`。

## 驗證

- 新增實際 React／API 瀏覽器回歸：簡繁匿名登入、已登入帳號綁定、取消不發送請求，以及 503 失敗後重試。QQ 官方頁由延遲回應模擬，確實涵蓋待完成導航被歷史回退取消的情形；暫時恢復舊關窗行為時測試失敗，套用修正後通過。
- `npm run test:ui`（含原有業務流程及上述新測試）、`npm run check:ui`、strict 型別檢查、`git diff --check`、742 項 Python 測試及 client／QQ refresh／music link 三組 JavaScript 測試通過。
- 確切新 web 映像的 17 項 QQ OAuth 測試通過；253 個映像檔案雜湊符合核准來源，正式運行容器再次核對通過。外網簡繁 board 模組雜湊均符合已提交產物。
- 正式備份隔離副本通過重複遷移、圖片、完整性及外鍵驗證。新 web 與保留 bot 的實際映像各自讀取 12 場活動及包房，60 張資料表逐值不變，schema 維持 20。映像驗證在本機以隔離資料、無外部網路、非 root、唯讀檔案系統及記憶體／CPU／PID／時間限額執行。
- 與原正式 web 提交比較，後端、共用核心、bot、music 及部署設定均無差異，原有混合版本契約保持相容。取得部署鎖及最新備份後，只重建 web；三服務均 healthy，web 與 music 公開健康端點正常。
- 線上匿名瀏覽器實際點擊 QQ 登入、勾選隱私並確認，成功抵達 `graph.qq.com` 的「QQ 帳號安全登入」及本站授權說明頁，沒有再退回帳號視窗。驗證止於官方登入頁，未代替會員輸入 QQ 憑證、完成授權或建立正式帳號。

## 保全及回退

切換前最新看板備份為 `/var/backups/qgroup/kanban-20261117-092156-228544.sqlite3`，配對 images 封存一併保留。保全目錄保存舊應用、manifest、來源封存、實際服務版本及驗證結果。正式 `/opt/qgroup/release-manifest.json` 已更新。

bot 容器 `85d4c7c6f4cb6d99ac99674501236b41eb96f138a8287bc2e5fd088558daacf1`，啟動時間 `2026-11-14T11:10:05.414454701Z`；music 容器 `5d09c53bdf48f3879b5726bdeadbcf38e981e7226df0b9a7e128b2e8ce627279`，啟動時間 `2026-11-16T15:35:01.534719898Z`，均與切換前一致。

整組維運須以 `/opt/qgroup/compose.yaml` 加保全目錄的 `active-compose.json` 固定 web／bot 映像，music 維持其獨立鎖定。共用 QGROUP_TAG 的自動獨立版本鎖定仍未實作。回退候選為原 web `7a9ded72…` 搭配表中原 bot／music，使用 `rollback-compose.json` 只重建 web，保留目前資料與發布後新寫入；資料相容，但回退會重新帶入此次 QQ 跳轉故障，因此優先向前修復。

本發布紀錄為後續 `none` 文件提交，不重新建置或重啟服務。
