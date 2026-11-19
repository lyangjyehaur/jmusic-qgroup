# 舊帳號關閉與跨站回執合併檢查點

日期：2026-11-20。變更影響按 **`both`** 評估，涉及離線合併、帳號刪除與跨服務資料契約；本次發布範圍 **`none`**。沒有部署、合入 main，或改動正式 bot、憑證、群設定及真實待送工作。

## 實作

原 Python 看板關閉帳號時會移除其 `request_results`，但不知道新版的 `music_profile_receipts`。一般 59 表合併保留所有原生專用表，因此會留下指向已刪結果的成分回執。一般部分合併仍拒絕這個不完整外鍵圖，不把缺失的 parent 當成刪除授權。

新增 `mergeForwardBoardAccountClosures`，只作離線看板與帳號引用合併。它固定完整原 checkpoint、baseline board／journal、native image／journal、old board，以及原 authority manifest／records／ledger bytes；核對 lineage、來源 schema、frozen histories、原生 journal prefix 和 source-rebase bindings。拒絕缺失或不一致的原關閉申請、未記錄關閉、保留私人結果的舊關閉帳號、交錯 authority epochs，以及尚未完整處理的 structured reset。

看板 row writer 與獨立 row oracle 分離，普通合併仍先要求完整外鍵。專用步驟在未發布的記憶體候選中套用精確三方合併，再檢查每個 pending reference。允許的唯一待修引用為 `music_profile_receipts → request_results` 的確切 composite FK：child 必須與原 native receipt 的 rowid、所有欄位及 SQLite storage classes 相同，原 native parent 存在，而原 old board 已按同帳號／原 request ID／原時間的 authority closure 移除 parent。其他帳號、profile 或資料表的 orphan 均拒絕。

只加上原舊關閉 ID 的 applied marker；保留原 `privacy_requests` 的 rowid、狀態、備註與時間，不重新執行關閉，也不建立新申請、secret 或 native privacy receipt。帳號 repair 明確移除已關閉帳號的成分回執；即使 parent 早已缺失，也不再只依賴 cascade。原生登入與私人引用失效，成分解除帳號 ownership；成分內容、原 ID／key、共享紀錄、凍結歷史、bot 工作及序號保留。

新增可單獨重跑的 final verifier。它直接讀取全部原始來源，逐列獨立推導 pre-repair relation，再核對授權引用和原關閉 marker，最後使用 account oracle 推導每個最終 surviving row／column／storage class。它不使用 row writer、repair routine、writer report 或 caller supplied intermediate image；重新計算損壞候選的 SHA 仍不能放行。

pre-repair source 只在記憶體完成交易後序列化給內部 oracle，避免 dirty-page serialize 遺漏尚未提交內容。任何步驟失敗不返回不完整 image。最終候選必須通過 exact schema、`integrity_check` 和全部 `foreign_key_check`，仍為 recovery-blocked、rollbackEligible=false、releaseEligible=false。ordinary source／backup／export reader 的完整外鍵要求保留；結構檢查 helper 不構成完整來源驗收或通用跳過外鍵開關。

## 驗證

新增 34 項案例。兩項整合案例使用 active 合成 native source 的實際 `PUT /api/v2/me/music` 和 fields API 產生兩份原保存回執，完成 business／proof／source rebase 與完整私人套件後，再由實際原 Python `privacy.close` 關閉 completed claimant／fresh native 帳號。沒有把 recovery 候選改為可啟動以完成 API 測試。

核對一般部分合併仍拒絕、原 closure review 精確保留、沒有新增 native privacy receipt、其他帳號 receipts／results 不變、原成分 binding／audit mappings 保留，以及 pending／sending／sent／failed／skipped 的 bot payload、claim、retry、simulation 與 sequences 完整。獨立 readonly Python oracle 核對真 native receipts、原 parent 刪除、原關閉 intent／credential sentinel、逐表重跑結果與 storage classes；完整 checkpoint／music／identity 投影可重讀，啟動仍拒絕。

拒絕案例涵蓋未記錄／缺失／錯誤時間與帳號的 closure、舊 private restore、open-user receipt orphan、native result／profile orphan、其他 native-only references、sequence rewind、frozen-history 改寫、schema／checkpoint／journal 差異、早晚 source byte／pin mutation、非同步 boundary，以及重新固定 SHA 後的 review／receipt／bot／history／sequence／recovery／token／owner／marker／metadata 竄改。另核對獨立 old/native 業務修改合併與 opposed row conflict。

另外的私人合成 probe 在原 old board 新增未關閉帳號通知，核對 notification rowid／完整欄位與 `sqlite_sequence` 新高水位均精確保留，final verifier 及全部外鍵通過。另一 probe 將此結果接到既有 native erasure projector，使用原 authority／checkpoint／native journal，逐表核對 composition 完全不變、journal 相同；這兩個 probe 不計入 34 項 committed tests。

最終私人證據目錄：`/Users/danersaka/.codex/rebuild-verification/board-account-129-5aa45188142c4fc8a22a084783992d28/`。plan SHA256：`7c23777dadce8f5f2e481362fae65abb02e55dcf9807bb0dd70490b0b5989610`。固定 1,019 份非文件來源，完整目前 TypeScript／API／bot inventory 為 **148 檔／2,255 項全部通過**；分 19 批，每批一個 worker，零 failed／pending／todo／skipped。獨立 verifier 核對每筆 assertion、完整 inventory、批次結果與來源 SHA。開發失敗及選擇性重跑另列 development evidence，不作最終證據。

strict、完整 build、隔離 build smoke 與 166 項台帳檢查全部通過；建置及 smoke 後固定來源仍相同。12 個 runtime bundles 與已提交第 128 號 `bf1d68ca4390f5eb4e9895e56ae18603af91ff65` 全部 bytes 相同，包含全部 9 個 bot bundles；13 檔 TS bot 測試均納入完整回歸。schema、前端、API 與 bot runtime 沒有改動；本次新增離線工具並收緊／修復恢復核對。smoke 驗證合成 HTTP／WebSocket、ACK／Resume、投遞與模擬、SQLite ownership／SIGTERM、私人備份與 recovery block，未啟動正式 worker 或進行 QQ 投遞。

完整 plan、批次結果、獨立 summary、strict／build／smoke／台帳、runtime comparison 及兩項額外 probe 保存在上述私人目錄；提交後另外核對 Git blobs 與固定來源清單，並核對 origin／GitHub 功能分支的完整 SHA。

## 保留門檻

這是看板與帳號引用步驟，尚未接成完整最新業務恢復 pipeline。原 old music／identity 仍可能含已關閉 owner／links，完整 music graph／proof／source epoch reconstruction 必須在原 authority 下清理與逐欄驗證；不能把本輸出直接交給現有完整 business merge 或作 authority prefix。

一般跨領域 privacy receipt／result、structured reset 的 generation／ancestry／history cutoff、原私人映像的 latest-erasure 存取、重複 source epochs／外部高水位／audited activation、媒體／browser pending／proof、真正停寫 capture、固定實際 Linux web＋Python／TS bot 組合及全前後台／B01–B15／實機 QQ／資源驗收仍須完成。authority metadata 的自洽不代替原外部保全與來源 provenance。新 TS worker 完整驗收前保留原 Python bot。

全部 166 項能力維持 in_progress，0 項 accepted，release_eligible=false。本輪不部署。
