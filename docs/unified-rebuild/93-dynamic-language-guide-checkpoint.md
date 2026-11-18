# 第八十七批實作：動態提示、原文保全與統一手冊

日期：2026-11-18（Asia/Taipei）。分支 `codex/unified-rebuild`。變更範圍 **`web`**，實際發布範圍 **`none`**。使用本機合成資料庫、隔離 Chrome context、mock QQ 與本機 Docker；未合入 main、未部署，未操作正式 bot、憑證、群政策或真實待送工作。

## 動態提示與錯誤邊界

在活動、成分、帳號、帳款、管理後臺及持久原稿的狀態、結果、恢復指引與標籤值宣告固定 `uiText` 邊界。首輪 66 檔／954 個宣告與錯誤顯示改動逐項核對，保留 map keys、分類協議值、條件、原請求、原稿、回執及使用者內容。加上手冊與其餘明確片段，最終編譯 **106 檔／3,906 個顯示邊界、162 個固定本機錯誤邊界**。

固定 `Error`、`DraftConflict` 與 `DraftExpired` 由建置工具附上預編譯簡／繁文字，使用 WeakMap 保存顯示對；`errorText` 只讀取顯示對，**不改寫 Error.message、物件、class、cause、stack、code 或 status**。邀請及 bot 重送的原回執核對仍使用 canonical message 比較；原稿過期仍保持原例外類型與帳號失效限制。未知例外、API 回應和帶使用者插值的訊息保持原文，不能以整串文字猜測系統來源。

`uiText` 仍只接受固定字面值；建置拒絕變數、整份 template 及重疊編譯邊界，避免外層錯誤與內層轉換互相覆蓋。瀏覽器沒有 OpenCC、全文 DOM 轉換或任意資料翻譯。必要錯誤／恢復提示保留，沒有增加裝飾性文案。

活動歷史原先會對任意欄位值套狀態表；現在只解讀已確認的狀態／權限欄位。標題、稱呼、費用規則與理由即使恰好是 `confirmed`、`waiting` 等字串，也原樣顯示。before／after 原始紀錄與資料庫不改動。

新增前端 bot 事件標籤表，只改顯示，保留全部 17 個共用鍵；`satisfies Record<BotKind,string>` 和原生測試核對鍵集合。共用 BOT_KINDS、預設及自訂模板、通知紀錄、模式、群識別及所有 bot 指令保持 canonical。

## 統一使用說明

新增 React／TSX `/guide`，按目前新介面及契約整理 **16 個操作章節、31 個實際路由連結**：帳號與入口、活動／時間投票、報名與特殊流程、管理／出席、包間／结算、實際收付、裝置、原稿／恢復、分享、QQ bot、成分／詞庫、同好／找搭子、成分分房試算、隱私與管理後臺。

- 說明連結位於「我的」，連同隱私、聯絡入口在 session 讀取失敗時仍可使用。沒有添加宣傳介紹、品牌段落或填版卡片；章節內文字只說明實際操作、條件、資料範圍及恢復方式。
- `/guide.html` 使用公開 React shell，保留原 `#section-1` 至 `#section-11` 連結，進入後開啟對應章節。無關 query 與未知舊 fragment 不傳入新版；開啟手冊或任務連結不授予權限、不送業務寫入。
- 手冊跟隨相同 Accept-Language。指令與 `{url}` 使用 `translate="no"`，ICP 原號碼保留。從目前 bot alias 宣告核對每個不同指令的文檔覆蓋，沒有在瀏覽器測試載入或啟動 worker。
- 修正舊手冊互相矛盾的通知敘述、舊選單位置、恢復時替換輸入的說法。群查詢與主動通知分開，模擬／未知投遞不能當作送出，重送須保留原紀錄，不補發歷史或自動重播。成分分享可以使用未保存原稿，推薦仍依已保存成分；私人留言與性別不放進分享圖。
- 手冊以獨立 chunk 載入；保留既有 PWA 固定資產預載策略，沒有宣稱 service worker 不會下載該 chunk。360px 的指令表保留足夠左欄宽度，避免沒有溢出卻逐字換行。

舊正式 `docs/user-guide.md`、`public/guide.html` 與其產生流程不覆寫，供現行系統及舊碼參考。這份新手冊只在重構候選程式中使用。隱私頁仍是先前版本的內容；統一成分處理用途、同意／版本銜接與全面政策驗收尚未完成。

## 隔離驗證

