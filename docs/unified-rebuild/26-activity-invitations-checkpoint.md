# 第二十批實作：補報名邀請與本人接受

日期：2026-11-17（Asia/Taipei）。分支 `codex/unified-rebuild`。發布範圍 **`none`**：僅隔離開發、驗收與原始碼同步，未部署、未整合 main。名冊、同意與 outbox 涉及跨服務契約，正式切換仍先按 **`both`** 驗證。

## 已實作

活動與報名頁連到同一個 React／TSX 補報名邀請頁。名單管理者可一次建立 1–20 位受邀者，填寫稱呼、公開備註及原因；每人各一個一次性連結。現有受邀者可透過穩定 attendee ID 選取、修改或撤銷。原邀請 manager 即使失去 roster scope，仍只能看自己管理的邀請；新增邀請必須具備當前 roster scope，網站管理員身分不能替代。

原生 TypeScript API：

- `GET /api/v2/activities/:id/invitations`：目前帳號有權管理的未接受邀請、連結及是否可新增；必須通過活動存取。
- `POST /api/v2/activities/:id/invitations`：精確 revision、原因、明確確認、批量上限；交易內追加 invited attendee 與一次 audit。
- `GET /api/v2/activities/:id/invitations/:token`：可在未取得私人活動存取前讀取有限預覽，僅含受邀稱呼、活動標題、當時安排、目前分配與阻擋原因；不回傳完整名單、其他邀請、公開備註、管理人或歷史。
- `POST /api/v2/activities/:id/invitations/:token/accept`：本人帳號、精確 revision／conditions version、明確接受目前安排及候補。原 token 消耗後，同帳號同 key／payload 的已完成操作仍可安全重試；重驗目前 attendee 身分與管理關聯。

舊 `/?event=…&attendee_invite=…` 入口轉到新版受邀者頁，保留 token 與登入後返回位置，開啟連結不自動提交操作。API 請求日誌遮蔽 invitations／claims 路徑中的 token。

## 保留的隊序與交易規則

建立邀請不占名額、不建立 party／consent、不授予私人活動存取，也不發出「有人報名」群通知。付款欄位預設沿用舊版的 self，邀請中的 payer 輸入不改變這個預設。

接受時保留原 attendee ID 與備註，將本人身分與 manager 交給接受帳號，另取 individual party 新隊序，寫入當前條件 consent 並授予活動 access。同名不合併；已有有效本人報名者不能再接受。已撤銷或已使用 token 不能建立另一筆報名。

實際開放報名時維持嚴格 FIFO，前方整組候補仍會阻擋新接受者；暫停／截止／實際開始後按目前剩餘名額分配，不擅自遞補前方候補。這是舊版補報名的刻意例外。額滿必須獨立接受候補；不能用接受費用的勾選代替。草稿、結束、取消、歸檔與結算鎖保留。

immediate 交易內處理版本、邀請、本人重複及名額。必要 attendee／party／consent／access／audit／request_results 失敗整筆回滾。bot hook 使用 savepoint，失敗不留下部分工作，也不回滾已完成的業務操作。

## 恢復與 bot 相容性

兩種表單在寫入前保存完整原 key、payload 與當時 revision；儲存失敗不發送。未知結果鎖定輸入，重整後沿用原操作；即使 token 預覽因已接受而 404，仍顯示原操作的安全重試入口。修改輸入、重讀安排或重新分配時重設確認；不跨重整保留勾選。損壞原稿先保全 recovery 副本；跨帳號拒絕舊 scope，跨頁登出清除原稿，延遲回應不能恢復私人輸入。

接受邀請沿用 `invitation_accepted` 的最終名單 delta，產生原格式 `registration_added` 群卡。邀請與 token 不放進 bot payload；保留原來的模板／鍵盤／泛化入口。未修改 Python bot 或正式資料。

## 驗收

新增 **10 項後端案例**：批量邀請、私人活動有限預覽與 access、開放 FIFO／關閉剩餘名額、候補獨立確認與原 attendee／note、輸入與權限、重複本人／撤銷／終態／結算、已完成操作回放與撤權、並行單次接受、必要失敗原子回滾與 optional bot、舊 Python worker 消費。差分比對 event／attendee／party／consent／audit／notification／outbox／access／finance／payment origin；隨機 ID 與 token 正規化後比較。原 worker 以無網路 Mock transport 驗證普通、富文字與 dry-run，第二輪無重播。

新增 **8 項 Chrome 案例**：批量逐人邀請與接受、私人舊連結與登入、候補確認／安排改版、未知新增恢復、token 已消耗後未知接受恢復、穩定 ID 撤銷、儲存失敗／損壞保全／360px 版面、切換帳號／跨頁登出與延遲成功。

全套後端／領域／資料庫 **253 項、34 檔**及 Chrome **136 項**通過。strict TypeScript、建置、built API／SQLite／SPA smoke、既有 UI 生成及 166 項台帳檢查通過。schema 維持 **9**、**83** 張 user tables。前端約 **666 kB**，既有 500 kB 警告待效能收尾。

重現：`npm run test:rebuild`、`npm run build:rebuild`、`npm run test:e2e:rebuild`、`npm run test:build:rebuild`、`npm run check:ui`、`npm run check:capabilities`。

## 剩餘工作

R09 仍記 in_progress。全部舊 API 相容轉接、正式資料副本與實際平台驗收待完成；代報認領／付款責任來源建立、管理交接、現場補錄、歷史／收件匣／待辦、結算／分房／投票／音樂剩餘功能與完整 TS worker 仍待實作。本批合成測試不等於真 QQ 或 B01–B15 全部驗收。台帳仍 **0 項完整通過、release_eligible=false**。
