# 第二十二批實作：管理分工與發起者交接

日期：2026-11-17（Asia/Taipei）。分支 `codex/unified-rebuild`。發布範圍 **`none`**：隔離開發、驗收及原始碼同步；未部署、未整合 main。活動權限、既有結算通知與 outbox 是跨服務依賴，正式切換仍先按 **`both`** 驗證。

## 已實作

活動詳情與草稿編輯共用 React／TSX「管理分工」入口。發起者可查看現有協辦職責、邀請協辦、指定結算人、交接發起者，以及按穩定 ID 撤銷職責或待接受邀請。每次操作必填原因與明確確認；不使用宣傳或裝飾文案。

邀請可綁定現有未退出報名者的真實 user_id，或私下交付七日有效的專屬連結。稱呼只供辨識，不用名稱匹配會員；沒有本人綁定的同行不能作為綁定目標。不綁帳號時明確提示任何持有連結的會員都可接受。原綁定參加者日後退出，不會把邀請轉給別人。

原生 TypeScript API：

- `GET /api/v2/activities/:id/delegation`：目前發起者、協辦職責、本人 scope；僅發起者可見綁定目標與未接受 token。
- `GET /api/v2/activities/:id/delegation/preview/:token`：有限的活動名稱、發起者、受邀稱呼、職責與期限。綁定邀請只允許正確帳號預覽；不洩露私人地點、名單、資金或歷史。
- `POST /api/v2/activities/:id/delegation/invitations`：只有當前發起者，檢查精確 revision、原因、職責、受邀帳號及明確確認。
- `POST /api/v2/activities/:id/delegation/preview/:token/accept`：重新檢查期限、原 initiator 仍為發起者、recipient、revision 及本人接受責任；發起者不能接受自己的邀請。
- `POST /api/v2/activities/:id/delegation/invitations/:itemId/revoke` 與 `/roles/:itemId/revoke`：當前發起者、精確 revision、原因及確認。

舊 `/?event=…&management_invite=…` 轉入新版接受頁；登入返回保留活動與 token，開啟不自動修改。私人活動接受前不授 access；接受才授予活動存取。管理邀請不新增 attendee、party 或 consent，也不占報名名額。

## 職責與歷史規則

- `schedule`／`roster`／`attendance`／`settlement` 分開授權。一般協辦接受以所選職責**取代**對方原有 scopes；不默默擴權。
- 邀請包含 settlement 時，保留受邀者的其他職責；只撤銷前任指定者的 settlement，其他 scopes 保留，原角色只剩 settlement 才刪除該 role。每場仍只有一位指定結算人，發起者自身權利不變。
- 交接成功更新 owner_id、移除新發起者的冗餘 cohost role，使原發起者所有 pending 管理邀請失效，再標記本份 accepted。原發起者仍保留自身 attendee 管理權及歷史資金責任。
- 新建 transfer 只取代先前 pending transfer，不提前作廢 cohost；真正接受 transfer 才作廢所有 pending。
- 歸檔阻擋新建邀請，但不額外阻擋既有邀請接受／撤銷，延續來源行為；草稿、已結束／取消／結算歷史不錯套一般報名鎖。
- 保留 attendee／party／順序／條件 consent、原付款來源及 finance／settlement／圖片資料。管理交接與實際代收資金交接分開，邀請與接受處均有必要提示。

正常操作以 Python `qgroup_core.management` 逐表差分。唯一刻意修正：舊程式的 audit snapshot 只有 owner_name 與 roles，兩個真實帳號同名且角色快照相同時，會漏記真正的 owner 轉移、revision 及群卡。新版僅在這個模糊相等情況把 owner_id 加入前後快照，確保真實交接被記錄一次；不改會員名稱或合併帳號。

## 交易、未知結果及隱私

所有寫入使用 immediate 交易，必要 invitation／role／owner／access／notification／audit／receipt 任一失敗全部回滾。Bot hook 以巢狀交易隔離，optional 失敗不留半套 bot 寫入，也不推翻已成立的業務交易。

