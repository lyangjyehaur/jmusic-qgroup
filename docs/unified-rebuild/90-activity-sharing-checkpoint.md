# 第八十四批實作：活動摘要與高德導航

日期：2026-11-18（Asia/Taipei）。分支 `codex/unified-rebuild`。變更範圍 **`web`**，實際發布範圍 **`none`**。使用本機合成 fixture、隔離 Chrome context、攔截的地圖頁與 mock clipboard；未部署，未改動正式 bot、憑證、群設定或真實待送工作。

## 共用分享與時間

原生活動分享頁保留連結複製，新增「活動資訊／目前安排」選擇與摘要複製。安排確認頁可直接開啟目前安排分享；集中使用同一份活動摘要及手動複製退路。保留原名稱、說明、地點、費用、報名／退出期限、安排版本、變更摘要與逐人確認提示，不轉換使用者內容，不附帶名冊、聯絡、私人備註或逐人金額。

活動列表、詳情及分享共用時區格式。完整 instant 依原 IANA zone 顯示開始及預計結束，跨日保留完整日期，DST 重複小時標示各自 offset。原資料缺 zone、無 offset 或 zone 無法辨識時保留原時間與持續時數，不以裝置時區猜測；null duration 保留時長未定。

分享先通過既有 `/share` 權限，再讀取 `/activities/:id` 的目前可見資料。兩次讀取皆帶固定 account scope 與取消 signal；ID、canonical 路徑、32 位 invitation token 與目前 origin 一致才呈現。公開分享可由訪客使用；私人邀請仍限發起者取得，原持有者查看／報名政策不變。讀取或重新驗權失敗會撤下分享欄位並提供重試。這是已讀取資料的分享，並非在剪貼簿點擊時執行新的原子版本查核。

## 複製退路與導航

摘要與連結始終有可選取的唯讀欄位；copy 只由點擊觸發。clipboard 缺失、同步 throw 或拒絕時選取完整內容，提示手動複製；成功才回報已複製。摘要切換、資料變更或離頁會失效舊 callback，晚到結果不能為另一份摘要回報成功。沒有保存至 localStorage、原稿或 outbox。

活動地點、目前安排及保存的歷史安排共用高德導航，將該版本地點完整 encode 為單一 keyword；只點擊才開新分頁，使用 `noopener noreferrer`，不讀取定位。歷史地點不改用目前地點。手機檢視後調整複製操作與摘要選擇間距，沒有新增展示文案。

## 隔離驗證與 bot 邊界

- strict TypeScript 與 React／API／bot build 通過；既有大 bundle 提示保持。
- **5 項原生測試通過**：原文與必要欄位、安排確認提示／空值、無 offset／無 zone／無效 zone、DST 重複小時與跨日、分享 ID／origin／路徑／token 拒絕。
- **28 個不同瀏覽器場景通過**：11 個新摘要／導航場景，以及既有 7 個安排確認、10 個舊入口場景。涵蓋 clipboard 三種失敗、延遲 callback、私人 owner／持有者隔離、跨分頁登出及晚到私人回應、讀取失敗／不符路徑、目前與歷史地點、原文不當 HTML 執行、原安排操作恢復與 bot 入口不自動提交。
- 地圖請求由本機 route 攔截；點擊前沒有地圖請求，點擊後只有完整 location keyword，沒有定位調用，popup opener 為 null。未對真實地圖或 QQ 做驗收。
- 360px 無水平溢出；人工檢視 `test-results/unified-activity-sharing-mobile.png`，測試重新產生合成截圖。
- compiled build smoke 通過：API、SQLite／sharp、bounded room worker、bot HTTP／WebSocket／ACK／Resume／原生 runtime／SIGTERM 與配對備份。沒有變更 bot 指令、模板、群政策、設定、schema 或 outbox；保留舊 bot 深連結與目前共享資料契約。
- 首輪前兩個新場景因建置與瀏覽器測試並行而讀到舊 bundle，後改為建置完成後執行。另修正摘要選單的明確 label association；歷史導航測試改為選定第 1 版，避免誤測第一筆（目前第 2 版）。未跳過場景或放寬業務限制。手機間距修改後完整 11 個新場景重跑通過。

E18 改為 `in_progress`，相關 O03 追加證據。166 IDs 保留，**164 項 in_progress、2 項 planned、0 項完整驗收，release_eligible=false**。尚待實體裝置／QQ WebView、正式來源及完整候選版本組合、資料遷移與回退驗收。本批只有本機 compiled build；[上一批映像](89-unified-runtime-checkpoint.md)仍固定於其記錄的來源，不含本批前端修改。全站簡繁、Umami 白名單、其餘原請求與完整遷移／驗收持續處理，依使用者要求先不部署。
