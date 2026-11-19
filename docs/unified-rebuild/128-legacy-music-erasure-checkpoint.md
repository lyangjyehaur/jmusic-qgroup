# 舊成分刪除意圖與原生恢復檢查點

日期：2026-11-20。變更影響按 **`both`** 評估，涉及原生 privacy reader、舊成分刪除、來源歷史與跨服務恢復契約；本次發布範圍 **`none`**。只在功能分支及隔離合成資料實作，沒有部署、合入 main，或改動正式 bot、憑證、群設定及真實待送工作。

## 實作

舊 music service 原刪除紀錄只有 `{qq, erased_at}`，没有原生帳號、request ID、secret 或 privacy receipt。先前 source-rebase reader 只能用原生 music／administrative intent 授權缺失的 frozen histories；套用真正的舊刪除後，完整音樂／身份／套件投影仍會拒絕。新增 StoredIntent v3 `legacy_music` 作為原紀錄匯入，不製造原生使用者申請或回執，也不關閉網站帳號。

意圖固定實際 native profile ID、原 legacy key、明確 ISO 時間與原解析時間的 JSON，並記錄原 authority manifest／checkpoint／record／suffix SHA、sequence、非空 suffix row index，以及 source-rebase run digest。marker 為 `legacy-music:` 加 SHA256(`qgroup:imported-legacy-music:v1:`＋遞迴鍵排序的 core JSON)。marker 是內部套用識別，不是使用者操作號或外部授權。

forward projector 只從已固定、完整核對的原 authority record 取得每個舊 key 最新刪除範圍；既有 native journal prefix、原 board closures 與舊 music ledger bytes 保留，匯入意圖接在原 native prefix 後。使用 checkpoint／source-rebase 的既有 native ID 與生成 key 對應，不另建一份生成成分。普通 privacy recovery 的匯入分支驗證 mapping／aliases，重播原成分刪除，保留原時間 JSON 並寫入 marker；memory／file 原生 user journal append 均拒絕此匯入格式。

source-rebase reader 在原 frozen history 缺失時，要求匯入意圖的 profile ID、legacy key、source-rebase digest、原生 tombstone ISO 與 legacy time JSON 都符合。來源 alias／audit mapping／高水位門檻保留；其他成分歷史不得缺失或變更。離線 forward projector 可再清除在已套用 marker 下混合恢復的私人欄位、選擇、contact、creation、claim、source identity 與歷史，重跑不新增 native receipt、catalog action 或 bot 工作。

TS／Python validator 共用四位正年份範圍，數值 Unix 秒明確轉為截斷到毫秒的 ISO 時間。拒絕年零、延伸年份、offset／不合法日期、負值／非有限數值、非 canonical 原 JSON、範圍及 marker 竄改。修正 Zod refinement 對部分無效欄位直接拋出例外的行為，使 safeParse 正常返回拒絕結果。

完整 native checkpoint／音樂／身份／erasure／media／history／private package readers 保留匯入意圖。另在固定來源下驗證實際 TS／Python authority ledger readers 接受 unified 的匯入格式，同時拒絕把它當成原 board closure；保全 authority protocol 版本不變。historical music export 同時按原 legacy key 與 native ID 過濾。legacy-shaped snapshot importer／music reconciliation 缺乏完整 native sources 與生成 bindings，明確拒絕 v3，不猜測映射。

## 驗證

新增 38 項案例。時間 parity 一項含 4,014 個固定數值／日期樣本，包括科學記號、極小值、fractional milliseconds 與年份邊界；另測重算 marker 後的未知／原生欄位、錯誤 key／origin／時間、截斷 journal、原生 append、applied marker、mapping collision、歷史過濾、legacy-shaped 匯入拒絕及一般 native paired backup／offline restore。

兩項整合案例先完成 business／proof reconstruction 和 source rebase，再在合成私有來源中執行實際原 Python `administration.erase`，分别刪除 completed claimant 與 fresh native generated profile。核對原 authority records／suffix row／時間、原 binding 與 frozen-history 截點；全部帳號登入、native receipts、共享業務、bot pending／sending／sent／failed／skipped、投遞 payload／claim／retry／simulation 及 sequences 保留。完整原生與舊投影套件可重讀，錯誤 profile／key／rebase／time 的 frozen-history 授權均拒絕。獨立 readonly Python oracle 比對原 authority bytes 與原 binding，逐表核對重跑資料及 SQLite storage classes。

恢復候選仍為 recovery-blocked，未為測試改成可啟動。其 paired checkpoint 可私人封存，但一般 backup reader 仍明確拒絕需要離線審查的候選。另用既有合成 active native fixture 驗證 v3 paired-backup 讀取及舊／新 checkpoint 的 offline restore；還原輸出保持 recoveryRequired／releaseEligible=false，撤銷登入證據，不關閉帳號或重播 bot。

最終固定來源證據：`/Users/danersaka/.codex/rebuild-verification/legacy-music-128-41aa5d6451b04699bdb6e5e900b47ac8/`。plan SHA256：`f459e23c5ab50dc5e038cc9af61e819fffa865c9ca7e5812d17a9ec07ee7d218`。固定 1,013 份非文件來源；完整目前 TypeScript／API／bot inventory 為 147 檔，分 19 批、每批一個 worker。開發失敗／fixture 修正／syntax 與 timeout 調整不沿用為最終來源證據。

最終完整 inventory 回歸 **147 檔／2,221 項全部通過**，零 failed／pending／todo／skipped。獨立 verifier 核對每筆 assertion、完整 inventory、19 批結果及 1,013 份來源不變。strict、完整 build、隔離 build smoke 和台帳檢查全部通過，建置與 smoke 後來源 SHA 仍相同。

12 個 runtime bundles 對照已提交第 127 號 `6d6ac910ead88f32e04b0149f82f59264922ab65`，只有 API `start.mjs` 改變；database、分房 worker 與全部 9 個 bot bundles bytes 相同。13 檔 TS bot 測試全數納入。schema 和 bot 原碼沒有改動，原 Python music deletion 及 authority ledger reader 已由隔離 subprocess 執行。build smoke 驗證原生 HTTP／WebSocket、ACK／Resume、投遞與模擬狀態及 recovery block；這些合成結果不代替實際固定 Linux 服務組合、真 QQ 或完整瀏覽器驗收。

最終 plan、逐批結果、獨立 summary、authority-reader parity、strict／build／smoke／台帳及 runtime comparison 均在上述私人證據目錄。提交後另核對 Git blob 與固定來源清單，並核對兩個遠端功能分支的完整 SHA。

## 保留的門檻

origin metadata 與 marker 的自洽性不能證明外部 custody、完整 ancestry 或原歷史映像的真實來源。本次 projector 有持有並核對原 authority records，但一般 journal reader 不會僅憑 origin 欄位認證外部保全。原始來源、ledger bytes、authority records 及 checkpoint 仍須外部持續保留；產出的新 journal 也不能直接充當舊 epoch 的 authority prefix。

跨 domain orphan receipts、structured reset 的完整世代／ancestry／latest-history 過濾、原私人映像的 latest-erasure 存取、重複 source epochs／外部高水位／audited activation、媒體／browser pending／proof、真正停寫 capture、固定實際 Linux web＋Python／TS bot 組合與全前後台／B01–B15／實機 QQ／資源驗收仍須完成。已失去 tombstone 或相互矛盾的混合恢復不由本次規則任意修復。新 TypeScript worker 完整驗收前保留原 Python bot。

全部 166 項能力維持 in_progress，0 項 accepted，release_eligible=false。本輪不部署。