寫入前保存帳號／活動／操作模式各自的完整 payload 與 UUID；儲存失敗不送出，確認勾選不持久化。未知建立、撤銷或接受可重整後用相同 key／payload 查回，失效 token 的預覽 404 不擋原接受操作恢復。已完成接受只回 event ID、revision、operation ID，仍核對 accepted_by 及目前活動存取；回放不重新授予已撤銷的 scopes。建立／撤銷收據仍要求當前 owner，不讓前任發起者繼續操作。

版本衝突保留稱呼、職責、原因；明確取得最新分工後重新確認。損壞原稿先保全 recovery 副本。帳號切換拒絕舊 scope；跨分頁登出清除管理原稿，延遲回應不恢復私人資料。

統一 request URL 日誌清理同時處理原生與舊 token 路徑、網頁 delegation 路徑、編碼路徑及全部 query；修正原 claims/preview 清理只隱藏 preview 字樣、仍留下 token 的缺口。收據 signature 僅含 token 雜湊，錯誤紀錄不加入邀請 token。

## 保留的 Python bot 相容性

站內通知與私人 outbox 延續來源文字、接收者及去重。交接群卡沿用 `ownership_changed`、按鈕、活動舊入口與「管理交接不代表實際代收資金已移交」提示；沒有姓名、token 或收款資訊。私人未綁定通知延續舊 worker skipped 行為，不能轉發到群；這不代表已完成私人 QQ 真送。

隔離 DB 由新版網站產生 ownership card，再由現有 Python `OutboxWorker` 實際消費：普通文字、rich card、dry-run 均檢查結果、一次處理及不重播。另驗證更換 settlement 指定者／交接 owner 後，舊發布者失去 settlement 權限的既有待送結算被原 worker 作廢；原結算快照、金額及 actor 不改寫，不誤送舊收款資訊。所有平台 API 均為 Mock，無憑證與真實群操作。

## 驗收

新增 **17 項後端案例**：七日邀請／四 scopes 與 Python 差分；私人有限預覽／非參加者接受；真實 attendee 綁定；一般職責取代；唯一結算人及雙方其他職責保全；撤銷不改本人報名／access；發起者交接與歷史資金；supersede／期限／原 initiator；歸檔／草稿／已結算；owner 與網站 admin 分離／原因／確認／revision；精確 receipt 回放不恢復權限；競爭接受只有一勝者；同名不同帳號 audit 修正；必要失敗回滾／optional bot；日誌 token 清理；舊 worker 三種群卡模式；舊結算發布者撤權後不投遞。

新增 **10 項 Chrome 案例**：協辦完整流程／職責取代／不添名單；結算人替換與其他 scope 保留；發起者交接／草稿入口；私人舊連結／登入／真實帳號綁定；穩定 ID 撤銷與未知撤銷恢復；未知邀請建立去重；owner 已變更、token 已消費的未知接受恢復；兩端版本衝突保稿重驗；儲存阻擋／損壞保全／360px；帳號切換／跨頁登出／延遲成功。

全套後端／領域／資料庫 **285 項、36 檔**及 Chrome **155 項**通過。strict TypeScript、建置、built API／SQLite／SPA smoke、既有 UI 生成及 166 項台帳檢查通過。schema 維持 **9**、**83** 張 user tables。前端約 **703 kB**，既有 500 kB 警告仍待效能收尾。

重現：`npm run test:rebuild`、`npm run build:rebuild`、`npm run test:e2e:rebuild`、`npm run test:build:rebuild`、`npm run check:ui`、`npm run check:capabilities`。

## 剩餘工作

E12／E13／E14 仍為 in_progress：需結合現場出席／完整結算與通知收件匣、全部舊 API 轉接、隔離正式資料副本及真實平台整體驗收。現場補錄、歷史／收件匣／待辦、分房／投票／結算／款項／圖片、音樂其餘功能與完整 TypeScript bot 持續實作。本批不等於 166 項或 B01–B15 完整通過；台帳仍 **0 項完整通過、release_eligible=false**。未部署、未更動正式 bot 或 main。
