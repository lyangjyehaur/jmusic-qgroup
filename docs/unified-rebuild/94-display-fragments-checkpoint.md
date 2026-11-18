# 第八十八批實作：固定顯示片段與原文插值

日期：2026-11-18（Asia/Taipei）。分支 `codex/unified-rebuild`。變更範圍 **`web`**，實際發布範圍 **`none`**。只使用本機合成資料庫、隔離瀏覽器及 mock QQ；未合入 main、未部署，未操作正式 bot、憑證、群政策或真實待送工作。

## 選單、提示及分享

補上活動篩選、成分熟悉度、管理詞條操作、刪除範圍、付款方式、分房狀態與統計標籤的固定 `uiText` 邊界，以及共用存取提示、讀取失敗、投票確認和複製結果。原選項值、數值 level、路由、請求與條件保留；分類如 `运动`、`领域`、`歌手` 仍提交原協議值。

活動摘要、成分／分房分享圖及複製內容只轉換固定標籤。姓名、標題、詞條、地點、費用規則、說明、QQ、ID 和網址原樣保留；金額與時間沿用既有格式及原資料。未保存成分仍以目前原稿產生分享，沒有自動保存或改用已保存選項。

13 個帶插值的顯示 template 改為在原生 template 內宣告固定片段；保留原插值順序及 JavaScript 字串轉換語意。沒有整串翻譯或使用新的 template tag。原生驗證涵蓋帶副作用的求值順序、物件的 string hint、0、null、undefined、Symbol 拒絕及巢狀片段；未標註 template、第三方 tag 與 `translate="no"` 保持原狀。

活動連結欄位原以 `label === '活動連結'` 決定高度，簡體 label 無法符合。現在由呼叫端明確指定 3 行，摘要保持 10 行；顯示文字不再控制欄位行為。

## 本機錯誤及資料保全

一般 API、管理下載及收款圖片讀取的三個固定 `ApiError` 退路，由既有 WeakMap 顯示對處理。保留原例外、canonical `.message`、status、code、class 和原分支語意；合法 API 錯誤回應保持伺服器原文。帳務載入、收件匣與舊稿轉換的呈現改用 `errorText`，不更動保全內容或原回執比較。

特別保留仍參與分類／轉換判斷的舊草稿 label、原封存 reason、轉換 notes 及表單預設名稱。這些資料不能在 writer 內套顯示轉換；本批沒有把它們改成語言相關的持久內容。通知與 bot 模板、共用 BOT_KINDS、指令與別名、outbox、schema、簽章及去重鍵均未改動。

對首批 42 檔／177 處宣告進行 AST 核對：移除 `uiText` 並合併原生 template 的固定片段後，資料結構與原條件沒有非預期差異；六檔的 errorText 呈現／複製欄位設定另行核對。最終編譯為 **107 檔／4,092 個顯示邊界、165 個固定本機錯誤邊界**。這是已標註的範圍，不能宣稱全站訊息已完成簡繁驗收。

## 隔離驗證

- strict TypeScript、React／API／bot production build 通過。主 JS **1,462.83 kB／gzip 426.17 kB**，手冊 chunk **46.22 kB／gzip 15.90 kB**，CSS **123.35 kB／gzip 18.83 kB**，worker **4.30 kB**。主 bundle 的既有過大警告仍在。
- 原生測試以單工完成 **941 項／112 檔，全數通過**。首次預設並行執行有一個 Python／TS 縮寫投遞對照碰到 5 秒逾時；該檔隔離重跑 12 項通過，最後全套單工通過。未延長 timeout、刪減斷言或修改 bot 實作。
- 語言瀏覽器集合 **17 場景全數通過**。新增六個場景驗證雙語摘要／固定行高／原文、活動篩選 query 與候補數、QQ 綁定稱呼、成分 level／Canvas／原稿，以及管理分類協議值；涉及分享與查看的場景確認零業務寫入。首次新增斷言使用錯誤的 fixture 欄位、selector／query 及本機 key，核對實際契約後修正；不把失敗結果算通過。
- compiled smoke 通過空合成資料庫上的 API／SQLite／sharp、原生 bot mock HTTP／WebSocket／ACK／Resume／不確定投遞／simulation、CLI／SIGTERM、bounded room worker、恢復阻擋及配對備份。沒有真實 QQ 投遞。
- 已檢視本批 360px 活動分享截圖：連結欄位高度正常，原文、按鈕及必要提示可閱讀，沒有水平溢出。只代表本機 Chrome，不代替實體裝置或 QQ WebView。

- 跨領域集合有 603 個不同場景：首輪 596 項通過，7 個旧斷言失敗。核對實際 DOM 後，四個管理流程的 `管理後台` 對齊已編譯的 `管理後臺`；三個活動發布場景改在地點的 dd 核對原文，並加驗高德連結只編碼該原地點，適配既有導航連結。相關五檔 **39 場景全部通過**，原請求／資料／權限／原稿斷言不刪減。加上不重疊的 17 個語言場景，這批共有 **620 個不同瀏覽器場景有通過結果**；不是把首輪失敗記成通過。

## 固定來源與剩餘工作

來源提交 `608c225c8ccb0b007f569fc337f5b9ad71b11136`，tree `d1fb61299f12599e2bb1b31ff258b8624e0fe1e3`。乾淨工作目錄以 rehearsal 模式封存到 `/tmp/qgroup-image-608c225c8ccb0b007f569fc337f5b9ad71b11136/context`；只從此 archive 建置，不上傳工作目錄或執行正式發布。

本機 OrbStack arm64 engine 建置／模擬 linux/amd64；最後使用 archive 內的 Dockerfile 與完整 `QGROUP_COMMIT` 參數建置，完整 image ID **`sha256:0f12628a8a269f6fb1a1b580065688a05cffa1d52eb41ec5e4c72536b0131291`**，Node base 為 `node:22.22.3-bookworm-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752`。第一次漏傳 commit 參數，被既有 label／archive 一致性檢查拒絕；補上後完成建置，最後 archive 建置的編譯層均由相同來源快取取得。沒有修改來源檢查或略過驗證。

`verify-image.mjs` 對此固定 image 完成活動／guide／guide.html × 三組語言 × GET／HEAD 共 18 個公開 shell 檢查，以及來源版本、React／SQLite／sharp、零會員、無舊 Python server、UID/GID 994:992、readonly／移除 caps／no-new-privileges／network none、512 MiB／無額外 swap／1 CPU／128 PIDs、SIGTERM exit 0。語言、HEAD 空 body、no-store／Vary／無 Cookie 及手冊 chunk 均通過。

映像的 bot 檢查只涵蓋版本及合成健康；完整 mock runtime 另由 compiled smoke 驗證。沒有真實 QQ 連線／投遞或線上候選版本組合驗收。驗證自行建立的容器及 volume 已移除；映像未發布或推至 registry。後續檢查點提交只含測試斷言與文件；上述 runtime 映像的來源仍是固定提交 `608c225c8ccb0b007f569fc337f5b9ad71b11136`。

166 IDs 保留，**166 項 in_progress、0 項 planned、0 項完整驗收，release_eligible=false**。仍需完成固定 subclass／驗證錯誤的顯示、持久舊稿系統 notes 的呈現邊界、API 產生的通知／安排／結算／錯誤、統一成分用途政策與同意版本銜接、來源資料對帳及遷移／回退、完整 B01–B15 與實際候選 web／bot 版本組合、效能及實體裝置／QQ WebView。保留現有 Python bot；模擬結果不代替切換相容性。依使用者要求先不部署。
