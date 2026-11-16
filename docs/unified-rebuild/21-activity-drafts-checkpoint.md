# 第十五批實作：活動安排草稿與操作恢復

日期：2026-11-17（Asia/Taipei）。分支：`codex/unified-rebuild`。發布範圍 **`none`**：只修改隔離重構系統，沒有正式環境操作。後續切換仍須先按 **`both`** 完成網站／bot 組合驗證。

## 已實作

活動入口新增建立草稿與活動草稿列表。建立、續編、衝突核對及刪除均使用直接 React／TSX 與 TypeScript API，沒有呼叫 Python 作為業務橋接。活動功能不要求先建立成分。

表單保留名稱、六種既有類別協議值、地點、開始／截止／退出時間、持續時間、人數上限、最低成團人數、顯示時區、公開／邀請可見性、QQ 群同步、費用規則與活動說明。所有表單時間明示以台北 UTC+08:00 輸入，活動顯示時區另存，不依瀏覽器所在地解讀。草稿允許過去日期；期限不能晚於開始，人數與時長有界。

API 保留原 `join_owner` 的草稿欄位及明確 false；前台沿用既有介面建立時的 true，不新增不能兌現的參加選擇。原 Python「發布既有草稿必定報名發起人」與「直接建立 scheduled 可明確 join_owner=false」仍需在發布批次分別驗證。

- `POST /api/v2/activities/drafts`：草稿、owner access、第一筆 event_created audit、結果收據同一交易。沿用 16 位 hex 活動 ID、32 位邀請 token、UTC 秒與 `+00:00` 格式。
- `GET /api/v2/me/activity-drafts`：僅本人或非空明確活動角色，每頁 20；不因網站管理員身分或另一場 access grant 提權。`GET /api/v2/activities/:id/draft` 不回傳邀請 token／帳號 ID。
- `PUT /api/v2/activities/:id/draft`：schedule 權限、原 revision、安排驗證、追加稽核及收據同交易。非 owner 不得改群同步、費用、可見性或有效退出期限。已有正式名單時不得縮至超額；匯入草稿若已有有效報名，重要安排變動仍要求原因，保留原接受版本與狀態。
- `POST /api/v2/activities/:id/draft/remove`：owner 明確確認、原 revision；已有帳務、任何他人報名（含退出、同行及代報）或協辦即阻擋。只標 deleted，保留資料與歷史；取消 pending／sending 工作，不改 sent／failed／skipped 或 payload。
- `GET /api/v2/activities/draft-results/:requestId`：會員 scoped 最小結果，使用獨立 receipt namespace；不回傳原稿，逐次重驗目前活動角色。刪除成功但回應損壞，重新整理遇到 404 仍可查回最小刪除結果。

修改沒有實際差異時不加版本或稽核。原 `public_snapshot` 未包含 draft_join_owner，舊版只改此欄位不會增加 revision；新版把它放進草稿內部 audit，使單獨修改也能阻擋陳舊覆寫。此差異已有測試，未改既有公開 snapshot 或條件版本契約。

時間解析先檢查真實曆日與明確 offset，不使用會把 2 月 30 日滾到 3 月的 Date.parse 作唯一驗證。時區同時通過凍結的 Python ZoneInfo 名稱表及 Node ICU；目前名稱表 598 項，可用 `python3 tools/rebuild/build-timezones.py` 重新產生。這不是時區轉換規則快照，亦不宣稱不同 tzdata／ICU 版本全部相同；少數只有一側支援的名字及完整跨區日期操作仍待後續驗收。

## 草稿與權限恢復

sessionStorage 以帳號 scope／活動或 new 分開保存輸入、原因、原 revision、待確認 key 及完整 payload。送出前必須同步持久化；寫入失敗就不發請求。結果不確定時鎖住編輯，以原 key／payload 重試；建立收據永不重新建立第二場活動。舊收據不當作最新狀態，先重新讀取草稿。

409 保留輸入。明確點「核對目前安排，保留輸入」才更新基準，並展示目前所有已保存安排供比較，不自動覆寫。離站可保留原稿；損壞的儲存內容須先另存 recovery key 才繼續。登出清除本裝置草稿及私人畫面；已離開的編輯器不處理延遲成功回應，避免重新寫回被清除的原稿。

這批是分頁草稿恢復，尚未完成 IndexedDB、跨裝置伺服器 create intent、明確選擇恢復、舊站草稿 adapter 或圖片恢復，不把它們記成已完成。

## bot 保全

正常新草稿不發布條件、不自動報名、不通知參加者，也不新增公開群 outbox 或定時提醒。舊草稿若意外已有待送工作，實際安排修改時沿用原 Python hook：bot 政策啟用才跳過群 pending／sending 及已失效提醒，保留原錯誤字串與凍結 payload；其他私人通知不變。optional bot hook 在 savepoint 中，失敗完整回滾該 hook、記錄最小錯誤而不撤銷業務保存。

刪除的停送屬業務必要保護，與刪除／audit／收據一起交易，失敗就整筆回滾。沒有改動正式 bot、憑證、群設定或真實待送消息，也沒有真實 QQ 投遞。

## 驗證與剩餘工作

新增 11 項 API／差分案例：原建立與修改 snapshot／audit、獨立草稿欄位版本、無條件／報名副作用、角色與跨帳號拒絕、已撤權收據、曆日／人數／型別／時區限制、刪除阻擋、整體交易回滾與 optional hook savepoint。合成副本由原 Python bot 唯讀 probe 比較，既有公開活動、設定與待送工作不變。

新增 8 項 Chrome 案例：表單完整設定與 360px、未知建立只建一次、版本衝突明確比較、未知刪除重新整理查回、切換帳號、儲存失敗／損壞保全、未知保存讀取較新安排、跨頁登出與延遲回應。已檢視手機截圖及橫向溢出。

全套後端／領域／資料庫 **188 項、26 檔**及 Chrome **98 項**通過，strict TypeScript、建置、隔離 built smoke、既有 UI 生成及 166 項台帳檢查通過。

重現：`npm run test:rebuild`、`npm run build:rebuild`、`npm run test:e2e:rebuild`、`npm run test:build:rebuild`、`npm run check:ui`、`npm run check:capabilities`。schema 維持 8、83 張 user tables，沒有遷移；前端約 605 kB，既有超過 500 kB 的 bundle 警告仍待效能收尾。

E02／E03／E09 與 O04–O06 只標 in_progress。活動發布、發起者自動報名、重要安排條件版本、報名／候補、完整狀態操作、協辦邀請及活動 bot 卡片／提醒尚未完成，不能以草稿驗證取代。B01–B15、完整 166 項、正式版本組合、遷移／回退及真平台驗收仍阻擋正式切換。未整合 main、未部署。
