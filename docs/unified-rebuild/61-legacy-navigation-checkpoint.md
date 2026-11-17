# 第五十五批實作：舊入口與活動邀請

日期：2026-11-18（Asia/Taipei）。分支 `codex/unified-rebuild`。本批影響範圍先按 **`both`** 評估：修改 bot 與舊卡片依賴的網站入口；實際發布範圍 **`none`**。只在本機合成資料庫驗證，未合入 main、未推送、未部署，未操作正式 bot、憑證、群設定或待送工作。schema 保持 **14／94 張表**，保留 Python bot；完整正式版本組合尚未驗收，不據此縮小發布範圍。

## 舊連結選擇原生流程

`legacyNavigation` 在掛載 Layout 與頁面查詢之前解析舊 pathname／query／hash，用 replace 進入新位置。只接受列出的操作；重複控制參數、混合 poll／event／token、未知操作、無效 ID／token 顯示具體錯誤，不默默落到活動詳情。網址不執行報名、退出、款項、授權或管理寫入。

| 舊入口 | 新位置／行為 |
| --- | --- |
| `event`、`action=detail` | 活動詳情 |
| `action=create`／`mine` | 新活動草稿／本人相關活動 |
| `join`／`party`／`tentative` | 報名；同行預設只有同行，待確認預設不占位意願 |
| `withdraw` | 管理報名，選擇可退出人員後預選退出；仍需確認提交 |
| `conditions`／`finance`／`settlement` | 安排版本／帳本／逐人結算 |
| `report` | 展開帳本申報；發起者也不預設成直接登記 |
| `invite`／`claim`／`management` | 補報名邀請／代報認領／管理分工 |
| `manage`／`copy` | 安排編輯／獨立再約草稿 |
| `todos`／`attendance`／`onsite` | 該活動收件匣／出席／現場補錄模式 |
| `invite`、`attendee_invite`、`management_invite`、`claim` token | 查看授權、補報名、管理分工、認領各自的確認頁 |
| `poll` | 時間投票 |
| `account_link` | 裝置確認頁 fragment；沿用暫存後移除 fragment 的流程 |
| `qq=return` | 原生 QQ 明確確認頁 |
| `/music/`、`/music/index.html` 舊八類 hash | 排行、完整詞庫、同好、活動分析、自由試算、喊話、趨勢、本人音樂 |
| `#event` 未指定活動 | 選活動後直接進入該活動成分試算 |
| `/music/admin[.html]`、`/admin#music-links-section` | 共用管理入口／成分帳號管理 |
| 舊隱私與聯絡 HTML | 原生政策與聯絡頁；保留投訴郵件、資料刪除入口及備案資訊 |

舊 `.html` 僅開放明確白名單回傳 SPA。未知檔案、API 及非 GET 仍為 404；舊 `/music/api` 路徑也明確拒絕，避免被 SPA fallback 回成 200。偽造 `X-Music-Proxy-Key`／`X-Music-Identity`、Bearer 或舊 Cookie 不會授予新版權限。

## 邀請可見、分享與再約

新增原生查看邀請預覽與接受端點。持有效 token 只能預覽活動 ID、標題與 revision；草稿、刪除及失效 token 一律拒絕。接受必須登入，以目前帳號 scope、Origin、CSRF、revision、明確確認及原操作 UUID 提交；交易只寫 `event_access` 與操作回執，不改活動 revision、名冊、稽核、金流或 outbox。重試檢查 token 與目前活動存取權，失效或撤權不能靠舊回執旁路；未知結果保存原 UUID／內容供核對，帳號切換不共用原稿。

未登入訪客也可分享公開活動，一律只產生一般活動路徑；邀請可見 token 僅發起者可讀，管理員／協辦／既有查看權都不能擴大披露。讀取不建立或更新 token。敏感原生 access path 與全部舊 query 在請求日誌遮蔽。

再約使用只讀安排白名單，排除所有日期／截止、bot 同步同意、加入本人選項、邀請 token 及業務關聯。新表單重新填日期，預設關閉群同步；名單、款項、圖片、角色、歷史均不複製。每個帳號與來源活動有獨立草稿，不覆蓋一般新增稿；已有原稿時直接恢復，即使來源活動稍後不能讀取，也能核對自己的再約稿與原建立操作。

「我的活動」加入有 scope 的分頁端點，包含本人所有／協辦、有效本人或管理同行、以及退出後仍有已發布結算義務的活動；保留草稿入口與往期活動。先按活動可見性／草稿權限限制，再判斷參與，單有查看 grant 不列為參與。同行、待確認、申報與現場補錄的連結預設不覆蓋已有輸入或待確認操作。

## 驗證與剩餘工作

本批新增 **52 項路由／11 項 API** 測試；最終完整原生回歸 **93 檔／802 項通過**。瀏覽器在六份活動／舊入口 spec 完整 **52 項通過**，補入公開訪客分享後，該新增場景獨立通過；共 **53 項不同場景**。最後分享欄位使用明確 label／textarea 關聯，避免含連結值的標籤文字影響定位。

保留 Python bot **311 項**、時間投票 bot **15 項**、舊 bot 連結三語產物檢查均通過。strict TypeScript、原生前後端建置、建置後 API／bot smoke 與能力台帳檢查通過。built smoke 另核對五個舊 HTML 入口真正回傳同一 React index，偽造代理 context 的內部／管理／匯出及未知 HTML 回 404。前端 bundle **1,174.91 kB／gzip 342.59 kB**，仍有既有大 chunk 警告；拆包與全量平台驗收尚未完成。

初次將完整原生差分與瀏覽器同時執行時，既有縮寫 Python 差分達 5 秒測試上限；分開重跑後兩次完整原生回歸均通過，未變更 timeout 或放寬斷言。合成資料驗證有限預覽、明確授權前後全部資料表、原回執、token／權限／scope／CSRF／Origin、私人分享白名單、再約欄位、財務限定本人列表、分頁與偽造代理拒絕。路由測試直接匯入原 Python bot 指令表和 URL 產生器交叉核對；沒有啟動正式 worker 或投遞 QQ。

**166 項保留、0 項完整驗收、release_eligible=false**。E04、O02 更新為 in_progress；E01、E05、O03 補入本批證據。全部使用手冊與其他低頻舊頁、IndexedDB／舊草稿遷移、已安裝 Service Worker 與 PWA 更新、語系、正式資料對帳、真實 QQ 與切換後實際 web／bot 組合，仍須後續 P6／P7 驗收。此批不代表可正式切換，繼續遵守先不部署。
