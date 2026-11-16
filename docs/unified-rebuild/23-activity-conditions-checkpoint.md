# 第十七批實作：已發布安排與逐人確認

日期：2026-11-17（Asia/Taipei）。分支 `codex/unified-rebuild`。發布範圍 **`none`**：只做隔離實作及合成驗證，未部署、未整合 main。安排、報名狀態、通知及 bot payload 都屬跨服務契約，未來切換仍先按 **`both`** 驗證。

## 已實作

統一活動詳情提供有權者的「編輯活動安排」及所有可查看者的「安排版本與確認」。名單中由本人管理的報名可直接帶穩定 attendee ID 到安排確認入口；同名者仍以不同報名紀錄分開。會員不必有成分就能使用這些功能。

- `GET／PUT /api/v2/activities/:id/arrangements`：直接 TS API、原 revision、去重與原子收據。編輯沿用草稿的同一份 TSX 表單、時間／欄位驗證與比較流程，使用獨立的帳號／活動儲存空間，不套用草稿發布／刪除操作。
- 修改已發布的類別、開始、時長、地點、注意事項、有效退出期限、時區或費用規則時追加條件版本與快照。有效正式／候補／待確認報名標為 pending，保留原接受版本、原報名、付款歸屬及帳務；有有效報名就必須說明原因。
- 標題、容量、最低成團門檻或獨立截止時間本身不強制重建條件版本；退出期限留空而連動截止時，截止變動屬重要安排。容量不得低於正式人數，放寬容量仍用原嚴格 FIFO／整組阻塞遞補，截止後不自動遞補。沒有實質差異就不增加稽核／版本。
- 實際 ended／cancelled、歸檔或已存在 settlement 均不能重寫安排；預定時間已過本身不等同實際結束。更換開始時間仍必須在將來；不變的原開始時間可保留。
- owner-only 的費用、可見性、有效退出期限與群同步限制持續有效。具名網站管理員只在可查看的 scheduled／ongoing、未歸檔未結算活動協助安排，必填原因並通知原發起者；不取得協辦、名單、出席或財務權限。保留原來的截止／退出期限連動例外。救援管理憑證不冒充會員。

`GET /api/v2/activities/:id/conditions` 回傳目前安排、每頁 20 的保存版本、操作者與時間。訪客只得公開內容；邀請活動仍逐次驗權。只有 scoped 會員自己的 manager_id 報名才列入「我的安排確認」，不透過同名、user_id、owner 或網站管理員身分代替原管理人。

`POST /api/v2/activities/:id/attendees/:personId/conditions` 驗目前 manager、有效報名、可回覆的實際活動狀態、event revision 與 conditions version。接受只把此人接受版本更新為現在；暫不同意必填原因、保留原接受版本與報名，通知發起者協調，不退出、不新增帳款。每次決定追加 consent／audit；同一決定已生效時不重複版本或通知。

## 恢復、交易與 bot

安排編輯與逐人回覆先同步保存原輸入、原因、person ID、兩種版本、完整 payload 及原 key，持久化失敗就不發請求。未知結果鎖住操作，重新整理後以同一 key／payload 查回，不把舊結果當成最新狀態。`GET /api/v2/activities/management-results/:requestId` 只讀 scoped 最小收據，回放及查詢都重新驗活動存取與目前管理權限／原管理人。

409 不覆蓋輸入；明確「核對最新安排，保留輸入」才更新基準並重設同意。確認框不持久化，換人、改決定、改原因及重新核對都要求再次確認。損壞原稿先另存 recovery key；跨帳號拒絕舊 scope；裝置登出清除兩種表單原稿，離開後的延遲成功不重建私人資料。

條件歷史、待確認狀態、遞補、站內通知、audit 與收據同交易；必要寫入失敗整筆回滾。bot 維持原 policy／visibility／group／kind 檢查：條件變更、提醒重排、遞補通知、重新開啟群同步的發布卡片，都延續舊去重語意。條件通知沿原 hook 順序凍結，不把稍後名單變動追寫進已保存 payload。optional bot 使用 savepoint，不留下半筆工作。

暫不同意的私人工作只存泛化提醒與待綁定 recipient，不含私人原因／姓名／款項，也不猜測 QQ 身分。Python 差分發現開啟 keyboard 時這類工作原本包含空 rows，已補齊該既有欄位。沒有改動 Python bot 或真實待送工作。

## 驗證與剩餘工作

新增 **8 項 API 案例**：原 Python 安排變更＋遞補＋完整 outbox 差分、接受／暫不同意差分、重要欄位與無操作版本、owner／scope／管理員限制、收據撤權與邀請隱私、必要寫入回滾、optional hook 與活動狀態鎖、歷史分頁與訪客隔離。

新增 **7 項 Chrome 案例**：活動→編輯→版本→逐人決定；未知保存與未知回覆的原 key／payload；較新安排重新核對；儲存失敗／損壞保全；帳號切換與唯讀限制；跨頁登出及延遲回應。已檢視 360px 畫面與橫向溢出。

全套後端／領域／資料庫 **215 項、31 檔**及 Chrome **112 項**通過。strict TypeScript、建置、built API／SQLite／SPA smoke、既有 UI 生成及 166 項台帳檢查通過。schema 維持 **9**、**83** 張 user tables；前端約 **622 kB**，既有 500 kB 警告仍待效能收尾。

重現：`npm run test:rebuild`、`npm run build:rebuild`、`npm run test:e2e:rebuild`、`npm run test:build:rebuild`、`npm run check:ui`、`npm run check:capabilities`。

E02／E10／E11／A07 與相關恢復、bot producer 只記 in_progress。E17 本批只有安排版本，全部活動操作歷史尚待實作。完整報名／退出／認領／代管、通知收件匣、狀態管理、財務／分房／投票／音樂剩餘功能、全部舊入口及 TS worker 仍未完成；正式副本遷移、版本組合、真平台與完整讀屏／WebView 驗收仍待辦。台帳仍 **0 項完整通過、release_eligible=false**。
