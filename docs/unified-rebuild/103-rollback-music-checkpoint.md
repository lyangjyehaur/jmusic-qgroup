# 第九十七批實作：最新成分資料的舊格式投影與獨立對帳

日期：2026-11-19（Asia/Taipei）。分支 `codex/unified-rebuild`。變更範圍 **`both`**：離線回退資料將來須與固定 web／music／bot 組合一起驗證；實際發布 **`none`**。沒有合入 main、正式資料操作、服務操作或 QQ 投遞。

## 成分 JSON 元件

新增 `tools/migration/rollback-music.ts`，在來源獨立 `BEGIN IMMEDIATE` 內檢查完整 schema 15、integrity／FK 及最新 erasure journal 與 applied markers／receipts，再讀取最新正規化資料。看板元件改用同一 `rollback-source.ts` 來源檢查；不修復來源、不用切換前備份取代新版寫入，也不提供啟用 CLI。

原成分的數字或 `m_<24 hex>` 鍵從 legacy profile／migration_map 保留，包含 tombstones。新版原生 `m_<32／40 hex>` profile ID 透過固定 namespace SHA-256 截取為舊格式鍵，輸出雙向映射；未知 ID、相互衝突的別名、重複鍵及撞到原鍵／已刪鍵都拒絕，不猜測 QQ、暱稱或身份。這是可逆資料對照，不是 OAuth 身份。

輸出 entries／members／shouts／shoutHistory／trend，以最新選擇、建立 provenance、實際儲存的姓名／留言／性別、ownership、PIN 與明確清空的 contact 為準。新詞條作者及喊話作者引用轉成舊鍵，已刪作者清除、已刪成分不重建；已套用 reset 後的新資料保留。原 JSON 的重複選擇、重複建立清單、時間 primitive 型別及缺省欄位，在有效值未變時保持原表示；最新 `last_post_at` 優先於過時 legacy metadata。原會員／詞條文件不被修改。BLOB 字串、不安全時間、非法 flags／aliases／未知欄位拒絕轉換。

`settings` 輸出空物件，防止私人封存的舊管理 hash 被重新啟用。此元件尚未完成舊管理認證的安全遷移；不能用這份 JSON 單獨恢復舊服務。PIN 屬私人回退資料，這不是公開下載格式，也沒有新增 API。

## 獨立驗證

`rollback-music-reconciliation.ts` 不呼叫投影器或管理匯出器，重新讀來源列及原文件，重算鍵映射、完整成分／詞條集合與 tombstones。核對 normalized selections 及原重複表示、完整建立清單／新增詞條、owner／PIN／contact、field／timestamp／provenance、喊話狀態及趨勢、最新 journal IDs；拒絕多餘欄位、缺列及被修改的資料或映射。結果始終 **`rollbackEligible:false`**，data digest 只覆蓋本次 JSON。

最終相關 **44 項通過**，Strict TypeScript 通過；完整單工回歸 **1,156 項／120 檔通過**。完整回歸後補上相同最新喊話限額的原 primitive 表示對帳，以及原生趨勢保留／重複 JSON 鍵／未知欄位拒絕，最終相關測試與 strict 再驗證。紀錄：`/tmp/qgroup-rollback-music-targeted-verified.log`、`/tmp/qgroup-rollback-music-typecheck-final.log`、`/tmp/qgroup-rollback-music-native.log`。

合成測試另使用 AST 取出目前保留的 Python `entry_kind`／`norm_selection`，讀本次 JSON 檢查詞條種類及有效選擇；沒有匯入 service、開啟資料檔或初始化身份庫。這只證明兩個舊 normalizer 可讀，**不是固定舊 web／music／bot 完整讀寫驗收**。本輪未改 runtime entry、TSX、schema 或 bot 邏輯，未建置候選映像或重跑瀏覽器。

## 尚待完成

**166 IDs／166 in_progress／0 完整驗收，release_eligible=false**。已完成看板 SQL 與成分 JSON 的隔離元件，完整回退包仍缺最新身份 SQLite 與可逆映射、舊認證安全失效／恢復、完整新庫 audit／receipt／consent／高水位、latest erasure 包及重播、圖片／壁紙與原歷史、browser pending requests／原稿、來源 checkpoint／manifest 及固定舊版本讀寫演練。舊成分讀取 ownership／contact 依賴身份庫；只保存 JSON 欄位不足以延續登入與聯絡語意。

實際候選 web／bot 組合、正式規模、QQ 實機及切換／回退驗收均未完成。繼續保留原 Python bot；不部署。