- strict TypeScript、React／API／bot build 通過。主 JS **1,458.29 kB／gzip 425.10 kB**，手冊 chunk **46.22 kB／gzip 15.89 kB**，CSS **123.35 kB／gzip 18.83 kB**，worker **4.30 kB**。既有主 bundle 過大警告仍在，不宣稱正式效能完成。
- **211 項原生測試（18 files）通過**：語言及 Error 身分／原文／重疊邊界、公開 shell／HEAD、手冊舊入口、實際 Python bot URL 生產者對照、帳號、活動歷史／查看授權、未完成操作、統計、bot 政策／回覆／outbox／runtime 等回歸。
- **424 個不同瀏覽器場景有通過結果**：先完成 385 個跨領域回歸，再完成手冊／語言／統計／auth／稱呼／分享／舊入口／PWA 的 71 場景集合，32 個重疊，不重複計數。手冊最後的欄寬及簡體斷言修正後，5 場景再次全數通過。
- 新語言場景確認簡體分類顯示及 `运动` 原請求值、混合字體輸入／重新載入、儲存失敗阻止 HTTP、歷史 user text 與狀態分開、本機 bot 錯誤回執維持 pending，以及雙分頁保全。跨領域回歸包含裝置、成分刪除與無 BroadcastChannel 的舊頁阻擋、群模擬／實送政策變更後的原回執恢復、帳務及結算、分房與分享。
- 舊斷言仍比對「後台／另一台／了解」，已核對實際繁體畫面並對齊「後臺／另一臺／瞭解」，保留原操作、資料及權限斷言。第一輪曾因此中止；不把中止結果算通過。新手冊測試的 ESM loader 無法直接載入 bot 的 domain JSON，改讀實際固定 alias 宣告，不更動產品 loader。簡體 `記帳` 的建置結果為「记帐」，斷言對齊實際字體，業務零寫入限制仍保留。
- 重新檢視 `test-results/unified-guide-mobile.png`：調整前左欄過窄，修正後章節／指令能閱讀、無水平溢出；加入欄寬下限檢查。這只是本機 Chrome 360px，不能代替實體裝置或 QQ WebView。
- compiled smoke 通過 API／SQLite／sharp、bounded room worker、原生 bot mock HTTP／WebSocket／ACK／Resume／不確定投遞／simulation／CLI／SIGTERM 及配對備份。公開 Umami 客戶端仍使用檢查點 91 固定檔案並攔截傳輸，不向正式統計服務送測試事件。

## 固定來源與剩餘工作

來源提交 `337f9978109b4e069b798bcd8196a4259c8e9a35`，tree `d30234373573bcc83e2bbbdcb7ac94b119f76de1`；乾淨工作目錄以 prepare-image 的 rehearsal 模式封存到 `/tmp/qgroup-image-337f9978109b4e069b798bcd8196a4259c8e9a35/context`。只使用此 archive，不上傳工作目錄、不合入 main、不執行正式發布。

本機 OrbStack arm64 engine 建置／模擬 linux/amd64，完整 image ID **`sha256:1a02b954fbea11384ea0de42b64561ae9aba187c22e4f82dbd5502dad30d67f4`**，Node base 為 `node:22.22.3-bookworm-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752`。映像內 strict build 與 production prune 通過。

Host verifier 對此固定映像完成 3 組語言 × 活動／guide／guide.html × GET／HEAD 共 18 個公開 shell 檢查，語言與 html 一致、HEAD 空 body、no-store／Vary／無 Cookie，以及手冊獨立 chunk 均通過。另通過來源版本、React／SQLite／sharp、零會員、UID/GID 994:992、readonly／移除 caps／no-new-privileges／network none、512 MiB／無額外 swap／1 CPU／128 PIDs 與 SIGTERM exit 0。此批的 host verifier 擴充不在運行映像中；映像來源仍固定為上述提交。

映像內 bot 只驗版本及合成健康，完整 mock runtime 另由 compiled smoke 驗證，沒有真實 QQ 連線／群投遞或線上版本組合驗收。驗證自行建立的容器及 volume 已移除；映像未發布或推至 registry。

166 IDs 保留，**166 項 in_progress、0 項 planned、0 項完整驗收，release_eligible=false**。這批完成已標註的動態提示與新手冊入口，沒有把 O08／O09 或任何其他功能標成完整驗收。剩餘工作包括其餘純顯示 arrays／helper／驗證片段、API 產生的通知／安排／結算／錯誤与插值邊界、統一用途政策／同意、來源資料對帳與遷移／回退、完整 B01–B15 與實際候選 web／bot 組合、效能及實體裝置／QQ WebView。不能用模擬投遞、欄位保留或映像健康取代 bot 功能與切換相容性；按使用者要求先不部署。
