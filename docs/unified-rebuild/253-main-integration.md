# 重構版整合 main 與舊版歸檔

日期：2026-11-25（Asia/Taipei）。本次操作發布範圍 **`none`**：只提交、合併及同步原始碼，不建置正式映像、不部署或重啟服務。整體重構日後的服務切換仍須按發布政策評估 `both` 及舊 Python bot 相容組合。

## 舊 main 保全

整合前本機、Gitea 及 GitHub 的 main 一致，來源為 `aa06e355962159f0f8f556a079bc4434278b5b2b`。以 annotated tag `archive/main-before-unified-20261125` 歸檔該提交及完整祖先歷史，同步保留至兩個遠端；不刪除舊版原始碼、提交或正式服務。

既有 `legacy/pre-unified-rebuild` 指向較早版本，保持原樣，不將其誤稱為本次整合前的 main。

## 整合內容與驗證界線

- 既有 `codex/unified-rebuild` 全部重構提交及已驗證的 Kimi 接入／功能收尾一併整合；[第 252 批](252-kimi-functional-finish.md)記錄目前前端的實際結果及失敗重測，不改寫成一次完整全綠。
- main 額外的 `83eb54ce94f935a4048aaf63a410206723f09bd8` QQ 登入導頁修正與 `aa06e355962159f0f8f556a079bc4434278b5b2b` 發布紀錄一併保留，包含舊 UI 的相關測試入口。
- 正式資料副本、登入狀態、憑證、資料庫、上傳圖片、建置產物及私人驗證 trace 由 `.gitignore` 排除，不加入提交。
- 歸檔及整合前確認 `origin` 抓取來源仍為 Gitea，push URL 同時涵蓋 Gitea 與 GitHub，另保留 `github` remote；推送後逐一核對分支與歸檔標籤的遠端 SHA。

[第 251 批](251-prelaunch-feature-parity-audit.md)的 G05「尚未合入遠端 main」在完成本次同步後由此紀錄取代。這不表示 `release_eligible=true` 或已通過正式來源檢查；G01 Docker 建置輸入仍依使用者要求暫緩，正式發布前須另以明確完整 SHA 執行來源檢查及乾淨封存建置。

整合完成後停止在 `codex/unified-rebuild` 繼續開發；後續修改由最新 main 建立新的 `codex/*` 分支。原有工作樹及本機測試原稿保持可用。
