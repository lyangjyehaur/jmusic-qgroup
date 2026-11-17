# 第二十四批實作：統一收件匣與活動歷史

日期：2026-11-17（Asia/Taipei）。分支 `codex/unified-rebuild`。發布範圍 **`none`**：隔離實作、測試與原始碼同步；未部署、未整合 main。bot 網址及共用通知／finance 為跨服務依賴，正式切換仍先按 **`both`** 驗證。

## 新入口與 API

React／TSX 的 `/inbox` 將目前待辦、站內通知及本分頁未確認操作放在同一處。待辦按活動集中顯示，避免每項重複活動名稱；沒有未完成操作時僅保留檢查按鈕，不佔空狀態卡片。全站頂部顯示收件匣與未讀數，「我的」也有入口。活動詳情另連到 `/activities/:id/history`，不匯入舊 controller 或 UI。

原生 TypeScript API：

- `GET /api/v2/activities/:id/history?before=…`：先核對活動存取，公開活動可匿名查看；每頁 50 筆，獨占數字 cursor。
- `GET /api/v2/me/notifications?before=…`：目前帳號的通知，每頁 100 筆，回全部可見未讀總數及下一頁。新增分頁，舊資料不只保留前 100 筆。
- `GET /api/v2/me/notifications/count`：全站未讀數。
- `POST /api/v2/me/notifications/read`：最多 100 個通知 ID，僅更新本人通知，保留首次 read_at；UUID 與精確 payload 收據用於未知結果恢復。
- `GET /api/v2/me/todos?event=…`：按目前資料、權限與時間重新推導十類待辦；可按活動篩選。
- `GET /api/v2/me/operations/:key`：僅回目前帳號該操作編號是否存在回執，不回放快取業務結果、不提供舊權限。

新 API 的歷史／通知 ID 以十進位字串傳送，SQL 仍以整數排序及比較，不依字串排序；歷史 cutoff 延續來源的 1–18 位規則。個人 API 要求會員與 X-Account-Scope，訪客由頁面引導登入；與舊匿名通知 API 回空陣列的 wire 行為不同。寫入另要求同源、CSRF 與操作編號，沒有新增資料表或修改共用 schema。

## 可見歷史與隱私

保留操作者名稱、時間、動作、版本、原因、修改前後快照及追加式儲存。介面顯示安排差異、報名者／出席／條件接受／付款辨識、分工、包間與結算／帳務狀態；載入更早歷史失敗時保留已載入內容，可重試原 cursor。

存取規則與原活動一致：邀請活動須有 event_access，草稿須有活動 scope，deleted 不可見。網站管理員不自動取得私人活動入口。

來源快照本身已排除邀請 token。新版額外按已知業務欄位篩選匯入 JSON，不直接序列化任意儲存物件；排除 actor_id、帳號內部 ID、token、PIN、secret 等非公開欄位。finance_report／finance_reject／finance_withdraw 無條件只保留帳務狀態及操作／申報識別，移除申報 transaction 與 reason，即使不良匯入帶有私密文字也不公開。已確認帳本操作仍保留公開金額與交易依據。來源資料不完整／JSON 損壞時顯示讀取錯誤，不回假空歷史。

歷史、通知與其他私人 query 均按會員 scope 隔離；帳號切換、跨頁登出和延遲回應不恢復前一帳號的內容。

## 十類動態待辦

延續原 boardTodos：確認變更安排、核對報名認領、處理退出申請、決定成團、確認結束／延長、發布結算、款項申報核對、本人待補款、本人待退款／墊付收回、收退款核對與結清。

待辦由當前管理 scope、逐人 manager／confirmation_state、claim 狀態／到期、withdrawal_requested、成團門檻／deadline、實際 lifecycle／預計結束、settlement 與 finance 推導。已讀只改通知；不修改 consent、claim、roster、款項或待辦，不因看到頁面就完成工作。重新讀取／定時刷新後再按最新狀態顯示；讀取失敗顯示可重試錯誤，不把舊快取或失敗說成「沒有待辦」。

私人通知由收件人擁有，保留來源規則：活動後來不再對該帳號開放時，既有本人通知仍可讀；點活動連結另做目前存取驗證。deleted 活動的通知不列入清單或未讀總數。他人通知 ID 不影響他人的 read_at，首次已讀時間不被重試覆寫。

## 原生帳務讀模型

`finance-projection.ts` 用整數分原生重建既有 journal 投影，無 Python runtime 呼叫。保留 collection、refund、reimbursement、expense、merchant_refund、deposit、deposit_return、deposit_apply、credit_transfer、cash_transfer、reversal，以及 close／reopen 的讀取語意。核對負額、保管資金、先後引用、剩餘訂金／支出與資金守恆，損壞記錄報錯，不靜默消除付款待辦。

