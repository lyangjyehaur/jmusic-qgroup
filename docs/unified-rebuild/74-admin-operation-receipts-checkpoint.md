# 第六十八批實作：收件匣管理回執隔離

日期：2026-11-18（Asia/Taipei）。分支 `codex/unified-rebuild`。變更範圍 **`web`**，實際發布範圍 **`none`**。本批隨重構分支同步至兩個原始碼遠端；未合入 main、未部署，未操作正式資料、憑證、群設定或真實投遞。

## 修正的問題

收件匣此前將管理表單的 UUID 交給會員 `/me/operations/:key` 查詢。管理命令的回執實際保存在 `auth_requests`，以管理授權隔離；會員回執位於 `request_results`。這會把已完成的管理操作誤報成未找到；若會員恰有相同 UUID，也可能把無關會員操作當作管理回執。

新增只讀 `GET /api/v2/admin/operations/:key`。每次查詢重新驗證目前會員／訪客 session 與管理授權，再比對原稿 key 中的管理 scope（`X-Admin-Scope`）。伺服器只使用目前授權推導的 `receiptScope` 查詢，不接受客戶端選擇任意憑證或回執命名空間。回應只有 `{committed:boolean}`，不提供原命令、設定、姓名、目標、私人備註、PIN、secret 或原回應。

原管理 scope 不符合目前授權時明確回報需回原頁核對；不以新管理授權的「查無資料」冒充舊操作結果。換裝置、角色移除後重授、救援登入更新／到期／憑證輪替及登出均重新驗證。輸入須為 UUID 與 64 位小寫十六進位管理 scope，拒絕額外查詢參數。

## 恢復流程

帳號備註／角色、刪除申請審核、成分關聯、詞庫、壁紙、找搭子及 bot 設定，從經驗證的本機 key 取得原管理 scope，使用管理回執入口；會員操作保留會員入口。收件匣的保全版本也沿用原管理 scope。PIN 與會員刪除收據沿用原表單專用流程；管理成分刪除收據尚未接入此清單，本批沒有將 secret 加入一般查詢。

查核不提交原操作、不刪除本機紀錄，也不將有回執直接視為整個業務已驗收。仍須回原頁核對目前權限、原內容與最新資料，再由原表單明確確認。未送達操作查核為 false；HTTP／回應格式失敗顯示可重試錯誤，清除前次查核訊息，不誤報為查無資料。登出後的延遲回應不能恢復收件匣資料。

## bot 相容性

未改 schema、outbox、共用政策、bot 指令、模板、連線或投遞契約。原生測試核對新查詢前後整庫資料相同，包括 bot 設定、歷史與待送工作；既有 Python／TypeScript bot 相容測試繼續執行。本批不重啟或替換 Python bot，正式版本組合與 QQ 驗收仍未完成。

## 驗證與剩餘工作

- `npm run typecheck:rebuild`、`npm run build:rebuild` 通過。
- 原生測試 94 個檔案、818 項通過（`--maxWorkers=2`）。
- 管理／收件匣相關瀏覽器回歸 104 項通過；新增管理回執瀏覽器 6 項通過。首輪新增測試有一項定位器同時匹配提示與結果，修正測試定位後五項重跑通過，再補驗保全版本一項；沒有略過失敗測試。
- `npm run test:build:rebuild`、`node tests/test_bot_links.js` 通過；全部使用隔離資料庫及本機模擬傳輸。
- `npm run check:capabilities`、`git diff --check` 通過；360px 回執畫面已視覺檢查，無水平溢出。

本批只補管理一般回執的範圍分流。其餘 mutations 的持久化、含 secret 的刪除收據、舊 session recovery 副本與 `kanban-local-v1` 遷移、跨裝置 create intent、完整匯入／匯出、實體裝置與正式版本組合仍待完成。166 項能力維持原狀態，`release_eligible=false`；完整實作及驗收目標繼續，依使用者要求先不部署。
