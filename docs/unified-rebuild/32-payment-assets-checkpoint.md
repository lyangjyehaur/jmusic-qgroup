# 第二十六批實作：私人收款碼庫與結算原圖

日期：2026-11-17（Asia/Taipei）。分支 `codex/unified-rebuild`。發布範圍 **`none`**：只在隔離環境實作、測試與同步原始碼，未部署、未整合 main。結算圖片與舊 bot 共用儲存及凍結引用，正式切換仍須按 **`both`** 驗證，保留 Python bot。

## 可操作入口

- `/me/payment-codes`：從「我的」或帳號進入，新增微信／支付寶／其他收款碼、圖片預覽、原圖檢視與下載、確認後封存、錯誤重試。名稱最多 40 個 Unicode 字元，單一帳號最多 30 張未封存圖片；相同種類、名稱與圖片不重複新增。
- `/activities/:id/settlement/images?version=…`：從收付款帳本進入，按版本查看已發布收款碼與消費憑證。每批 50 個版本，可續載及重試；選版不改帳、不記款、不觸發 bot。新版未附圖片時明確顯示原因，不代入舊圖。
- 原發布者可從自己發布的任一歷史版，明確帶入原版收款碼，另存到本人碼庫。後續換收款人不改寫舊圖，也不讓另一位結算人拿自己的身分重用原發布者的碼。

表單保留必要欄位、限制、權限、操作結果與恢復提示，沒有額外宣傳或裝飾文案。原圖讀取後在頁面內檢視／下載，下載位元組與伺服器保存的 PNG 相同。碼庫封存不刪除已發布帳單的引用；新版本移除收款碼也不影響舊版。

## 原生 API 與相容儲存

新增 `payment-assets.ts` 共用 Zod 契約、TypeScript `payment-media.ts` 與 `payment-codes.ts`，執行時不呼叫 Python。

- `GET/POST /api/v2/me/payment-codes`、`DELETE /api/v2/me/payment-codes/:codeId`、`GET /api/v2/me/payment-codes/:codeId/image`。
- `GET /api/v2/activities/:id/settlement/asset-versions?before=…` 與 `GET …/settlement/history/:version/assets`，回明確的版本／圖片欄位，不公開 digest、內部帳號 ID、任意 snapshot JSON 或磁碟路徑。
- 依活動權限讀取版本收款碼、第一張碼、最新一版碼及逐項消費憑證。保留 `/api/events/:id/…` 舊圖片入口，讓既有凍結網址能繼續讀取；原生頁面使用 v2 入口。
- 提供結算預覽／發布後續共用的 `resolvePaymentCodes`、`resolveSettlementReceipt`、`attachPaymentCodes`，驗證每種方式最多一張、合計最多三張、本人碼庫、同活動歷史憑證、原發布者與不可引用將來版本。正式發布路由尚未在本批接上，不能把共用函式當作完整結算發布驗收。

沿用 `image_assets`、`user_payment_codes`、`settlement_code_images`、`settlement_receipt_images` 與原追加式保護，不修改 schema。保留舊 `settlement_history.qr_image` 與 `settlement_receipts.image` BLOB 讀取；新增圖片只寫既有私有內容定址目錄與引用。

PNG 驗證保留來源規則：最多 2 MB、長寬 1–1600、正確檔頭與 IHDR、逐 chunk 範圍／CRC、至少一個 IDAT、IEND 與精確 EOF。最大合法圖片可通過 3 MB JSON route body 上限；超量或錯誤格式不建立引用。前端接受 PNG／JPEG／WebP，原檔最多 15 MB，瀏覽器內轉 PNG、白底、最長邊 1600，必要時逐次縮小至 2 MB。圖片解碼使用現有 CSP 允許的 data URL；沒有放寬 CSP 或由伺服器抓外部網址。

