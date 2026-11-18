# 第九十六批實作：新版看板資料的回退投影與對帳

日期：2026-11-19（Asia/Taipei）。分支 `codex/unified-rebuild`。變更範圍 **`both`**：離線投影含 web／bot 共用的 59 張看板表與全部工作狀態；實際發布 **`none`**。沒有合入 main、正式資料讀取／停寫／服務操作或 QQ 投遞。

## 精確投影

新增 `tools/migration/rollback-board.ts`，作為完整新寫入回退匯出器的一個元件，**不是完整回退工具、CLI 或啟用候選庫**。輸入是最新、已明確開啟的 schema 15 新資料庫；不讀切換前舊備份、不遷移來源、不覆寫檔案、不初始化正式服務。

原活動、名冊、邀請／認領、條件與 consent、角色、帳單所有版本、款項／退款、私有圖片引用、通知、時間投票、管理／身份及 bot 共用表仍沿用固定的 59 張舊看板表。投影在來源 `BEGIN IMMEDIATE` 內驗證完整新 schema 及 integrity／foreign keys，複製每列到獨立 memory DB。來源的新增、修改與刪除都以最新列為準，不能只轉回切換前有映射的 IDs。

建立表時暫停目的副本的 FK 並尚不建立 trigger，避免外鍵載入順序、唯讀／append-only trigger 或事件 hook 改寫資料。完成後建立精確原 schema 的 indexes／triggers、開啟 FK 並驗證；原 schema migration ledger 的實際列一起複製，不改成 frozen 建表範例的時間。來源不得已在其他 transaction 中，避免 nested savepoint 被誤認為取得 writer lock。

保留原 signed rowid、SQLite INTEGER（BigInt 綁定）、REAL、TEXT、BLOB 與 NULL，不經 JSON 轉回 SQL；明確保留 59 表的 `sqlite_sequence`，包括空表且已用過的序號及超過 Number 安全範圍的高水位。缺少正 rowid 表所需的序號、低於最大 rowid、負值／非整數、重複或不屬於 AUTOINCREMENT 表的看板序號都拒絕，不自行修復。保留來源 user_version／application_id／encoding。

outbox、claim、已送本文、重試／due_at、`sending` 不確定狀態與 simulation 原樣保留。此元件不把已送轉待送、釋放 claim、真送模擬、修改群設定或呼叫 bot。是否可以交給固定舊 bot 運行仍需之後版本組合與不確定投遞審核。

## 獨立核對與證據

新增 `rollback-board-reconciliation.ts`，重新從 frozen schema 列舉 59 表，直接讀來源與投影，不呼叫投影器、不信任 migration_map 或既有 report。驗證目的 schema／columns／metadata、逐列 rowid／原值及每欄 `typeof`、缺列／多列、序號與兩邊 integrity／FK。資料 mismatch 時關閉兩邊 iterator，避免留下忙碌連線；失敗保留完整來源。

結果記錄逐表列數、rows digest、資料庫 metadata、decimal string 高水位，始終 **`rollbackEligible:false`**。rows digest 是本次看板列證據，不能當成其他領域或完整回退包的 checksum。

合成測試從新版 API 建立活動草稿，確認新增活動、audit／access／去重回執及最新歷史帳單也進投影。涵蓋六種 pending／sending／sent／failed／skipped／模擬工作狀態、凍結本文與 claim、BLOB 帳單圖片、signed rowid／BigInt／NULL／空表高水位、目的 trigger、來源不被修復，以及被修改的列／型別／rowid／schema／序號／metadata 都被獨立 verifier 拒絕。

另以獨立 readonly Python SQLite 連線讀 standalone memory 序列化產物，核對 59 表及列數，沒有初始化或執行工作。這只證明 SQLite 格式可讀，**不是原 Python web／bot 的完整運行驗收**。

最終針對性 **15 項通過**，Strict TypeScript 通過；完整單工 **1,127 項／119 檔通過**；之後僅補報告 metadata／高水位欄位及巢狀 transaction 拒絕，最終相關 15 項與 strict 均再次通過。記錄：`/tmp/qgroup-rollback-board-targeted-verified.log`、`/tmp/qgroup-rollback-board-typecheck-final.log`、`/tmp/qgroup-rollback-board-native.log`。本輪未改 runtime entry、TSX、schema、bot 邏輯或編譯 bundle，沒有重建候選映像、重跑瀏覽器或使用 Docker／正式 QQ。

## 尚需完成

**166 IDs／166 in_progress／0 完整驗收，release_eligible=false**。這只是看板 SQL 元件，不能透過刪除新版額外表、拿輸出當成完整回退資料庫或用它啟動舊服務。

仍需 music JSON／身份／最新 ownership 與原生成分鍵的可逆映射、原私有來源與新增 audit／receipt／consent 的保全、最新 erasure 包及重播、圖片與壁紙資產、原歷史、browser pending requests／草稿、新庫全量 checkpoint／manifest、服務停止與唯一投遞者，以及固定舊 web／music／bot 讀寫演練。任何無法無損表達或未驗證的領域都阻擋整體回退；實際切換與回退工具尚未完成，依使用者要求不部署。
