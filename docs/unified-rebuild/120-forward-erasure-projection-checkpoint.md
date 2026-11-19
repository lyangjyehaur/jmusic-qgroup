# 舊站刪除紀錄向新版回放檢查點

日期：2026-11-20。變更影響按 **`both`** 評估：共用帳號／成分刪除、恢復工具與 bot 資料保全；實際發布範圍 **`none`**。沒有部署、合入 main、啟動正式服務／bot 或改動憑證、群設定與真實待送工作。

## 已實作範圍

`projectNativeForwardErasures` 是離線刪除投影元件，輸入為完整固定 checkpoint、另行固定的 native SQLite／journal bytes，以及原 authority manifest pin。它僅在記憶體開啟 SQLite 副本，讀取 authority；不覆寫來源或 authority，不啟動 native writer，也沒有自動捕獲來源或發布的 CLI。

完整 checkpoint 先經原 rollback state／identity／music／erasure 對帳，重新核對 authority 的三個 baseline；native image 的 header、schema、完整性、外鍵與 lineage 必須相符，native journal 必須是原 authority 最新 unified ledger 的完整有效 prefix。輸入 bytes 或 authority 在同步邊界變動時拒絕；非同步邊界也拒絕。本元件不將同 lineage 或一份 hash 當成來源停機、完整歷史或外部高水位證明。

| 來源 | 回放與保全 |
| --- | --- |
| native unified intents | 保留最新原始 byte prefix、原會員／管理意圖與 signature／secret hash；使用現有 privacy 邏輯重播，保留真實收據及管理審計 |
| 原 board closures | 使用原 user／request ID／created_at；相同 native account／both 意圖不重複加入；跨領域 request 衝突拒絕；不製造會員或管理收據 |
| 原 music erasures | 從 authority 記錄的原 suffix 取得 scope；以固定 checkpoint 的 preserved／generated key 對回原 native profile ID；未知新舊站 key 建明確 tombstone 與 migration mapping |
| baseline tombstones | 較早同 lineage native 副本缺少 import／刪除 footprint 時補回；保留 baseline opaque 時間值及較新副本既有 tombstone 時間／JSON，不猜測未知時間 |
| 原 raw journals | 原 board／music bytes 隨結果保留；不把 normalized native closure journal 代替原刪除檔 |

舊 music 新紀錄的數字時間明確按 Unix seconds 轉 ISO，已有 ISO 保留；新增 opaque／未知／負數時間拒絕，交由後續明確修復。profile ID／舊 key 的歧義、collision 或現有 mapping 指向不同 ID 都拒絕。native intents 必須在同 authority epoch 的舊服務紀錄之前；舊服務恢復寫入後再插入 native intents 仍要求完整 rebase，不放寬現有 native retained factory gate。

`privacy.ts` 的現有 music deletion 函式及 rollback music key mapper 改為匯出，原服務呼叫與行為不變。離線投影共用實際刪除程式及 schema triggers，清除成分欄位、選擇、聯絡、認領／PIN／ownership proof、喊話與來源內容，保留 public terms／其他人的資料。已 applied 的 native-only profile scope 也重播，避免把收據當成私密 footprint 已移除的證明；不重複建立管理審計。已 applied 的關閉帳號仍有網站授權、成分關聯、投票／邀請存取或 consent 等私密資料時拒絕，不能用既有 receipt 跳過。恢復出 native reset 的原已刪詞條也拒絕；完整 reset 歷史截點修復仍未完成。

## 驗證

新增 **33 項**合成案例涵蓋原 Python authority 寫入、原 byte prefix／收據、account-only 與 music-only 分離、generated key 回原 ID、新舊站 key tombstone、opaque baseline／新增時間拒絕、較早 native image、兩次語意重播、pin／schema／WAL header／lineage、request／mapping 衝突、復活私密欄位、寫入階段交錯及來源／authority 邊界變動。

對帳使用有內容的合成活動、歷史審計、負額帳本、帳單 BLOB，以及 pending／sending／sent／failed／skipped 五種 bot 工作；確認既有 claim、不確定投遞、retry／simulation／已送本文與 bot 設定／runtime 不變。其他比對表包含空表時只證明空表保持，不能取代其完整業務流程驗收。獨立 Python readonly SQLite reader 再核對實際私密範圍、共用帳務／歷史與 bot rows；原 Python `music_site.maintenance.replay` 在另一份私人 identity／JSON 副本成功回放輸出的原 raw music journal，原 journal bytes 不變。

早期失敗紀錄保留：包括缺少 detachment provenance、外部身份必要欄位、request 衝突案例在 authority writer 提前拒絕、錯誤 lineage fixture，以及不能在 native 庫直接寫入舊唯讀 registrations 的 fixture。最終使用合法新 profile、跨領域獨立有效衝突及真正不同 lineage；沒有放寬 production constraints 或原唯讀 trigger。這些失敗不是最後驗收證據。

固定來源完整回歸 **1,890 項／137 檔全部通過**，零 failed／pending／todo／skipped；16 批的檔案 inventory、全部 assertions 與 975 份來源雜湊由獨立 verifier 核對。新增 33 項的最終證據為 `final-batch-03.result.json`；早期 `targeted-final` 名稱的失敗 fixture 紀錄不作最後證據。最新 strict／完整前後端與 bot 建置／隔離 build smoke 已通過。12 個 runtime bundles 以相同設定重新建置，與實際已建置 bytes 完全相同；全部 project inputs 對上固定來源，API 為 174 份，沒有 migration／testsupport／test runtime。smoke 只使用空合成庫、本機 HTTP／WebSocket 及受控投遞，不代表實際 Linux 映像、QQ 授權或真群投遞驗收。

私人證據：`/Users/danersaka/.codex/rebuild-verification/forward-erasures-120-9ab90d3fd39b43d0b2152d93f1cda745/`。完整 inventory source plan pin：`eb7f40a562a0f3946f07c129b62e8715d401a72d9c493193c6f56a02df38b74e`；涵蓋 975 份來源、137 份測試，分 16 批、每批一個 worker；固定來源邊界及 assertions／檔案 inventory 由獨立 verifier 核對。

## 後續退出條件

結果固定為 `erasureOnly=true`、`recoveryRequired=true`、`rollbackEligible=false`、`releaseEligible=false`；166 項能力仍 `in_progress`。本元件不能直接上線或當成完整 forward restore。後續必須：

1. 捕獲停機後原 board／music／identity／media／outbox 與最新 native source，驗原版本與完整 provenance；對原 rollback baseline 做差分，把舊服務新業務寫入合回 native-only 資料，不能只恢復 native checkpoint 或只重播刪除。
2. 在完整業務 merge 後再次回放所有刪除並對帳；舊 reset 的詞條與歷史範圍須有結構化證據，music member erasure ledger 本身不足以還原 reset。
3. 保留原 epoch 及 raw journals，建立與完整候選 checkpoint 綁定的下一 epoch；外部 custody／retention／高水位必須防止 authority 整組回卷，不只靠 baseline pin。
4. 完成 media／browser pending／proof、審計修復與明確 activation、固定 Linux web／bot 實際版本組合及 B01–B15、全功能瀏覽器與裝置／QQ／規模驗收。

按使用者要求不部署；本輪沒有啟動 Docker daemon 或執行容器；可用 context 是既有 OrbStack，未找到獨立 Colima／Lima CLI。Linux image／UID／mount／flock／資源驗收仍待獨立環境，不啟動可能恢復其他服務的既有 daemon。
