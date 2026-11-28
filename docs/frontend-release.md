# 前端獨立發布

發布範圍為 `web`，並進一步記錄 `frontend` 或 `api`。純 UI 更新建置靜態檔案包，切換前端目錄，不建置 Docker 映像、不重啟 API 或 bot。API 仍提供同源靜態 HTTP 回應、安全標頭與語言選擇；前端發布產物和 API 映像獨立。沿用 1Panel 與 8791 上游，不需要修改 OpenResty 設定。

## 首次啟用

先將支援獨立前端的 API 提交整合並雙推 main，依[發布規則](deployment-policy.md)檢查明確 SHA、乾淨封存、建置及驗證候選映像。先建立相容的前端產物，以 `activate` 安裝到獨立目錄，再用 `deploy/unified-compose.yaml` 加上 `deploy/frontend-compose.yaml` 更新 web 一次。環境檔須有 `QGROUP_FRONTEND_DIR=/opt/qgroup-frontend`；該目錄不能位於資料庫、刪除權威或檢查點目錄之內。

Compose 唯讀掛載整個前端父目錄，不直接掛載 `current`。後者會被 Docker 固定到當時的 symlink 目標，導致更新後仍讀舊版本。bot 的映像、設定、容器及啟動時間須保持不變。

## 後續純前端更新

1. 從最新 main 建立 `codex/*` 分支、修改前端，完成相關測試，合入 main 並雙推、核對遠端 SHA。
2. 讀取正式 `/api/v2/version`，取得實際 API 的完整 commit。以下的兩個 SHA 都使用明確值；前端提交可以與 API 不同。
3. 在乾淨本機 checkout 建置：

```sh
python3 deploy/frontend_release.py build \
  --commit FULL_FRONTEND_COMMIT_SHA \
  --api-commit FULL_RUNNING_API_COMMIT_SHA \
  --output /tmp/qgroup-frontend-RELEASE
```

工具執行 `check_release_source.py`，只從核准 SHA 的 archive 在乾淨暫存目錄 `npm ci` 與 `npm run build:frontend`；不執行 API／bot 編譯或 Docker。另以 Python tarfile 產生同名 `.tar.gz`，省略 macOS resource fork／xattr，避免運送後多出 `._*` 檔案。終行輸出產物目錄、封裝檔案、`archiveSha256` 及 `manifestSha256`。來源／樹、API 版本、PWA build ID 與每個檔案摘要保存在 `frontend-release.json`。

工具比較來源與實際 API 提交的後端輸入指紋，涵蓋 API、bot、共用 packages、套件與 lockfile、TypeScript 設定、API 建置器及映像定義。任何差異先停止，需部署並驗證 API 或獨立審查相容性，不能只填一個假的 API SHA。這是保守的發布限制，沒有宣稱完整語意相容性自動證明。

指紋排除建置器禁止進入運行 bundle 的 `.test.ts`，讓單純修正測試不要求重啟 API；其他 testsupport 檔案、運行來源與建置規則仍在比較範圍。前端仍須搭配實際 API 映像驗收；測試檔排除不是完整相容性證明。

4. 用隔離 API／資料驗證該前端產物及相關頁面、深連結與 PWA；將完整檔案包傳到伺服器的新暫存目錄，核對傳輸及 manifest 摘要。不要逐檔覆蓋現行目錄。
5. 使用伺服器上已核准來源的發布工具切換：

```sh
python3 /path/to/approved-source/deploy/frontend_release.py activate \
  --artifact /path/to/uploaded-frontend \
  --root /opt/qgroup-frontend \
  --api-commit FULL_RUNNING_API_COMMIT_SHA \
  --manifest-sha256 FULL_MANIFEST_SHA256 \
  --api-url http://127.0.0.1:8791 \
  --release-manifest /opt/qgroup/release-manifest.json
```

工具核對實際 API 與 runtime manifest，驗證檔案、PWA 版本及入口依賴，拒絕額外檔案、symlink、損壞內容與同名不同內容的 immutable asset。發布鎖內先安裝完整不可變 release，累積保留帶 hash 的資源，再以一次 rename 切換 `current`。所有 API／bot 與資料不動，runtime manifest 僅新增／更新 `frontend` 紀錄。

6. 核對 `/frontend-version.json` 的前端 SHA／build ID 與 `/api/v2/version` 的 API SHA；確認頁面、API、兩容器健康及容器 ID／啟動時間不變，寫入 `docs/releases/`。前端版本 JSON 為 `no-store`，不包含私有路徑或完整檔案清單。

## 快取與回退

首頁、深連結 shell、Service Worker、安裝 manifest 與版本資料不長期快取。帶 hash 資源保持 immutable；舊版本資源不自動刪除，保留開著的頁面稍後載入 lazy chunk 的能力。既有 PWA 保存草稿後更新流程保留，不強制啟用等待中的 worker、不清除使用者草稿。

回退使用已保留的 `releases/<commit>-<manifest摘要前16位>`，以同一 `activate` 指令、原 manifest 摘要及目前 API SHA 驗證後切回。無須重建映像或重啟服務。前端與目前 API 不相容時拒絕回退；不能還原業務資料庫。首次啟用若需退回整體網站映像，沿用原網站 image ID、移除 frontend override 並只重建 web，保留 bot 及現有資料。

前端檔案目錄需納入主機災難恢復清單，或保留核對過摘要的原始產物；它不混入 SQLite／刪除權威的業務備份。自動清理資源、CI 自動發布與相容性契約版本尚未實作。

## 實作驗證

已在隔離資料測試：同一 API 程序內切換與回退 HTML／worker／新檔名資源、保留舊 lazy chunk、API 版本不變、損壞或版本不合時保留舊指標、真實 HTTP API 版本核對及僅更新 runtime manifest 的 frontend 區塊。另驗證壓縮、HEAD／304、快取、簡繁、bot 深連結、未知 API／私有檔案拒絕、靜態資源不耗 API 限流、唯讀獨立掛載與資料目錄分離。後端輸入指紋測試確認純 UI 可接受，API／共用契約／lockfile 改動會擋下純前端建置。

相關單元／整合測試 64 項及 Python 來源／權限／封裝測試 4 項通過；PWA／precache 瀏覽器回歸 12 項、型別、完整建置與編譯產物 smoke 通過。9 份 bot 編譯產物與保留版本摘要相同。正式啟用見[發布紀錄](releases/2026-11-25-independent-frontend.md)，本節的隔離測試不等同正式環境破壞性驗收。
