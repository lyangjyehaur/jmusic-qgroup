# 成分工作區與 bot 投遞的共用 client

日期：2026-11-21。候選變更範圍：`web`。未部署、未整合 main；保留原 Python bot。API 的 178 個編譯來源與兩個 API runtime、三個 bot runtime 產物逐項符合第 174 號版本，沒有改動 schema、outbox、bot 設定或網站入口。

## 實作

新增網頁共用 client 邊界，將 `@qgroup/contracts/http` 接入既有 `ApiError`、簡繁錯誤顯示與 API 統計。每次請求獨立記錄傳輸狀態，並行請求不共用 response 變數。使用固定操作、具型別的參數／本文／查詢、same-origin 憑證及 redirect 拒絕；不產生操作編號、不重試、不自動重播。

本輪接入 15 個不同操作：

- bot 管理／活動／投票的投遞清單與核對、活動／投票重送，以及原重送結果查回。沿用原 UUID、本文、scope、AbortSignal、持久草稿與回執比對；管理檢視不增加重送權限。
- 站內稱呼的讀取、保存、版本核對與未知結果重試。保留衝突時輸入、多分頁更新與原操作編號。
- 成分工作區、詞庫與成分會員入口的讀取，以及成分保存和明確 rebase。保留 workspace 掛載、跨頁選擇、music epoch、profile target、草稿持久保存與快取失效順序。

網頁的伺服器拒絕仍可由既有 `ApiError`／status／code 判斷。斷線、不完整拒絕或無法驗證的成功回應保持未知結果，不被當成已確認拒絕而清除原操作。查詢驗證在 query function 內執行；無效投遞書籤顯示簡短提示，可重新選擇條件恢復，不在 render 中拋錯或發出無效查詢。

其餘網頁呼叫尚未全部接入；回應 schema 仍由各呼叫方指定。194 操作的完整權限／回應綁定與 OpenAPI 仍待完成，沒有用這次接入替代完整重構驗收。

## 驗證

- 新增 16 個 unit 案例，契約、實際 HTTP、稱呼與投遞的六檔／84 案通過，逐項符合固定 inventory；包括語言對、既有錯誤類型、未知結果、不重播、並行 response、scope 拒絕、回執與 binary stream。完整預期為 183 檔／3,024 unit、81 檔／844 browser。
- 九檔／69 個不同 browser 案例完成核對，涵蓋 bot 重送／查回、稱呼、成分 workspace、reset、按需載入、PWA 和統計。原首輪 68 成功／1 失敗及第一次修正失敗保留；PWA 測試原本固定最後一批為單一圖示，第一次修正又誤用排序後清單，最後改以實際 HTTP 下載順序核對整批尚未提交，該檔三案通過。這是多份報告的最終案例核對，不宣稱首輪或整組單次執行成功。
- 型別檢查、完整建置、compiled smoke 通過。83 個靜態資源與 144 個壓縮表示逐一核對原 bytes、大小和 hashes；86 個 precache 共 1,753,091 bytes，最大原子批次 490,141 bytes，最多四個資源、一個 cache 操作，沒有強制啟用。實際 browser cache keys、回應 bytes 與 hashes 一致。
- 保留 Python bot 的完整隔離回歸及獨立 oracle 通過：固定原版 55 個 blobs、178 個編譯 API inputs、71 次原 worker、9 次 native consumer、532 次 HTTP、314 個不同網站入口，含通知、回呼、重試／不確定／模擬狀態及七類順序交接。network transport denied，沒有真送 QQ 或正式版本組合驗收。

## 原始 CI 與剩餘驗收

第 173 號原 run `44852992758` 的三個工作均成功。unit 原 artifact `14687864463` 的四個檔案、browser 原 artifact `14687459333` 的 97 個檔案，以及已保存的 image 原 artifact，均核對原 ZIP digest、CRC、解包 bytes、來源與 terminal log。181 檔／2,992 unit、81 檔／843 browser 的 ID／名稱／位置一致，全部通過；194 個操作、273 個 schema 和 90 個原契約輸入 hashes 另行核對。原 browser 的 precache 與保留 Python 回歸也已核對。

第 174 號原 image job `136698857832` 成功，artifact `14688311862` 的 13 個檔案、原 runtime manifest、實際 Linux 映像與保留 Python 配對已獨立核對。原 unit／browser 仍按既有 handles 觀察，不重啟。第 172 號整組原結論仍為 failure。

166 capabilities 仍為 0 fully accepted，`releaseEligible=false`。完整 bot B01–B15、來源／reset 世代、media／browser pending、實際候選版本組合及切換驗收仍需完成；完整原計畫保持不變，本輪不部署。
