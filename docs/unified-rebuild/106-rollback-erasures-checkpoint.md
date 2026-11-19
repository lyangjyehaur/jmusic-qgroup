# 第一百批實作：最新刪除紀錄回退與原程式重播

日期：2026-11-19（Asia/Taipei）。分支 `codex/unified-rebuild`。變更範圍 **`both`**：最新帳號／成分刪除紀錄與固定舊 web／music／bot 資料有跨服務依賴；實際發布 **`none`**。只使用合成來源與隔離暫存檔，沒有 main 整合、正式資料、憑證或服務操作。

## 同一來源的最新刪除紀錄

新增 `rollback-erasures.ts`，在 standalone `BEGIN IMMEDIATE` 內驗證完整 schema 15、最新 durable journal／applied markers／receipts 及同一來源的 music 投影。輸出舊看板 `{user_id,request_id,created_at}` JSONL、舊成分 `{qq,erased_at}` JSONL、完整統一 journal，以及每筆原操作的舊 profile key／entry ID scope。這仍是私人記憶體元件，不提供 CLI、啟用或完整回退包；與其他投影一樣須使用檢查點 104 的同一來源快照。

看板 ledger 只包含原帳號關閉及 v1 account／both，不能把 music-only、管理刪除或 reset 轉成關閉帳號。保留原 request ID／時間；目前 privacy_requests 中不在 journal 的早期關閉也加入，不能因同一帳號已有較晚請求而丟失原標記。ID 撞到其他類型意圖、同 ID 的帳號或時間不符、存在帳號卻缺目前關閉標記，都拒絕。舊 Python recover 依目前 privacy_requests 跳過已關閉帳號，因此不能只憑新版 erasure_applied 授權重新刪除。

成分 ledger 保留 music_legacy_erasures 的原 erased_at JSON 表示，不猜原未知時間；加入最新 tombstone 的原鍵或確定性生成舊鍵，缺 mapping／tombstone、非法鍵、損壞或不安全 JSON、非法新版刪除時間都拒絕。原 durable journal 的重複同一意圖保留，兩份舊 ledger 與 scopes 按原 request ID 去重。scope 帶 `alreadyApplied:true`，保留 reset 當時的 entry IDs。

## 重播範圍與獨立拒絕對帳

結果始終 **`rollbackEligible:false`**、`scopePolicy:latest_projected_data_only`。舊 music ledger 無法表示 reset 的詞條／歷史範圍，不能拿它對任意歷史備份宣稱完整刪除恢復。必須搭配已套用最新刪除的當下 JSON／身份／看板投影、完整來源 checkpoint 及統一 scoped journal；不能對目前投影重新執行整站 reset，否則會刪掉重設後的新寫入。

`rollback-erasures-reconciliation.ts` 不呼叫 erasure projector，從原 markers、最新 tombstones、music keys 與已驗證 intents 獨立推導兩份 ledger 和 scope，重新驗證 receipt／journal 及 music 投影，不信任傳入 report。核對原 JSON 表示、列順序、重複意圖、完整欄位／換行、scope／mapping 及沒有 erased member；JSON 重複欄位、空白列、額外欄位、截斷行或篡改都拒絕。報告包含三份 journal bytes 的 SHA-256 及 scope 的 canonical digest。

## 已驗證與限制

針對性 **45 項／1 檔通過**，Strict TypeScript 通過；完整單工回歸 **1,241 項／123 檔通過**。紀錄：`/tmp/qgroup-rollback-erasures-targeted.log`、`/tmp/qgroup-rollback-erasures-typecheck-final.log`、`/tmp/qgroup-rollback-erasures-native.log`。

測試實際匯入原 Python `qgroup_core.privacy.recover`、`music_site.maintenance.replay` 和 `Store`，只在本次生成的隔離舊看板／身份 SQLite 與成分 JSON 連續重播兩次，再獨立逐列／rowid／型別／schema／sequence／audit 對帳。帳號關閉不再改 token 或歷史；reset 後新成分、重用原詞條 ID 的新詞條與新喊話均保留。原未知刪除時間、duplicate journal、早期 marker、native 新鍵、缺失／衝突來源與各輸出篡改亦有拒絕測試。來源不被改寫，失敗前完整 checkpoint 仍可讀取。

這是原刪除元件的合成資料重播，**不是固定舊 HTTP web／music／bot 完整候選版本組合驗收**；沒有 QQ 投遞或正式服務啟動。本輪未改 TSX、API／worker runtime、schema 或 bot 功能，沒有候選映像建置或瀏覽器驗收。

**166 IDs／166 in_progress／0 完整驗收，release_eligible=false**。完整回退 package／private 落盤／fsync／manifest、圖片／壁紙／歷史、browser pending requests／失效 proof 恢復、固定舊 web／music／bot 讀寫與重新向前恢復仍待完成；實際 QQ／裝置、候選版本組合及正式規模驗收仍待取得。不部署。
