# 原生重置詞條關係的來源邊界

日期：2026-11-21。變更範圍：`none`；僅離線驗證工具與測試。網站、bot 運行程式、schema、journal 契約、outbox、設定與網址沒有修改。保留 Python bot，不合入 `main`，不部署。

第 162 號檢查原詞條 parent 的內容與 rowid，但相同 parent 仍可能帶有新的選擇、建立關係、來源文件或 mapping。原修復會按 reset ID 清除整個 scope，不能用 parent 相同證明所有子資料都屬於原世代。

現在固定重置前副本直接提供全部原詞條關係：details 的類別、別名、creator 與原 JSON 時間；選擇與建立關係的 profile／entry key、值、位置及 rowid；entry_source 的位置、rowid、完整 opaque JSON；entry mapping 的來源 key、target、revision、digest、rowid 與狀態。任何現存 scope row 必須精確對應原 row；不存在於原來源的新關係或來源位置在首次修復前拒絕，不按 parent ID 推斷其應刪除。

允許原 reset scope 已知 creator 的精確空值遮蔽，以及對應 mapping 的 `erasure_redacted`／`deleted` 狀態；其餘內容、類型與來源資訊仍須保持不變。JSON 遮蔽只用唯讀 SQLite `json_extract`／`json_set`，保留 `9007199254740993` 與 `1e+05` 的原數字內容。只有詞條 scope 為空時不執行詞條關係檢查。此邊界同時用於 raw input、全站修復及獨立候選核對，不呼叫資料刪除 writer。

新增 **23 個案例**的原版基線為 2 passed／21 failed；修正後全部通過。涵蓋 exact original rows、允許的 creator 遮蔽、五種 details 內容與 rowid、選擇與建立關係的新 key／值／位置／rowid、來源 JSON／rowid／新位置，以及 mapping provenance／rowid／新 slot／未知狀態。

既有完整投影案例另外恢復 byte-identical 原 parent，並讓後續成分建立新選擇。原版 raw 整合基線為 1 failed／35 未選案例 skipped：它會接受候選並清除後續選擇；新邊界在私人與 catalog writer 之前拒絕，保持輸入 bytes 與 authority 不變。最初 fixture 的原 parent rowid 被後續詞條佔用，觸發 UNIQUE constraint，不能作為行為證據；後續詞條改用固定且獨立的 rowid 後驗證真正缺口。最初 strict 的 undefined narrowing 問題已改為明確失敗的 nullish 查找；原診斷保留。

最終本機 **8 檔／198 個不同 unit／API 案例**全部通過，與獨立 AST 展開的固定清單一致，無 skips。strict、完整建置、built smoke 與 capability 規則檢查通過。相對第 162 號，177 個固定 runtime source inputs、2 個 compiled API hashes、worker 與 85 個 precache resources 的 proof 相同；沒有前台改動或新增展示文案。本次完整 CI 預期為 **175 檔／2,836 unit、81 檔／843 browser**；相關案例不代替原完整 CI。

第 160 號原 run `44800843634` 已完整獨立核對：172 檔／2,761 unit、81 檔／843 browser，沒有 skips／retries／flakes；原 ZIP／metadata／CRC／解包 bytes、固定 inventories、三份原 terminal logs、55 個原 Python blobs／177 runtime inputs、實際雙映像及逐資源 precache bytes／keys 均通過。第 161 號原 run `44802697285` 已終態成功，原完整證據正在核對；第 162 號原 run `44806465515` 的實際 Linux 雙映像與原 image log 已核對，unit／browser 在最後核對時仍執行中，不重啟原 jobs。

本次保護現存詞條關係，**完整關係、rowid 與 bytes 都相同的真正新世代仍需要外部 ancestry／custody**；沒有因此完成多次 reset、完整私人歷史、media／browser pending 或停止 capture。`allResetGenerationsReconciled=false`、`stoppedCaptureCustodyVerified=false`、`releaseEligible=false`；166 capabilities 仍為 0 fully accepted。完整 bot B01–B15／實際版本組合與 QQ、正式規模與 audited activation 仍待驗收。
