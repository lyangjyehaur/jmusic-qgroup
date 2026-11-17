# 第五十六批實作：統一 PWA 與舊離線元件退役

日期：2026-11-18（Asia/Taipei）。分支 `codex/unified-rebuild`。變更範圍 **`web`**，實際發布範圍 **`none`**。本批只調整原生網站的安裝、靜態檔案及更新流程，不改 schema、業務資料契約、outbox、bot 設定或 worker。保留 Python bot；未合入 main、未推送、未部署，未接觸正式服務、憑證、群設定或待送工作。正式實際版本組合仍待驗收，本批不構成單邊發布核准。

## 同一個安裝身分與原生更新入口

「我的 → 應用程式」提供安裝、檢查更新、啟用已下載版本與手動重新載入。全站只在離線、有更新或舊元件仍待退役時顯示操作提示，不加入介紹或宣傳文案。瀏覽器未提供安裝事件時顯示選單指引，不假設各平台都有安裝按鈕。

原生 `/manifest.webmanifest` 與舊 `/music/manifest.json` 回傳同一份設定：穩定 `id=/music/index.html`、`start_url=/activities`、全站 scope `/`。舊 manifest 沒有明確 id，原 start URL 正是 `/music/index.html`；因此沿用其安裝身分，不因重構產生另一個應用程式 id。新的 SVG 圖示及 192／512 PNG 由原生建置產生，未匯入舊前端 runtime。兩個 worker 與兩份 manifest 均使用正確 MIME、`Cache-Control: no-store`。

Vite plugin 依 bundle、HTML、worker 與圖示來源、plugin 及鎖定依賴計算 SHA-256，注入頁面建置版本並獨立編譯 TypeScript worker。Vite 設定的相對 TS import 已明列副檔名，不再留下 native config loader 的副檔名警告；既有大 chunk 警告仍在。

## 快取與更新的資料邊界

根 worker 只預存明確列出的靜態資源與圖示，另記錄由它保管的舊快取名稱；不保存 HTML、API、登入導覽、session、活動、圖片憑證或帳號內容。`/api/`、`/auth/`、`/music/api`、非 GET 及跨 origin 請求不攔截。導航一律連網讀取，離線時只回傳不含個資的 503 恢復頁，不從其他應用程式的快取尋找回應。

新版本下載完成後等待使用者明確啟用，先以 MessageChannel 核對等待中 worker 的建置版本。啟用不重載任何頁面，`controllerchange` 只回報頁面版本；重新載入是另一個明確動作，原表單的未保存提示仍有效。現有草稿仍依原本機制保存，**本批沒有完成 IndexedDB 草稿持久化或舊草稿遷移**。

每個仍受控的視窗都明確回報目前版本後，才清理舊原生快取；未知、背景或舊版本頁面都阻止清理。舊頁面需要的 hashed 靜態分塊仍可從精確原生 namespace 讀取，不讀取其他應用快取。worker 重新啟動後採保守判定，等待頁面再次回報。

清理候選名單在新版啟用時保存，不在每次清理時掃描所有版本。驗證發現，後一種寫法會讓仍啟用的舊 worker 刪掉正在安裝或等待中的新版快取；現已修正並加入等待中快取保全斷言。下載語法錯誤或預存中斷會保留原活動版本、清除半成品並顯示可重試提示；已成功安裝但被更新版取代的 waiting worker 不誤報成下載失敗。

## 舊成分站退役

只識別同 origin、scope 恰為 `/music/`、script 恰為 `/music/sw.js` 且無 query 的舊註冊。原網址提供獨立的退役 worker，不呼叫 `skipWaiting`、`clients.claim` 或頁面導航；等舊受控視窗全部關閉後自然啟用，只清除 `qgroup-music-` namespace，再取消自己的註冊。其他 scope、快取、偏好及瀏覽器草稿均保留。

這個等待不能省略：既有成分站在 `controllerchange` 時直接 `location.reload()`，強制接管會觸發舊頁的自動重載。瀏覽器驗證直接載入原 `music_site/public/sw.js`，並在合成舊頁重現該重載監聽，確認等待期間沒有 controllerchange、沒有重載、原分頁草稿仍在；關閉最後舊頁後才移除精確舊註冊與其快取。

## 驗證與剩餘工作

PWA spec 使用真實 Chromium worker 與隔離的本機合成更新主機，最終 **9 項通過**，覆蓋 manifest 身分與 PNG 尺寸、離線與私密快取隔離、多視窗／編輯草稿、舊靜態分塊、舊 worker 自然退役、無效下載、預存中斷、waiting 版本被取代，以及新開分頁啟用既有 waiting 版本後正確清除控制項。另測根 worker 啟用下的完整合成 QQ 回調、bot 網站連結與成分保存；未做真實 QQ 授權或投遞。360 px 手機畫面檢查無水平溢出，安裝設定只有實際操作與必要提示。

四份相關業務 spec（account-profile、activity-publish、appearance、legacy-navigation）**36 項通過**，加上最終 PWA 的 9 項，共 **45 個不同瀏覽器場景**。strict TypeScript、原生網站／API／bot 建置、建置後 smoke 與能力台帳檢查通過；built smoke 另核對兩份 manifest、worker MIME／no-store、頁面 SHA-256 及實際 PNG 解碼尺寸。最終前端 bundle **1,181.40 kB／gzip 344.34 kB**，仍須後續拆包。

回歸中另外找到 bot WAL 寫入競爭，修正與可重現的測試另見 [63 號檢查點](63-bot-sqlite-locking-checkpoint.md)。修正後完整原生 **93 檔／805 項**、保留 Python bot **311 項**、時間投票 bot **15 項**與三語 bot 連結均通過；這些仍是隔離資料及合成平台驗證。

其他業務瀏覽器 spec 預設停用 worker，維持既有 page routing 對遺失回應與合成 OAuth 的攔截；PWA spec 明確啟用 worker。沒有將攔截器繞過造成的失敗當作業務驗收通過。回歸時亦修正上一批遺留的舊導航斷言：join／manage 等已進各自原生流程，不再期待已淘汰的 `?task=` 詳情頁。

本批不代表手機實機安裝、既有正式安裝者的瀏覽器升級、全平台／語系、IndexedDB 寫失敗及完整草稿遷移已通過。C06、O02／O03 的證據持續累積；仍保持 **166 項保留、0 項完整驗收、release_eligible=false**。不得據此正式切換或退役 Python bot。
