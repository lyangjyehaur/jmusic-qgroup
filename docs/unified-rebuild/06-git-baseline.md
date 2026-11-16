# 重構前 Git 保全與開發方式

日期：2026-11-17（Asia/Taipei）。發布範圍：`none`。本文件記錄原始碼保全，不代表資料備份或正式部署。

## 固定舊版來源

重構前完整來源提交為 `8da877857f163853c449474e168534e2e493121b`，保留以下兩個引用：

- 凍結分支：`legacy/pre-unified-rebuild`。
- 附註標籤：`pre-unified-rebuild`。

分支與標籤指向相同提交，均保存完整祖先歷史。後續查舊程式用此基線；不得在凍結分支繼續開發或移動標籤。舊版修補另開 `codex/*` 分支。

推送這兩個引用至 git.dan.tw 與 GitHub 後，必須逐項核對兩個遠端的分支 SHA、標籤物件 SHA 與標籤解參照後的 commit SHA。推送不是原子操作，任何一邊失敗就補推。

## 未整合草稿

原工作目錄的 20 個 Android QQ 頁首來源與生成檔，已單獨保存於 `codex/android-qq-header-draft`，提交 `8232b471078f3a1bee4072cf9bb484e065a48e40`。

此提交是未驗收草稿，與舊版已整合基線分開；不列入舊版標籤，不直接套入新前端。後續若需要該修正，先閱讀原差異，再在新架構獨立實作／驗證。草稿分支僅作本機保全，不能據此宣稱已雙遠端同步或正式發布。

## main 與重構工作目錄

盤點文件先在 `codex/unified-product-plan` 驗證後整合到 main；只改文件，不改目前可運行網站。其後從最新 main 建立 `codex/unified-rebuild` 與獨立 managed worktree，新程式放在 `apps/`、`packages/`、`tools/`。

main 在 166 項既有功能、資料遷移與完整驗收通過前，維持現有網站實作。重構功能分支可以持續提交與雙遠端同步，不能從它直接正式發布。最終驗收完成後合入遠端 main，另外安排正式切換。

常用只讀比對：

```sh
git show legacy/pre-unified-rebuild:music_site/upstream.py
git show pre-unified-rebuild:qgroup_core/settlements.py
git log --oneline legacy/pre-unified-rebuild -- qgroup_core/roster.py
git diff legacy/pre-unified-rebuild...codex/unified-rebuild -- apps packages
```

原始碼基線不能代替 SQLite、成分 JSON、身份庫、刪除紀錄、圖片／壁紙、設定和服務映像的成套保全；正式切換仍依[遷移與驗收計畫](04-migration-and-acceptance.md)。
