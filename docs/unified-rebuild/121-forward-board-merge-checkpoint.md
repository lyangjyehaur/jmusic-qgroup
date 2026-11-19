# 回退看板新寫入向新版合併檢查點

日期：2026-11-20。變更影響按 **`both`** 評估：離線共用資料重建、帳務／歷史與 bot 工作保全；實際發布範圍 **`none`**。沒有部署、合入 main、啟動正式服務／bot 或改動憑證、群設定與真實待送工作。runtime 的網站／worker／schema 不變。

## 實作與來源

`mergeForwardBoard` 比較三份獨立來源：原完整 native checkpoint 及對應的 59 表回退看板基線、停寫後舊看板最新副本、native 最新副本。每份 SQLite／journal bytes 都須有原先固定的 SHA256；基線看板經原 independent rollback verifier 對完整 checkpoint 核對 rowid、所有值／型別、schema、metadata 與流水號。native 要有相同 lineage、完整有效 journal 及 baseline byte prefix；不能用任意較早副本替代最新來源。

本元件只接受記憶體 bytes，不捕獲或開啟來源檔案、不連線服務或 authority；停機、固定版本、原 rollback package／source capture provenance 與外部高水位仍由後續父流程取得及核對。三份 hash 不能自行證明這些條件。

| 同一 rowid 的變化 | 結果 |
| --- | --- |
| 舊站與基線相同 | 保留 native 最新列，包括 native 側獨有寫入 |
| 舊站改變，native 與基線相同 | 接回舊站的新列／修改／明確刪除 |
| 兩邊改成完全相同列 | 合併為一筆，不重新建立審計、收據或通知 |
| 兩邊內容不同，或刪除／更新競爭 | 拒絕，保留全部來源，要求明確對帳 |

比較包含 signed rowid、INTEGER／REAL／BLOB／TEXT／NULL；超過 JS 安全範圍的整數使用 BigInt，REAL infinity／負零不經 JSON null 合併。不是逐欄猜測哪邊比較新；同活動不同欄位的競爭也不能覆蓋。不同 rowid 發生 primary key／UNIQUE 衝突仍阻擋，沒有私自改 ID 或重新編流水號。

候選從 native 最新 image 複製，只有本次私人記憶體重建暫停 triggers／FK side effects。每張表先移除整組變更列、再插入，以處理原合法 UNIQUE 值交換；不修改正式或來源 schema。之後恢復每個原 trigger、核對完整 native schema、資料完整性與外鍵。59 表的 AUTOINCREMENT 高水位取兩邊最大，拒絕來源降到 baseline 以下；空表與 signed／超大整數均保留。native 專用表及其流水號保持原樣，只有候選 `rebuild_storage.recovery_required` 設為 1。`user_version`／`application_id` 同樣按三方規則，舊站 encoding 與 baseline 不同則阻擋。

## 歷史與 bot 保全

18 張原 append-only 歷史表的每一筆 baseline 列必須在 native 和舊站都原樣存在；新增歷史可接回，改寫或刪除會拒絕。涵蓋活動／投票／安排／分房、財務／申報／結算／圖片引用、帳號／管理角色及 bot 設定歷史。一般私密資料表的合法刪除則按三方規則處理。

原 bot baseline 工作不能消失，原 event／poll／kind／dedupe／channel／payload／due／created／target／recipient 保留。已送狀態及已送本文不能降成待送或改寫；原模擬標記不能移除或轉為 pending／sending／sent。可接回舊站新產生的工作，以及與另一邊不競爭的待送／投遞／失敗狀態變更；沒有清理 claim、不確定投遞、重試或模擬紀錄，沒有把舊群工作轉給別群。

不會在資料重建時重做業務操作、產生審計／收據／outbox，也不覆寫原 `migration_map` 以偽裝新的 provenance。原 source mapping、browser pending／proof 與新寫入的完整來源紀錄仍須由父流程對帳及保全。

## 驗證

第一版新增 **47 項**合成案例全部通過；後續補上 1 項 inherited pending simulation 的相容案例。原 Python `qgroup_core.events.create` 在私人 59 表副本實際建立新活動、名冊、條件／審計及群工作，合併後與原列完全相同；另一份 native 成分選擇修改及完整專用資料保留。原負額帳單 BLOB／帳本、pending／sending／sent／failed／skipped、精確 time／claim／retry／simulation／本文與設定原樣保全。測試沒有 QQ worker 或真群投遞。

另以完全獨立 Python readonly SQLite reader 對三份來源推導期望列，再對全部 59 張共用表與每張 native 專用表逐列、逐型別核對候選；不讀 TS 報告或 migration_map 作 oracle。TS standalone verifier 同樣不呼叫 projector，不信任 change list／摘要，會拒絕重新計算 image pin 後的列、專用資料、流水號、trigger、metadata 或 recovery flag 竄改。

