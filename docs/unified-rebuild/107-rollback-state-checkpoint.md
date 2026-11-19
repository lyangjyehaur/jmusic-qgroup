# 第一百零一批實作：同一完整來源的回退狀態組裝

日期：2026-11-19（Asia/Taipei）。分支 `codex/unified-rebuild`。變更範圍 **`both`**：完整新庫、舊看板／身份／成分投影和 bot 待送狀態有跨服務依賴；實際發布 **`none`**。只使用合成來源及私人記憶體資料庫，沒有 main 整合或正式服務操作。

## 固定來源組裝

新增 `rollback-state.ts`，先由檢查點 104 在 standalone `BEGIN IMMEDIATE` 捕獲完整 schema 15 與最新已驗證 durable journal。捕獲完成後開啟私人 memory source，所有後續看板、成分、身份和刪除紀錄投影都讀這一份來源與 cloned journal，不再回頭讀即時資料庫或檔案 journal。

輸出包含完整新庫 SQLite bytes、完整統一 intents、舊看板 SQLite bytes、成分 JSON 與可逆鍵、舊身份 SQLite bytes 與追加 audit mappings，以及三份刪除 journal／scopes。保留新庫中舊模型不能表達的 audit、receipt、privacy consent、mapping 與 bot 工作；不把舊模型的可用投影當作完整來源。所有資料庫連線在成功或失敗時關閉，不返回可寫連線。

這是回退包的**記憶體狀態元件**，沒有 CLI、資產複製、private 落盤／fsync／manifest 或服務啟用。未證明正式規模下的記憶體／執行時間，也未解決 browser pending requests／失效 proof 恢復或管理 credential 的安全承接。結果始終 **`rollbackEligible:false`**。

## 組裝結果的獨立對帳

新增 `rollback-state-reconciliation.ts`，驗證者由呼叫者提供**已固定且可追溯的完整來源及 journal**；不能拿即時庫、別的領域 report 或待驗輸出自己當權威來源。重新驗證 schema／integrity／FK／receipt／intents、完整 checkpoint 與全部新表、舊看板逐列／rowid／storage／sequence、music 現值／原表示／keys、身份 proof／owner／contact／audit mappings，以及 erasure／reset scope。驗證不呼叫任何 projector，也不信任附帶 report。

拒絕未知狀態版本／元件、少表或改列的 checkpoint、改 bot claim 的看板、過時選擇／owner／audit mapping、少 journal 或改 scope、截斷映像和 WAL header。組裝結束時完整 checkpoint 仍與原 bytes 對帳，投影器若意外改寫私人 fixed source 也拒絕。報告包含七個產物的 SHA-256，完整新庫 digest 與各領域語意報告同時保留；digest 不是正式來源認可或服務相容性證明。

## 驗證與限制

完整單工回歸 **1,259 項／124 檔通過**；完整回歸啟動後僅新增私人 fixed source 意外寫入的邊界案例，最終組裝針對性 **19 項／1 檔通過**，Strict TypeScript 再次通過。紀錄：`/tmp/qgroup-rollback-state-targeted-final.log`、`/tmp/qgroup-rollback-state-typecheck-verified.log`、`/tmp/qgroup-rollback-state-native-final.log`。

測試在 music 投影開始時刻意更新即時活動／詞條並新增 both 刪除；捕獲時的看板、成分、身份、journal 仍一致，原 durable journal 只讀一次，拿後來的即時庫當權威驗證就拒絕。reset 後新增成分與詞條、原 erasure receipts、舊 audit 可逆追加、完整新 audit／同意、raw bot sending claim 皆保留。相同來源重組的所有產物 digest 相同；晚期 erasure 失敗時兩個已建立的投影連線關閉，修復合成來源後能重跑。私人 fixed source 的意外寫入有拒絕測試，來源不被改寫。

本輪未改 TSX、網站／worker runtime、schema 或 bot 功能，沒有 HTTP、候選映像或 QQ 驗收。**166 IDs／166 in_progress／0 完整驗收，release_eligible=false**。完整 private 回退包、圖片／壁紙／歷史、browser pending／proof 恢復、固定舊 web／music／bot 成套讀寫、重新向前恢復、候選版本組合、實際 QQ／裝置與正式規模仍待完成。不部署。