寫入在 SQLite immediate writer lock 內先確保檔案完整落盤，再提交參照；暫存檔、檔案及父目錄有同步與完整性檢查。拒絕圖片目錄／檔案符號連結。必要回執寫入失敗會回滾碼庫、image metadata 與回執；已落盤的孤立檔不公開，現有 prune 可清理。缺檔或摘要不符回 503，可恢復原檔後重試，不回假圖片或空結果。

## 權限與操作恢復

私人碼庫與圖片必須是本人有效會員、匹配 account scope；管理員不自動取得他人的碼庫或私人活動。公開活動原圖可匿名讀取；私人／草稿／移除活動沿用目前存取政策，撤銷 access 即停止讀取。v2 帶 session 的讀取須匹配 scope，不把失效的私人請求降級成匿名。舊圖片網址依當前 cookie 與活動權限讀取，若帶 scope 也必須驗證。

新增與封存須同源、CSRF、scope、UUID 及明確操作。即使回放已成功回執，也先驗證目前帳號與來源結算發布者；相同 UUID 不可換內容。回執只保留結果與請求 hash，不保存圖片原文。可封存同一張碼一次，精確重試回原結果，不會把封存碼重新啟用。

碼庫草稿與待確認操作保存於 `qgroup:rebuild:payment-codes:v1:<scope>`。送出前保存原圖與精確 UUID；保存時只留一份圖片，避免同一張 2 MB PNG 因表單與 pending 重複佔用配額。未知結果會鎖住原操作，經重整後仍須明確按「確認操作結果」；開頁、收件匣或重新登入不自動重送。

儲存被拒時不提交；損壞原稿先保全到 recovery key 才能重新編輯。收件匣的未完成操作只列固定入口及編號，不展示圖像、付款資料或任意儲存網址。帳號切換隔離 query、圖片請求與原稿；圖片讀取中會 abort／忽略已卸載頁面的回應。跨頁帳號刷新立即移除前帳號圖片，裝置登出清除相關原稿與 recovery 副本。

## bot 與驗證邊界

本批沒有更換 worker，沒有新增真實投遞。測試核對碼庫新增／封存不改 events、名冊、帳本、結算版本／引用、notifications、event_audit 或 bot_outbox。保留的 Python `media`／`payment_codes` 能讀新版檔案、metadata、凍結碼與憑證；原生 API 也能讀 Python 新建的碼及原 BLOB。PNG 邊界與破損案例與 Python 驗證器差分比較。這些是儲存與讀取相容證據，**不是全部 bot 功能或正式圖片投遞驗收**。

新增 16 項後端案例與 8 項 Chrome 案例。涵蓋圖片上限與格式、所有方式、Unicode 名稱、碼庫上限、內容去重、精確回執、來源身分、封存保留舊圖、版本分頁、私人權限、舊 BLOB／網址、缺檔恢復、原子回滾與孤立檔清理、符號連結拒絕、並行重試、Python 雙向相容、原圖下載、儲存拒絕、損壞保全、跨頁帳號切換／登出及 360px。

完整後端／領域／資料庫 **363 項、43 檔**與完整 Chrome **191 項**全部通過。strict TypeScript、正式格式建置、built API／SQLite／SPA smoke、既有 UI 生成檢查、Git whitespace 與能力台帳檢查通過。最後全套後端曾因差分測試的多 MB stdin 管道卡住而中止；測試改用隔離 JSON 檔及有界子程序後，重新完整跑完 363 項，不調高測試 timeout。前端約 791 kB，既有 500 kB bundle 警告仍待效能收尾；schema 維持 9、83 張 user tables。重現：`npm run test:rebuild -- --maxWorkers=2`、`npm run build:rebuild`、`npm run test:e2e:rebuild`、`npm run test:build:rebuild`、`npm run check:ui`、`npm run check:capabilities`。

166 個能力 ID 保留，S10／S11 維持 **in_progress**，0 項完整接受、`release_eligible=false`。完整逐人結算編輯器、消費憑證上傳與每版總量限制、新帳單的原子發布／實際店家付款、分房與財務交互、完整 TS worker、正式副本遷移及 B01–B15 成套驗收仍待完成；不允許正式切換。
