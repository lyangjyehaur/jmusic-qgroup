# 第十九批實作：逐人報名、候補與退出審核

日期：2026-11-17（Asia/Taipei）。分支 `codex/unified-rebuild`。發布範圍 **`none`**：僅隔離開發、驗收及原始碼同步，未部署、未整合 main。報名、條件同意、帳務歸屬及 bot outbox 為跨服務契約，未來正式切換仍先按 **`both`** 驗證。

## 已實作

活動詳情提供「本人／同行報名」及「管理報名」，名單中的原管理人可用穩定 attendee ID 直接選取特定報名。新增與管理共用一份 React／TSX 實作，分別保存原稿；不要求會員先有成分。

原生 TypeScript API：

- `GET /api/v2/activities/:id/registration`：當時安排、費用、退出期限、revision、目前本人報名狀態及此帳號有權管理的逐人名單；不回傳其他管理人的可操作資料、邀請 token 或無關帳務。
- `POST /api/v2/activities/:id/registration/preview`：本人／同行、逐人稱呼／公開備註／付款歸屬、1–20 人、逐人／整組、正式／待確認意願，綁定當時規則及逐人名額。
- `POST /api/v2/activities/:id/registration`：重驗 event revision、conditions version、逐人完整輸入及預覽 digest；明確接受當時安排和混合分配，再追加 party、attendee、逐人 consent、access、audit 與收據。
- `POST /api/v2/activities/:id/attendees/:personId/registration`：edit／confirm／split／withdraw／approve／reject；精確版本、目前權限、狀態與明確確認。
- `GET /api/v2/activities/registration-results/:requestId`：帳號 scoped 最小結果；回放與查詢皆重新驗存取、原管理人／目前 roster scope，審核還重新驗 roster scope。

## 規則保留

預覽 digest 與原 Python 的排序、Unicode 及 JSON 分隔格式相同；不只比最終人數。本人稱呼以目前會員稱呼為準、本人只一筆有效報名；同行／純代報各建獨立 attendee，不建假帳號，不按同名合併。manager 不等於 payer，不將選擇「本人付款」當作取得代報管理權。

逐人分配允許部分正式、部分候補，但必須另行接受 acceptPartial。整組名額不足時全組候補，阻擋後方候補，保持原 FIFO。待確認不占名額；確認參加時取得新 party ticket，整組待確認一起轉入候補再分配，不繼承原等待時間。拆組保留本組隊序，不能跳過更早整組。

已正式者不因後加同行而重排。退出後保留原紀錄與同意版本，重新報名另取新隊序。只有實際開放報名才遞補；暫停、截止、實際開始後不偷偷補位。

只有原 manager 或目前 roster scope 可管理；同名、user_id、網站管理員身分不替代管理權。修改他人資料、撤銷他人報名、審核申請必填原因。已關聯會員的稱呼不從此表單修改；已有 attendee_payment_origins 時付款責任不可改，保留原來源與結算更正入口。

逾退出期限的正式報名由原管理人提交申請，必填原因並保留名額；roster 管理人同意／拒絕都必填原因及通知原管理人。候補／待確認可直接退出。roster scope 對其他管理人名單的明確撤銷維持原例外；不以 owner 身分讓自己的逾期正式報名自動跳過審核。已有結算、實際結束／取消／歸檔或草稿阻擋名單寫入。

SQLite immediate 交易中重驗預覽與版本；同一名額兩份原 revision 並行提交只有一份成功，另一份 409 保稿重預覽。必要 consent／通知／audit／收據失敗整筆回滾；既有付款來源不寫入、不刪改。

## 恢復與 bot

預覽與勾選確認不跨重新整理保存，也不代表使用者自動接受新版安排。提交前先同步保存原 key、完整 payload、person ID、revision、預覽 token 及當時同意版本；本機儲存失敗不發寫入。未知結果鎖表單，重新整理重用同 key／payload；退出後原 attendee 已不在有效名單也可安全回放。

409 保留原輸入，明確重讀才更新基準；改任一欄位、分配或部分候補選擇會重設確認。未修改的空表單重新進入採用新 revision；真正原稿不被伺服器資料覆蓋。損壞原稿先保存 recovery 副本；跨帳號拒絕舊 scope，跨分頁登出清空兩種原稿，延遲成功不能重建私人輸入。

bot producer 依原 hook 保留：signup／tentative confirm 的最終新增名單、退出與同次遞補合成一次群通知、拆組遞補通知、逾期申請及審核的泛化私人提醒。純待確認、改備註及僅提交待審不產生報名變動群卡。私人 payload 不存申請原因／姓名／金額、不猜 QQ 身分。optional bot hook 使用 savepoint，不留下部分工作；Python bot 及正式待送資料均未改動。

## 驗收

新增 **12 項後端案例**：原 Python 預覽 token／Unicode／多行及完整資料／outbox 差分、整組待確認確認與拆組、付款來源保護、退出及遞補、逾期申請／拒絕／批准、角色與理由、批量限制／舊預覽、原 key 回放與撤權、scoped 資料／活動存取／結算鎖、必要失敗回滾與 optional bot、並行不超賣、審核撤權與通知失敗原子恢復。

新增 **9 項 Chrome 案例**：本人＋同行混合分配與明確接受、整組待確認→確認→拆組→修改、未知新增與未知退出跨重整恢復、安排改版保稿重預覽、逾期退出申請／拒絕／批准、儲存阻擋與損壞保全、穩定 person 深連結／帳號切換、跨頁登出／延遲回應。已檢視 360px 畫面及橫向溢出。

全套後端／領域／資料庫 **243 項、33 檔**及 Chrome **128 項**通過。strict TypeScript、建置、built API／SQLite／SPA smoke、既有 UI 生成及 166 項台帳檢查通過。schema 維持 **9**、**83** 張 user tables。前端約 **651 kB**，既有 500 kB 警告待效能收尾。

重現：`npm run test:rebuild`、`npm run build:rebuild`、`npm run test:e2e:rebuild`、`npm run test:build:rebuild`、`npm run check:ui`、`npm run check:capabilities`。

## 剩餘工作

R01–R08／R13 只記 in_progress。補報名邀請、代報認領／付款來源建立、管理轉交／協辦邀請、現場補錄、活動完整操作歷史／收件匣與待辦、舊 API／網址轉接仍待實作；結算／分房／投票／音樂剩餘功能及完整 TS worker 也尚未完成。差分使用合成資料與原程式，不等於正式資料副本、真 QQ 或 B01–B15 全部通過。台帳仍 **0 項完整通過、release_eligible=false**。