只取 settlement_history 的最新實際版及同版 detail，舊式無 detail 帳單不猜個人分攤。本人鍵為活動內 account hash，加已認領且 claimant_owns 的不可變原付款鍵；管理未綁定且 self payer 的同行，不會把同行欠款當作管理人的本人欠款。同名不合併。包間各自投影與計算正負額，同一帳號可同時待補款和待退款，禁止跨房抵銷。close 須為最後一筆、對應最新 bill_version 且無未審申報。

這是供收件匣使用的讀模型，**尚未完成完整結算／款項寫入與操作頁**。相關待辦仍保留並連到同一活動目前的 settlement／finance task，活動頁會明確顯示尚未提供分房與結算；不把這些入口算作完成財務能力。後續完整帳本會沿用此讀模型。

## 未確認操作與恢復

清單掃描目前帳號在本分頁的現有原稿：成分選擇／欄位／QQ、找回、稱呼、活動草稿／安排／報名／條件／狀態／補邀／認領／分工／出席、管理審查／關聯／角色／口令及資料刪除。

只呈現固定功能名稱及原表單應用程式路徑，不顯示 payload、稱呼、私人備註、PIN、刪除 secret 或任意儲存 URL。其他帳號、純未送出原稿、device authorization 和 `:recovery:` 保全副本不冒充未知操作；可辨識的損壞原稿保留原頁保全入口。無法辨識帳號的損壞全域刪除紀錄只顯示保全入口，不假定為本人已授權刪除。

支援 request_results 的原操作可手動查有無回執；查到回執也須回原頁核對精確內容與目前權限，清單不清除原稿、不盲目重送。找回／管理 PIN／刪除等獨立收據流程回各自原頁核對。管理權限仍由原頁重新驗證，清單不恢復已失效的管理 scope。

通知已讀採明確點擊，不沿用舊 modal 開啟即自動已讀。開啟、切換篩選、刷新與查回執均不寫業務。送出已讀前先持久化原 ID 清單與 UUID；重整後須明確確認同一操作。儲存失敗不送出，損壞原稿先保全；登出清除本分頁已讀操作，延遲結果不能補回。

## bot 相容性與驗證

保留 Python bot。實際 `replies.answer` 的 `/待办` 仍只回公開活動狀態、聲明不是個人待辦，連到 `/?event=…&action=todos`；新版安全轉到活動篩選的收件匣，未登入保留登入返回，開啟不自動提交。既有 `action=attendance` 與 `onsite` 都進出席頁。

測試在合成資料庫產生新版群卡，核對收件匣讀取與已讀完全保留原 outbox，隨後由保留的 Python OutboxWorker 消費一次且不重播。平台 API 使用 Mock，沒有連正式 QQ、憑證、群設定或真實待送工作。另對照 Python finance.summary 的個人金額、包間、權限及申報數；所有 journal 種類與逐筆前綴對照 Python finance.project。

新增 **32 項後端／讀模型／原稿清單案例**及 **10 項 Chrome 案例**。後端測試涵蓋可見歷史與游標／數字排序／私密欄位、十類動態待辦、收件人與首次已讀、精確收據／回滾、資料損壞、包間不可抵銷／原付款責任、來源差分及保留 worker。Chrome 涵蓋同一收件匣／歷史、兩種分頁、已讀不消待辦、未知結果精確恢復、儲存阻擋、損壞保全、原表單恢復、範圍隔離、舊 bot 入口、網路錯誤、跨頁登出／延遲回應與 360px。

全套後端／領域／資料庫 **331 項、41 檔**及 Chrome **173 項**通過；收尾調整收件匣資訊密度後，重新建置並重跑相關 **10 項** Chrome 全數通過。strict TypeScript、建置、built API／SQLite／SPA smoke、既有 UI 生成及 166 項台帳檢查通過。schema 維持 **9**、**83** 張 user tables，前端約 **741 kB**，既有 500 kB 警告仍待效能收尾。重現：`npm run test:rebuild`、`npm run build:rebuild`、`npm run test:e2e:rebuild`、`npm run test:build:rebuild`、`npm run check:ui`、`npm run check:capabilities`。

## 剩餘工作

E17／O07 維持 in_progress。歷史需與完整結算／帳本／分房及全部舊入口成套驗收；財務待辦目前有原生推導，完整處理頁與寫入仍待後續批次。全部 166 項、B01–B15、正式副本遷移、混合版本與真平台驗收仍未完成，完整 TS worker 也未接替 Python。台帳 **0 項完整通過、release_eligible=false**；不允許正式切換，本批不部署。
