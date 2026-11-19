# 第九十八批實作：完整新庫與最新刪除紀錄的一致回退快照

日期：2026-11-19（Asia/Taipei）。分支 `codex/unified-rebuild`。變更範圍 **`both`**：完整快照含 web／bot 共用的資料、工作及設定；實際發布 **`none`**。只用隔離合成資料，沒有 main 整合、正式資料或服務操作。

## 同一時點的完整來源

新增 `tools/migration/rollback-checkpoint.ts`。來源必須是明確開啟的完整 schema 15 新庫，拒絕 nested transaction、未知 schema、integrity／FK 錯誤及 journal／applied markers／receipts 不符。獨立 `BEGIN IMMEDIATE` 內讀最新 journal，再序列化完整資料庫；輸出私人 memory bytes、journal 及獨立 report，不寫檔、不覆寫來源、不初始化或啟動任何服務。

來源是 WAL 時，SQLite serialization 已把當下頁面包含在 bytes 中，但 header 仍可能標示 WAL。僅將輸出副本的 read／write version 改成 standalone rollback-journal 格式，再獨立重讀完整 schema／rows／types／metadata；不 checkpoint 原 WAL，不靠遺留 sidecar 讀資料。後續看板 SQL、成分 JSON 及身份回退元件必須共用此快照，不各自讀可能繼續變動的 live DB。

完整來源保留新版額外表，包括審計、回執、同意、遷移原文件／maps、profile tombstones、privacy receipts、設定與 bot 工作；不只保存舊 59 表。沒有清除 credentials、重播 erasure、釋放 claim、重送工作或把 simulation 轉真送。這是受保護的完整來源保全；如何交給固定舊 runtime 仍待成套工具處理。

## 獨立核對

`rollback-checkpoint-reconciliation.ts` 以 readonly memory 連線直接打開 standalone bytes，不呼叫 projector／importer／migrations／privacy replay。核對所有 sqlite_master objects（包含隱式索引）、所有表 columns、逐列 signed rowid／BigInt／REAL／TEXT／BLOB／NULL 及每欄 `typeof`、integrity／FK、user_version／application_id／encoding，以及完整 sqlite_sequence。未知序號、重複序號、非整數／負值、低於現有 rowid 或缺少必要高水位都拒絕，不修復來源。失敗時關閉 iterators 與副本。

另直接核對 captured journal IDs 和副本 applied markers，以及新版意圖的 signature／secret hash。報告包含逐表列數、完整 rows digest、image bytes／digest、decimal 高水位與 journal digest；資料 hash 不能當成資產或歷史檔 checksum。始終 **`rollbackEligible:false`**。

合成測試涵蓋完整新庫與 bot `sending`／claim 保全、私人 migration documents、64-bit 高水位、BLOB／signed rowid、明確同意與回執、最新 music erasure、WAL standalone 副本及兩領域共用來源。刻意修改 row／storage／rowid／schema／metadata／sequence／consent receipt 都被拒絕。來源擷取後再修改活動與成分，固定快照的兩個投影仍保持同一時點。SQLite 的非有限 REAL 原值也保全並區別正負 Infinity，避免 JSON hash 將兩者都變成 null；這不授權 music JSON 投影接受非法時間。

獨立 Python SQLite 連線在 journal reader 執行時嘗試寫入，確認 source writer lock 已持有；擷取及拋錯後均釋放鎖，來源原值／bytes 保持，後續 Python 寫入正常。沒有呼叫原 web／music／bot runtime，不能當成完整舊版本驗收。

最終相關 **58 項／3 檔通過**，Strict TypeScript 通過。完整單工回歸 **1,171 項／121 檔通過**；完整回歸啟動後另補非有限 REAL 的精確對帳，最終相關 58 項與 strict 再次通過。紀錄：`/tmp/qgroup-rollback-checkpoint-targeted-final.log`、`/tmp/qgroup-rollback-checkpoint-typecheck-final.log`、`/tmp/qgroup-rollback-checkpoint-native.log`。本輪未改 runtime entry、schema、TSX 或 bot 邏輯，沒有建置候選映像或瀏覽器／QQ 實機驗收。

## 剩餘工作

**166 IDs／166 in_progress／0 完整驗收，release_eligible=false**。目前只有完整來源 snapshot、看板 SQL 與成分 JSON 的私人元件；沒有完整回退 package／CLI 或候選啟用。

最新身份 SQLite、舊認證安全失效／恢復、生成成分鍵與所有引用的成套可逆映射、最新 erasure 包重播、圖片／壁紙／原歷史、browser pending requests／原稿、私人檔案落盤與 fsync／manifest、固定舊 web／music／bot 讀寫演練仍需實作與驗收。完整來源已保全新版 audit／receipt／consent，但舊 runtime 的承接與重新前進恢復尚未驗證。外部 QQ／裝置、實際候選版本組合及正式規模仍未驗收；依使用者要求不部署。
