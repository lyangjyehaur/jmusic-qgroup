# 第十六批實作：活動發布與現有 bot 消費相容性

日期：2026-11-17（Asia/Taipei）。分支 `codex/unified-rebuild`。發布範圍 **`none`**：隔離開發及合成驗證，未整合 main、未部署。涉及 schema、outbox 與 bot 網址，未來切換仍先按 **`both`** 驗證版本組合。

## 已實作

`POST /api/v2/activities/:id/draft/publish` 使用直接 TypeScript 業務；必須 owner、原 revision、明確發布與安排同意，並重新驗證已保存安排、將來的開始／截止時間及結算鎖。前台先保存再核對發布，同意在修改、比較、保存及重新整理後失效，沒有成分也能發布。

發布同一交易建立初始條件快照、本人報名與接受紀錄、活動 access、嚴格 FIFO／整組阻塞的候補遞補、站內通知、signup 與 event_publish audit 及去重結果。沿用原 Python「發布既有草稿必定報名本人」規則，包含草稿原本 join_owner=false；不把它混同於尚未重建的「直接建立 scheduled、明確不報本人」入口。既有報名及接受紀錄不覆寫。

成功後回到同一活動及名單，詳情顯示費用、退出期限、可見性與安排版本。人數上限 0 顯示不限；沒有活動說明時移除空區塊，不補展示文案。

## 未知結果與跨裝置競態

發布前以帳號 scope／活動保存原 revision、完整 payload 和原 key。未確認時鎖住編輯，維持原操作重試。發布其實成功但回應損壞，重新整理遇到非草稿時可只查 scoped 最小結果，回到已發布活動；不再次建立本人報名或發布通知。結果查詢與重試逐次重驗現在的活動角色。

建立／保存已成功、但讀取前被另一端發布時，保留原稿及操作編號，提供活動入口；重新整理仍可安全恢復，不把草稿讀取失敗當成寫入失敗而另建活動。409 仍需明確比較，不能默默覆蓋遠端安排。編輯器與結果查詢忽略離開後的延遲回應，登出不重建私人原稿。

## bot producer 與舊 worker

新增 TS 活動卡片 producer、凍結模板上下文、plain／Markdown 安全處理、有限名單及倒計時。12 種活動卡片、模板變體、按鈕、payload 與原 Python 作差分；使用 Unicode codepoint 長度及 Python 相容空白／提及處理。時區折疊／跳時案例已比對，不宣稱 ICU 與全部 Python tzdata 規則完全等價。

發布僅排一則包含最終本人名單的活動卡片，不重複發 signup 廣播；並按政策排截止與預計結束提醒。沿用原去重雜湊、schedule key、revision／政策版本、目標群與私人 recipient 欄位。已送、失敗及模擬意圖保留，變更安排只取消過時 pending／sending，不把歷史重播。邀請可見／草稿／停用政策不公開群發。optional bot hook 使用 savepoint，失敗不留下半批提醒，也不撤銷已完成業務；必要站內通知與收據失敗則整筆回滾。

現有 Python worker 在三個獨立合成副本實際 claim／consume 新產生的 outbox，transport 使用 Mock，完全無網路：純文字與 Markdown 各只消費發布一則、第二輪不重送；兩則未來提醒保持 pending。dry-run 記 skipped／simulated，不轉真送、不增加失敗次數。這不是正式 bot 版本組合或真實 QQ 驗收。

凍結 DDL 沒有包含舊 migration 的 bot singleton 資料，實際 worker 消費揭露 runtime 缺列。新增 **schema 8→9**，以原始空設定 `{}`、revision 0／baseline 歷史及 runtime 補缺，不替換既有設定、歷史、pacing 或部署群。遷移原子化，保留原 59 compatibility tables；總 user tables 仍為 **83**。既有隔離匯入完整逐列比對繼續通過；不對任意未標記的舊庫執行遷移。

根網址 `/?event=...&action=...` 接到統一活動與六種 task，開啟不執行寫操作，邀請內容仍驗權。其他舊網址及這些 task 的完整操作尚待重建。開發環境只讀 `REBUILD_BOT_*` 的明確設定，未讀正式憑證或群設定。

## 驗證與剩餘工作

新增 8 項發布 API／差分／現有 worker 消費、4 項 producer 差分／排程、4 項領域 rendering 差分及 3 項 singleton 遷移測試；Chrome 新增 7 項發布、未知結果、競態及舊 bot 入口案例。

全套後端／領域／資料庫 **207 項、30 檔**，Chrome **105 項**通過；strict TypeScript、建置、built API／SQLite／SPA smoke、既有 UI 生成及 166 項台帳檢查通過。已檢視 360px 發布後詳情截圖與溢出。前端約 **608 kB**，既有 500 kB bundle 提示仍待效能收尾。

重現：`npm run test:rebuild`、`npm run build:rebuild`、`npm run test:e2e:rebuild`、`npm run test:build:rebuild`、`npm run check:ui`、`npm run check:capabilities`。瀏覽器驗證使用最新建置產物。

E03、部分 B03／B04／B05／B07／B09／B11 及 O03 只記 in_progress。手動報名／退出、已發布安排變更與同意、全部活動狀態、協辦／邀請、財務／分房／投票／音樂剩餘功能與完整 TS worker 尚未完成。本批 producer 不代表 B01–B15 或 166 項完整驗收；台帳仍 **0 項完整通過、release_eligible=false**。正式版本組合、遷移／回退與真平台驗收仍阻擋切換。