正向案例包含 native 側獨有 board 變更、相同變更 coalesce、合法 UNIQUE 交換、INTEGER beyond Number、負 rowid、REAL、BLOB／TEXT／NULL、空表最大流水號、metadata 與兩次語意重播；負向包含六種來源 pin、schema／WAL／lineage／baseline、丟失 journal／applied、高水位回卷、row／PK／storage／metadata 衝突、歷史及全部 bot 保全規則，以及真正最後邊界的 bytes／pin 變動與非同步 callback。第一次測試有一個摘要 hash 的恢復標記正規化失敗，資料列沒有差異；已改為 hash 候選實際標記，原失敗 log 保留。

第一版固定來源相關回歸 **287 項／23 檔全部通過**，零 failed／pending／todo／skipped。涵蓋本元件 47 項、刪除投影／privacy、原 rollback board／checkpoint／state／bot exclusion、全部 13 份 TS bot 測試及 3 份資料庫／遷移測試；3 批 assertions／檔案 inventory 與全部 979 份來源 SHA256 由獨立 verifier 核對。最新 strict、完整 web／API／worker 建置及隔離 build smoke 已通過；12 個 runtime bundles 與第 120 號已驗證 bytes 全部相同，沒有將離線 merge 工具加入 runtime。第一版證據綁定提交 `1e2166d645c4329230e8d6dfd28083ad714cfcc9`。第 120 號完整 **1,890 項／137 檔**證據仍綁定提交 `e29a769b494b1cb55c2cf9ed286834ea81cdfd91`，本輪相關回歸不冒稱重新跑過目前全 inventory。

私人證據：`/Users/danersaka/.codex/rebuild-verification/forward-board-121-fc159c06c1ce4bd7b353aa50b5f2a064/`；固定來源 plan pin `56ff063a76a9a6160af1a0e649e63f93f702d61079ece30695aab83b7e1b01f4`，979 份來源、138 份總 inventory，明確選取 23 份相關測試／3 批、每批一個 worker。

## inherited simulation 相容修正

原歷史工作可能是 pending／sending 且已帶模擬標記，不能只因它未變成 skipped 就拒絕相同快照。補充修正保留未改變的狀態與原模擬時間；仍拒絕移除／改寫標記或把它轉向 pending／sending／sent 的不同狀態。新案例確認原 pending 工作及其所有欄位原樣保留、沒有新增投遞，改為 sent 時會被阻擋。沒有改動 worker 或把歷史狀態正規化為新的工作。

補充固定來源相關回歸 **288 項／23 檔全部通過**，新增合併案例共 **48 項**，零 failed／pending／todo／skipped；3 批 assertions／檔案清單與 979 份來源由 verifier 核對。最新 strict、完整建置與隔離 build smoke 通過。私人證據在上列根目錄的 `simulation-preservation/`，新 plan pin `13708e019d5e9b157b2d562193aa3c54c8c2d4e07214969128c453decea3bfe0`；沿用同 23 份測試及 979 份來源，保留前一版結果及提交綁定。最新完整建置通過，12 個 runtime bundles 仍與第 120 號相同。

## 完整 forward restore 尚須完成

結果始終 `boardOnly=true`、`recoveryRequired=true`、`rollbackEligible=false`、`releaseEligible=false`，166 能力仍 `in_progress`。不是成套恢復或候選服務啟動工具：

- 需要停寫後 old／native 真正原 capture、固定版本與跨 domain 一致性。未經捕獲認證的任意最新檔案不能作正式來源。
- 成分 JSON、身份、聯絡／PIN／ownership、喊話／趨勢／reset、媒體及 browser pending／proof 須按原 key／ID 與 native-only 資料完整合併，不以看板重建代替。
- 跨領域引用與刪除須在完整資料圖一併處理。例如 old 刪除 private request result，而 native music receipt 仍指向它，本元件保留原來源並拒絕輸出部分候選；已有直接負向案例。完整父流程須按原 authority 處理該刪除與 proof，再對帳，不能直接移除 native 收據以求通過外鍵。
- 原 raw journals／request ID／時間與收據須保全；完整 merge 後重播最新刪除，較早或已 applied 副本的私密 footprint 不能復活。structured reset 的詞條／歷史截點須有結構化證據。
- 保留前 epoch，建立與完整新 checkpoint 綁定的下一 epoch，取得外部 custody／retention／高水位；完成審計修復、固定 Linux web／bot 組合、B01–B15、全功能瀏覽器／實機／QQ／規模驗收後才可啟動。

按使用者要求不部署。不能把較窄的 memory merge／合成 Python 測試當成全系統驗收或來源停機證明。
