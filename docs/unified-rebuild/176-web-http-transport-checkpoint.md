# 全站共用 HTTP 傳輸層

日期：2026-11-21。候選變更範圍：`web`。未部署、未整合 main；保留原 Python bot。兩個 API runtime、三個 bot runtime 與 178 個 API 編譯來源符合第 175 號版本，schema、outbox、bot 設定與既有網站入口沒有改動。

## 實作

既有 195 個 `api()` 呼叫接入同一個共用 client。過渡解析器將現有 URL、method、headers、JSON 本文與 signal 對應到 194 個固定操作，交由共用 contracts 驗證。保留省略查詢預設值、BigInt 字串游標、原管理回執 scope，以及既有帳號／CSRF headers。只有原 `Idempotency-Key` 才映射成 client request identity；不把刪除憑證等領域本文內的 ID 或秘密搬到 headers，也不產生新編號、重試或自動重播。

拒絕外部／未知路徑、dot segment、錯誤編碼、不支援的選項及 headers；有 schema 的重複查詢欄位保持拒絕，原本忽略 query 的操作仍忽略。現有呼叫方持續負責回應 schema、草稿、原操作查回與權限恢復；這個過渡入口仍有一個動態型別邊界，不代表 195 個呼叫方已全部改成固定操作的編譯期型別。

圖片、壁紙及管理匯出改用共用串流入口。保留原 AbortSignal、壁紙 no-store、PNG／下載格式核對、帳號切換及下载後重新檢查管理權限。API 錯誤類型抽成獨立模組，兩種呼叫入口使用同一個 `ApiError`，避免循環匯入。PWA worker 的獨立 fetch 保留，不匯入網頁 client。

修復第 175 號原 Linux browser 回歸發現的提示退化：成功回應的 schema 不符、JSON 無法讀取分別保留原提示；錯誤回應無法驗證仍是未知結果。原例外類型、草稿、操作編號與結果核對流程保留。

## 已完成驗證

- 三檔／88 個相關 unit 案例逐項符合固定 inventory 並通過，包括 194 操作解析、headers／原回執、JSON 本文、禁止不支援選項、查詢及 route 驗證、串流與取消、錯誤分類及不重播。完整預期為 184 檔／3,056 unit、81 檔／844 browser。原測試用不存在的 `/activities/drafts` 路徑導致的失敗，以及修正提示時誤在未建置 unit source 要求 Vite 簡繁轉換的四個失敗，保留於本機驗證紀錄；後者改驗原文提示，簡繁由既有 browser 案例驗證。
- strict 與網頁隔離建置通過。82 個靜態資源、142 個壓縮表示與 277 次 HTTP 檢查核對原 bytes、hash、MIME、cache／HEAD／conditional；85 個 precache 共 1,754,834 bytes，最大原子批次 621,619 bytes，最多四個資源、一個 cache 操作，沒有強制啟用。這些數值不是正式負載或記憶體驗收。
- 新版編譯 API 與保留 Python bot 的隔離回歸完成並通過獨立 oracle：固定原版 55 個 blobs、178 個 API inputs、71 次原 worker、9 次 native consumer、314 個網站入口，涵蓋通知、回呼、重試／不確定／模擬狀態及七類順序交接。HTTP 次數含實際限流 deferral，不假定每次固定相同。network transport denied，沒有真送 QQ，也沒有取得正式 bot 的實際版本組合。

## 尚在觀察的回歸

第 176 號本機完整 browser 原程序仍在執行，未因等待逾時重跑或停止；原 stdout 採預設 reporter，不能把檔名當作 JSON 證據。這次原執行使用修正前的第 176 號建置，未啟用 optional 公開 Umami 案例，共 843 案；最終修正版建置另放隔離目錄，不覆蓋該程序使用的產物。完成後仍須補驗提示修正、公開固定 client 的單一攔截案例，以及修正版實際 browser cache。尚未宣稱本機整組通過。

第 175 號原 run `44860231792`：image job `136711679422` 成功，實際 Linux image／Python 配對與 static 原報告已獨立核對；browser job `136711679573` 是 failure，原 artifact `14691480133` 的 101 個檔案及 ZIP digest／CRC／解包 bytes 已核對，81 檔／844 案 inventory 一致，842 成功、兩個簡繁格式提示案例失敗。原 unit job `136711679734` 按既有 handle 持續觀察，不重啟，整組不能標為 success。

第 174 號原 CI 三個工作及完整 artifacts 已全部成功並獨立核對：182 檔／3,008 unit、81 檔／843 browser、原 image／Python 配對。第 172 號原整組結論仍為 failure。

166 capabilities 仍為 0 fully accepted，`releaseEligible=false`。固定操作呼叫方、完整 permission／response 綁定、真正 OpenAPI、完整 bot B01–B15、來源／reset 世代、media／browser pending、實際候選版本組合及切換驗收仍需完成；不以本輪傳輸層接入替代完整原計畫。
