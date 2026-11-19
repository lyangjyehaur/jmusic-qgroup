# 第一百零三批實作：歷史備份私人保全與成分投影

日期：2026-11-19（Asia/Taipei）。分支 `codex/unified-rebuild`。變更範圍 **`both`**：回退包的完整資料／刪除／bot 證據保全有跨服務依賴，其中既有歷史下載的修正影響 web。實際發布 **`none`**。只使用合成來源與隔離暫存檔；沒有 main 整合、正式資料、憑證、群設定、待送工作或服務操作。

## 固定來源與完整私人封存

新增 `rollback-history-source.ts`。輸入為同一 media／state checkpoint、明確 canonical capture／native archive 目錄，以及外部核對的 capture manifest SHA 和每個 native manifest SHA 清單；native 清單為空也必須明確提供。讀取前後核對所有檔案與目錄，拒絕漏檔、額外檔案／未知空目錄、連結、特殊檔、重複 pin、pin／checksum／inventory 變更及缺少引用資產。

capture manifest 的完整檔案集與 fingerprint 必須一致；`current/` 的精確 fingerprint 和 manifest 必須出現在固定新庫的 `migration_runs`。完整 raw capture bytes 全部保留，包含當時 current SQLite／JSON／身份／媒體／ledgers、看板歷史 SQLite 和圖片 tar 配對、成分配對及獨立 JSON、bot 診斷／群狀態／事件。原 capture manifest 和 native manifest 也以原 bytes 保留。私人原始身份、session、PIN、憑證、已刪資料及 bot 工作不進入有效目錄或下載投影；不開啟原 SQLite，不重播原 outbox，不修改或修剪原檔案。

native 檔案逐一核對完整 manifest、schema、完整性／外鍵、journal／applied markers／receipts、圖片 pairing 和 import receipts。版本 2 必須同時符合 archive manifest、內部 lineage 和固定最新新庫的 lineage；schema 13 版本 1 沒有 lineage，改以非空且精確相符的 import receipts 識別其來源。升級只作用於記憶體副本，升級後完整 schema／trigger 須符合固定模型；不因 manifest 有正確版本號就接受額外 trigger。統一 JSONL 額外檢查重複 object keys 和不安全數字；同一 intent 的多行 durable 重複仍完整保留。schema 13 的 raw bytes、原 schema 和原已知 createdAt 都保留，不把升級副本的新 lineage 寫入來源。

本元件要求受控不可變來源 mount 與外部 pins；caller 必須把清單固定在停寫的捕獲邊界。它不取得部署鎖、不停止排程或服務，也不能從同一 lineage、檔名或時鐘推論某份備份屬於該捕獲邊界。之後完整包工具仍須取得這些控制證據。逐檔上限 512 MiB；全部 bytes、獨立對帳副本和 memory SQLite 的正式規模 RSS／時間尚未驗收。

## 最新刪除與身份優先的成分歷史

新增 `rollback-history.ts` 和 `rollback-history-music.ts`，先驗證既有完整 state，再從該 checkpoint 產生每份歷史的 data.json。checkpoint 與 journal digest 綁定在結果，不讀較晚的 live DB／journal。三個 namespace 分別使用 `legacy-pair-<stamp>`、`legacy-json-<stamp>` 和 `native-<完整原 ID>`；同秒備份與同名 pair／JSON 不覆蓋。舊 stamp 的時區、createdAt 和 schema 仍未知（null），不猜時間；native 使用原 manifest 的實際值。

舊 JSON 沒有統一 applied markers，下載前依最新 scoped profiles／reset entries、歷史清除、QQ tombstones 和目前 owner／PIN／contact 處理；歷史獨有成分的登入／聯絡憑證清空。新版 SQLite 備份先在副本重播最新 intents，保留原 applied markers，已重置後新增的詞條、選擇、喊話和 trend 不被第二次 reset 清除。帳號單獨關閉保留成分資料、清空 ownership；music／both 刪除按各自範圍生效。

native profile 轉成與最新 rollback music 相同的固定舊 key；歷史獨有 native profile 也有可逆 deterministic key mapping，但歷史 owner／PIN／contact 全部清空。member.qq、creator、shout author 一起轉換；舊 key 衝突、未知資料欄位、無法表示的作者或不安全數值拒絕，不把 opaque 憑證帶入 data.json。已知生成 key 的定義沿用檢查點 103，沒有第二套演算法。

原舊服務管理入口只接受 `YYYYMMDD-HHMMSS` 目錄，不能無損列出這三個 namespace。因此本批不把它們搬進有效 `paired-backups/`、不捏造時間或覆蓋舊目錄；**完整舊歷史入口 adapter 仍是未完成門檻**。看板歷史 DB／圖片 tar／bot 證據目前只做私人原 bytes 保全，沒有宣稱歷史看板恢復已套最新 erasure 或完整 bot 歷史恢復可用。

## 可選配對 erasure ledger 的既有下載修正

`capture-snapshot.ts` 原本會捕獲 paired backup 的 `erasures.jsonl`，`legacy-music-history.ts` 卻沒有將它列為合法檔案，導致這類正常備份無法下載。新增合法分類、UTF-8／JSONL 完整性驗證，以及每個歷史 QQ marker 都必須在最新捕獲或新庫的 music tombstones 中保留的檢查。歷史與最新 erased_at 不必相同，既有 ledger 可重複記錄同一 QQ；缺少最新刪除意圖則拒絕。既有管理權限、account scope、no-store、redacted 503 和歷史原檔保留規則沿用。

## 獨立對帳與驗證

新增 `rollback-history-reconciliation.ts`，使用獨立保留的完整 raw sources 和 pins，直接核對 byte 集合、manifest、checkpoint／journal digest、完整 namespace／metadata／key mapping 和 latest-authority data；不讀 live 來源、不呼叫 history projector、不信任 report。刪／改 raw 檔案或 manifest、漏／重複 archive／projection、改選擇、owner／PIN、key、namespace、legacy time、digest、version 或加入未分類欄位都拒絕。

相關 **92 項／2 檔通過**（history 65、既有歷史 API 27）；Strict TypeScript 通過。紀錄：`/tmp/qgroup-rollback-history-targeted-final.log`、`/tmp/qgroup-rollback-history-typecheck-final.log`。完整單工回歸 **1,374 項／126 檔通過**，紀錄為 `/tmp/qgroup-rollback-history-native-final.log`。

在捕獲之後修改 live DB／journal，所有投影仍以原固定 checkpoint 為準；在投影途中修改 capture／native bytes 或 inventories 則拒絕。故障和成功後來源沒有寫入，原待送 claim 只留 raw history。實際從原 Python AST 提取未修改的 `administration.snapshot` 和 `maintenance.sanitize`，在隔離輸出讀取投影歷史兩次，確認 reset 範圍與歷史獨有憑證不復活。這是原函式讀取演練，**不是完整舊 HTTP／bot／候選映像或 QQ 驗收**。

所有結果仍為 **`rollbackEligible:false`**，`sourcePolicy:private_original_histories_latest_erasure_projection`。**166 IDs／166 in_progress／0 完整驗收，release_eligible=false**。尚缺完整私人落盤／exclusive reservation／fsync／manifest 和 pinned reader／CLI、舊歷史入口 adapter、歷史看板最新刪除恢復、browser pending／proof 恢復、固定舊 web／music／bot 全套讀寫／重新向前恢復，以及正式規模、裝置／真 QQ 和實際候選版本組合。沒有部署。
