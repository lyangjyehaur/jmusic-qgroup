# 第五十三批實作：bot 跨應用身分診斷

日期：2026-11-18（Asia/Taipei）。分支 `codex/unified-rebuild`。發布範圍 **`none`**：本機隔離實作，沒有部署或修改正式 bot、憑證、群設定、待送工作。變更限原生 TypeScript worker 與測試／文件；Python bot 保留，schema 維持 **14／94 張表**。

## 觀測資料與私密性

補齊舊 Python `union_diagnostics` 的原生等價觀測：`union_openid_present`、Unicode 長度、`union_user_account_present`、不透明雜湊參考與 `unionid_matches_site` 布林值。QQ 群訊息的 `message_received` 也保留群／輸入的雜湊參考、是否提及 bot、全體提及狀態與提及數量。這些只供維運診斷；存在或匹配均不等於已授權／已綁定 bot，沒有據此判定網站帳號或開放新的私人指令。

原始 UnionID 只以白名單欄位送至隔離 worker 做參數化唯讀查詢，不寫入紀錄；QQ 帳號值、原 author、訊息正文、引用內容及其他 gateway payload 不跨入此診斷工作。worker 只送回上述安全診斷欄位，主執行緒保留原 trace。沒有呼叫 QQ 身分查詢服務、沒有建立／修改使用者或 external identity／unionid 紀錄。

平台身分欄位不是字串或只含空白時視為缺值，缺值不開資料庫、不報失敗。超過 4096 UTF-16 units 的輸入在主執行緒就拒絕複製／雜湊，回報 `InvalidIdentifier`、長度 null，不影響該訊息的指令。正常平台短識別值的 presence／codepoint length／ref／match 與 Python 差分一致。

## Worker 隔離與失敗處理

身分 SQL 在公開查詢 worker 內開 `readonly + fileMustExist + query_only` 連線，先驗證重構儲存可用性；不建立資料庫、不遷移 schema、不查詢恢復候選的身分匹配。SQLite busy timeout 為 100ms；缺表、缺檔、鎖住或恢復封鎖只回報診斷不可用，不記 SQL、檔案路徑或錯誤原文，也不把不可查誤報成「站內無匹配」。

dispatcher 與 worker 的診斷工作各有獨立佔位，最多 8 個且不超過設定的 lane 限額，不佔用公開回覆、縮寫或送出前授權的容量；仍由公開 worker 執行，不新增無界 worker。群觀測寫入維持原節流；一般、忽略及重複群訊息均可觀測身分，不要求每次寫入群紀錄。佇列滿、取消或診斷例外只記安全錯誤，原指令／按鈕的業務工作仍繼續；整個 worker 崩潰則仍按既有 runtime 失敗保全規則停止。

這是盡力而為的維運觀測，不是 durable inbox。容量不足／連線取消可遺失該次診斷；單一公開 worker 中 8 次最長 SQLite 等待也會增加排隊延遲，沒有因此宣稱正式效能已驗收。

## 隔離驗證

新增 **5 項** identity diagnostics 測試及 **1 項**真 worker 整合測試。覆蓋 Python 差分、Unicode／空值／匹配／不匹配、私密值遮罩、使用者與身分唯讀保全、缺檔不建立、缺表／恢復封鎖、鎖等待與過長輸入、診斷失敗後仍回覆訊息／按鈕、dispatcher／worker 診斷佇列與回覆佔位獨立（含普通訊息填滿診斷後仍處理指令及按鈕），以及忽略訊息觀測。

既有 runtime 的本機 HTTP／WebSocket 案例加入站內匹配與重複訊息觀測，核對兩筆診斷、仍只回覆一次及所有紀錄不含原 UnionID／QQ 帳號。建置產物 smoke 使用真正的 `dispatch.mjs`／`dispatch-task.mjs`，核對同一安全欄位與空庫不匹配；沒有正式 QQ、實際跨應用憑證或正式身分資料。

完整重構回歸 **90 檔／723 項通過**；最後加入群／輸入雜湊參考後，受影響的診斷／dispatch／worker／runtime **4 檔／34 項**再次通過。strict TypeScript、重構建置及 built smoke 通過。前端產物維持 **1,164.52 kB／gzip 339.78 kB**；dispatch 約 **112.0 KiB**、runtime 約 **160.4 KiB**，仍有 bundle 大小警告。capability ledger 與 diff check 通過。前一批同一輪已通過 Python bot **311 項**、時間投票 **15 項**及相關瀏覽器 **24 項**，此後未修改 Python／網站功能，證據見 58 號檢查點。

## 剩餘驗收

**166 項保留、0 項完整驗收、release_eligible=false**。原生 bot 的 UnionID 診斷已有隔離實作，QQ 是否實際提供該欄位取決於平台跨應用綁定／授權，不能由本機合成測試證明。完整 B01–B15 與切換後實際 web／bot 版本組合、真 QQ／長期連線、正式待送／不確定結果與續讀對帳、資料副本切換／回退演練仍待驗收。其餘後台、全部舊 URL／public-v1、PWA／持久草稿、簡繁與資料完整對帳繼續按主計畫完成；使用者要求先不部署。
