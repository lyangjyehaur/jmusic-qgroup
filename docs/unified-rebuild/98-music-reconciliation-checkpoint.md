# 第九十二批實作：成分來源封存與獨立對帳

日期：2026-11-18（Asia/Taipei）。分支 `codex/unified-rebuild`。變更範圍 **`both`**：離線匯入與共用資料刪除邊界一起調整，仍須驗證候選 web／實際保留 Python 或 TS bot 的組合。實際發布 **`none`**；沒有合入 main、部署、正式資料／憑證／群設定／真實待送操作。

## 來源封存

原匯入只保存成分投影的雜湊，原選擇中的重複項、欄位覆寫及詞條類型 fallback 無法完整回查。現在利用既有 `music_documents` 保存私人、非授權用途的 `profile_source` 與 `entry_source`，不新增 schema；版本維持 **15／96 張表**。

會員來源記錄穩定 profile ID、legacy key、JSON／native 來源及原會員 JSON。原 QQ、原選擇／等級／重複項、created 清單、PIN 摘要、稱呼與聯絡／帳號覆寫之前的值全部保存。詞條來源保留原欄位和類型；正規化後的 main／sub、預設 category 與選擇去重仍維持既有行為。profile migration_map 的 payload_digest 改為原來源會員，而非被投影覆寫後的會員。

封存不加入 API 身份、claim、OAuth、session 或新版回執，也不混入管理 JSON 匯出的公開資料結構。活躍會員與資料仍使用正規化模型；原 PIN／settings／source session 的既有授權界線不變。來源沒有被當成登入／復活的旁路。

## 刪除與帳號關閉

- 成分刪除移除 `profile_source`，即使前一次 replay 已移除 legacy projection 也能依穩定 profile ID 清理，不因缺少舊 row 提早返回而保留私人證據。
- 刪除意圖所涉及的原 legacy key 或穩定 profile ID，都會清除詞條投影及 `entry_source` 的 createdBy，保留詞條及其他人的選擇。來源 members 未包含該 profile 的新版 ledger 也有效；原先僅依 legacy key 遮蔽建立者的缺口已補上。
- 帳號關閉清除來源會員及 native recovery 的 boardUserId，移除相關 session／entry_intent／link 證明；分離的成分原稿、PIN 及聯絡空值仍保留，不因關閉看板帳號而刪除另一份成分。
- 管理 reset 按 ledger 捕捉的 entry IDs 移除相應 `entry_source`，同時維持原詞條／選擇／找搭子／trend 清除範圍；不留下可重建已刪資料的私人原稿。

## 獨立預期模型

`tools/migration/music-reconciliation.ts` 重新讀取不可寫 identity 副本與來源 JSON，獨立推導有效刪除、JSON／native recovery 優先順序、contact、override／prelink／OAuth ownership、已關閉帳號、選擇正規化、原欄位、喊話／歷史 ordinal、trend、PIN 限流、管理清除與 tombstones。它不呼叫 importMusic、projectMusic、seeds 或 privacy replay，也不從 migration_map.status 推斷允許的差異。

候選 **25 張成分表**逐列與預期資料集合相同，包含 source evidence、profiles／fields／contacts／selections、詞條與 details、documents、shouts、legacy identity、erasure、epochs／catalog actions，以及應為空的 native 授權／receipt／history 表。完整核對 music／music-identity 映射的來源 digest、target、source_revision 與去向；被刪、native 找回、失效舊授權、孤立待審及停用管理憑證均有明確狀態。

只有因帳號關閉而改寫的 native／source JSON 使用結構比較，處理 SQLite JSON 改寫時的合法 escape／空白差異；未改寫的 JSON 字串仍要求完全相同。模型會核對原記錄的所有欄位，不以模糊子字串或廣泛排除欄位通過。

identity reader 現在以 safeIntegers 讀取 INTEGER，先檢查安全範圍才轉 Number，並拒絕非有限／過大 REAL 或不能用 JSON 保全的 BLOB／NULL。未知表示方式需要明確審查，不能悄悄捨入或丟值；拒絕時來源不改動、候選不發布。這不是宣稱任意 SQLite 值已全部支援。

`report.musicReconciliation` 記錄來源數量、native 回復／封存／映射／刪除數及各表 rows／digest，不輸出個人列、PIN、session 或來源會員鍵。CLI 維持最小結果，releaseEligible=false。對帳在匯入交易及目錄 rename 前執行，失敗回滾並移除 staging。

## 隔離驗證

- Strict TypeScript 與 production React／API／bot build 通過。主 JS **1,482.05 kB／gzip 432.87 kB**，效能警告仍在。
- 針對性 **73 項／2 檔通過**：匯入 70 項與來源隱私 3 項。新增 JSON／native 完整原稿、原雜湊、原選擇、聯絡清空、Unicode JSON 關閉帳號改寫、數字 native recovery 排序、缺席 snapshot 的穩定 ID 建立者、重播後無 legacy row 的來源刪除，以及 BLOB／大 INTEGER／REAL 拒絕；重跑保留新寫入。
- **23 類成分候選損壞**均阻止發布：選擇等級／順序、ownership、contact、created／note／alias／時間、會員／詞條來源漏失或重複項被改、已刪內容復活、native proof、used OAuth 原列、舊憑證變新版 claim、停用管理憑證狀態、trend、喊話名字／作者、tombstone、來源／身份映射及 erasure timestamp。逐例核對來源不變、目的不存在、staging 清除。
- 完整單工 **1,022 項／116 檔通過**，包含看板 59 表對帳、Python bot／outbox／gateway／財務／授權／備份／恢復差分。release source rejection 是既有負向測試，沒有發布操作。
- compiled smoke 的 API／SQLite／sharp、配對備份／歷史匯出、blocked recovery、bounded room worker、bot 本機 HTTP／WebSocket／ACK／Resume／未知投遞／simulation／CLI／SIGTERM 通過。未啟動正式 worker 或真 QQ。
- 未改 TSX；本批未重跑完整瀏覽器。新的固定映像建置與 archive 隱私 probe 待本批執行後補記。

記錄：`/tmp/qgroup-music-reconcile-targeted-first.log`、`/tmp/qgroup-music-reconcile-targeted.log`、`/tmp/qgroup-music-reconcile-typecheck.log`、`/tmp/qgroup-music-reconcile-native.log`、`/tmp/qgroup-music-reconcile-build.log`、`/tmp/qgroup-music-reconcile-smoke.log`。

## 尚未放行的項目

**166 IDs／166 in_progress／0 完整驗收，release_eligible=false**。本批是來源欄位與候選初始化的獨立對帳，不能取代完整正式來源／歷史備份擷取、identity 原 schema／rowid／高水位封存、跨服務停寫與 real-scale 演練，也不能將已存在目的目錄的舊 manifest 當成新對帳證據。相同來源重跑仍返回初始 manifest，不重驗或覆蓋新寫入。

最新新寫入回退、候選啟用、B01–B15 與實際 bot 版本組合、效能／RAM／磁碟／耗時、實機與 QQ WebView 尚未完整驗收。新的私人封存增加資料大小；不得因合成對帳通過而直接切換正式服務。按照使用者要求先不部署。
