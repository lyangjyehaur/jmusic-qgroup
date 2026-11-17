# 第二十一批實作：代報認領與付款責任保全

日期：2026-11-17（Asia/Taipei）。分支 `codex/unified-rebuild`。發布範圍 **`none`**：僅隔離開發、驗收及原始碼同步，未部署、未整合 main。身分、付款來源、名冊與 outbox 是跨服務契約，正式切換仍先按 **`both`** 驗證。

## 已實作

活動、報名管理與逐人名單連到同一個 React／TSX「代報認領」。原管理人或具 roster scope 的協辦可選擇穩定 attendee ID 發出認領連結，填寫原因；本人申請後，管理人核對實際申請人，再通過、拒絕或撤銷。既有主辦／協辦與網站管理員不混為同一種權限。

原生 TypeScript API：

- `GET /api/v2/activities/:id/claims`：目前可邀請的同行、逐人限制與付款名稱，以及此帳號作為當前管理人或申請人的認領紀錄。只有管理人能看到仍有效、尚未申請的 token。
- `POST /api/v2/activities/:id/claims`：精確 revision、attendee ID、原因及明確確認，建立 7 天 token；撤銷該人既有 invited／requested 邀請並在 audit 保留 superseded ID。
- `GET /api/v2/activities/:id/claims/preview/:token`：有限身分／付款預覽、目前狀態、本人重複與是否原 manager。沒有私人地點、安排、完整名單、歷史、圖片或帳務；只持有 token 不授活動存取。批准後僅原申請者可取得已認領的最小結果。
- `POST /api/v2/activities/:id/claims/preview/:token/request`：重驗原邀請人仍具管理權、有效期限、目前版本、本人重複及申請人不是原 manager；本人身分與保留付款責任須分別確認。
- `POST /api/v2/activities/:id/claims/:claimId`：當前 manager／roster scope、目前版本、期限、原因與明確確認。通過必須再次核對真實申請人，並重查申請後是否另有本人報名。

舊 `/?event=…&claim=…` 轉到新版認領頁，保留登入返回位置；開啟連結不自動申請或批准。

## 身分與付款保全

未綁會員的正式、個別候補及個別待確認可以認領；整組候補／待確認必須先協調排隊。歸檔阻擋認領，但已實際結束、取消或已有結算仍可核對歷史身分；不錯套一般名冊寫入鎖。

申請不授予活動 access，不提前改 attendee.user_id／manager_id，也不按同名、QQ 或成分稱呼合併。申請通知送原 manager，若 owner 不同也送 owner，去重後各一筆。

批准只改 attendee 的 user_id、manager_id、updated_at，保留 attendee ID、seq、party ID、party seq／manager、報名狀態、備註、同意版本與逐人 consent、出席、原帳單、收據、收款碼、款項申報／動作及不可變帳本。付款來源追加進既有 append-only `attendee_payment_origins`：

- 原 manager 付款：固定原 manager 的 `account:sha256(eventId:managerId)[0:16]`、名稱與 payer_user_id，認領人不取得這筆責任。
- 原參加者本人付款：固定原 `person:attendeeId` 與原稱呼，認領者取得此責任，原 manager 不再持有。

批准後才授予活動 access，成分浮層改用真正認領者的 user_id；未審核時仍顯示未關聯，不借原 manager 的偏好。既有付款來源保護使一般報名表單無法改掉原責任。

## 交易、恢復與 bot

所有寫入使用 immediate 交易。必要付款來源、存取、audit、通知、claim 狀態與 request receipt 失敗全部回滾；不留半套身分移轉。站內通知保留業務內容，bot 私人 payload 只保留原版泛化提示與活動連結，不放姓名、原因、金額或 token。認領不產生新增報名／遞補群卡；每次 audit 仍保留舊版關閉公開群同步時作廢待送群卡的行為。

表單在發送前保存 scoped 原 key 與完整 payload；儲存失敗不發送。未知建立、申請或批准可跨重整沿用原操作，確認勾選不持久化。版本衝突保留原因，明確重讀後重新核對身分。

批准會使原 manager 失去管理權，因此已完成批准的同帳號、同 key／payload 收據允許確認原操作的最小結果（event ID、revision、claim ID），仍重驗目前活動存取；不回傳 token，不授權新的處理。新的決定仍必須當前管理權，原 manager 不可藉回放重新批准。已完成申請只允許原 requester 確認其最小收據，不藉此取得私人活動內容。邀請建立回放仍重驗當前 roster／manager 權限。

損壞原稿先保全 recovery 副本。跨帳號拒絕原 scope，跨頁登出清除認領原稿；延遲成功不能恢復私人資料。

保留的 Python worker 目前仍會將未綁定私人投遞標記為 skipped（原版行為）；本批隔離測試確認不誤轉發到群，也不二次處理。這不代表已新增私人 QQ 真送能力。

## 驗收

新增 **15 項後端案例**：七日期限與 supersede；私人有限預覽／申請／批准；兩種付款來源與已結算歷史／圖片完整保全；拒絕／撤銷及原 issuer 撤權；明確確認／原因／版本／角色；申請與批准兩階段重複本人檢查；候補隊序與整組／歸檔／已關聯／退出限制；到期與 token 可見性；移轉管理權後最小收據恢復；並行不同申請人與去重通知；必要失敗原子恢復／optional bot；批准前後成分身分；原 Python worker 的私人投遞保護；協辦 roster scope 撤權與回放。

Python 差分比較 events／attendees／parties／consents／audit／notifications／outbox／access／claims／payment origins，以及 settlements／history／details／receipt BLOB／finance entries／reports／actions／code and receipt image references。隨機 ID／token 正規化，保留實際隊序。另以舊 Python finance／settlement 讀取新版批准後資料，確認兩種付款 ID 與權利歸屬仍正確。

新增 **9 項 Chrome 案例**：兩種付款同行的完整邀請／申請／批准／返回活動；私人舊連結／未審無 access；拒絕／重邀／撤銷；未知邀請與申請；批准失去管理權後未知結果恢復；版本衝突保稿重驗；重複本人／儲存失敗／損壞保全／360px；帳號切換／跨頁登出／延遲回應。

全套後端／領域／資料庫 **268 項、35 檔**及 Chrome **145 項**通過。strict TypeScript、建置、built API／SQLite／SPA smoke、既有 UI 生成與 166 項台帳檢查通過。schema 維持 **9**、**83** 張 user tables。前端約 **684 kB**，既有 500 kB 警告待效能收尾。

重現：`npm run test:rebuild`、`npm run build:rebuild`、`npm run test:e2e:rebuild`、`npm run test:build:rebuild`、`npm run check:ui`、`npm run check:capabilities`。

## 剩餘工作

R10／R11 仍記 in_progress：新結算／款項操作全流程、全部舊 API 轉接、正式資料副本及真實平台驗收待完成。管理交接／協辦接受、現場補錄、歷史／收件匣／待辦、結算／分房／投票／音樂剩餘功能、完整 TS bot 仍待實作。本批不等於 166 項或 B01–B15 全部通過；台帳仍 **0 項完整通過、release_eligible=false**。
