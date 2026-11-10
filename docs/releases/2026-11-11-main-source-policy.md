# Main 整理與正式發布來源規則

發布範圍：`none`。本次整理 Git 歷史、操作文件與來源檢查工具，不重新建置或部署 web／bot，不更動正式資料。

## 版本整理

- 原 main 為 `b13d7f4`，以 fast-forward 整合 `codex/activity-form-release` 至 `49e0fe6`，包含 QQ 群組管理、公開查詢、活動表單、基本入口及結算功能與發布紀錄；沒有重寫既有提交。
- 已上線來源為 `4ed8b5be006180e3e92466e00184c0a196b4c4f1`，映像 `qgroup:20261110-settlement1-4ed8b5b`。本次將該歷史納入 main，不因文件與工具提交而重新部署。正式版本組合及驗收見 [結算發布紀錄](2026-11-10-settlement.md)。
- 原主工作目錄的全部未提交修改及未追蹤檔案保存在本機 stash：`6db7186be600d5ac76fcb037a2e8e85afa1fedc8`，標記 `preserve-local-drafts-before-main-sync-2026-11-11`。這是舊基線草稿，尚未重新整合或推送；後續從最新 main 開分支並逐項比對，不直接整份套回。可用 `git stash show --include-untracked --stat 6db7186be600d5ac76fcb037a2e8e85afa1fedc8` 查看保存範圍。
- 兩個功能分支保留供歷史查閱，已整合的分支停止繼續開發，後續工作以最新 main 為基線。

## 新規則與驗證

正式新版本先合入並推送 main，再由 `deploy/check_release_source.py --commit <完整 SHA>` 重新取得遠端 main 並確認來源位於其歷史；工作目錄必須乾淨。以工具核准的明確提交封存到新的乾淨建置目錄。工具只核對來源，沒有自動測試、備份、部署或相容性保證，不能取代既有發布流程，也不是不可繞過的伺服器閘門。

`tests/test_release_source.py` 使用隔離的本機 Git 倉庫及 bare remote，覆蓋已推送 main、歷史祖先、刷新遠端追蹤、未推送提交、未合併但已推送的功能分支、髒工作目錄、未追蹤檔案、非完整 SHA 與遠端不可用；不連線正式環境。正式發布仍按 web／bot 相容性規則，只更新受影響服務。

驗證結果：`python3 -m unittest discover -s tests -p test_release_source.py -v` 的 8 項測試全部通過，`git diff --check` 通過。既有業務程式僅快轉整合已發布提交，本次沒有另改業務行為。
