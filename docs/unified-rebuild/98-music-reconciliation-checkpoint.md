# 第九十二批實作：成分來源封存與獨立對帳

日期：2026-11-18–19（Asia/Taipei）。分支 `codex/unified-rebuild`。變更範圍 **`both`**：離線匯入與共用資料刪除邊界一起調整，仍須驗證候選 web／實際保留 Python 或 TS bot 的組合。實際發布 **`none`**；沒有合入 main、部署、正式資料／憑證／群設定／真實待送操作。

## 來源封存

原匯入只保存成分投影的雜湊，原選擇中的重複項、欄位覆寫及詞條類型 fallback 無法完整回查。現在利用既有 `music_documents` 保存私人、非授權用途的 `profile_source` 與 `entry_source`，不新增 schema；版本維持 **15／96 張表**。

會員來源記錄穩定 profile ID、legacy key、JSON／native 來源及原會員 JSON。原 QQ、原選擇／等級／重複項、created 清單、PIN 摘要、稱呼與聯絡／帳號覆寫之前的值全部保存。詞條來源保留原欄位和類型；正規化後的 main／sub、預設 category 與選擇去重仍維持既有行為。profile migration_map 的 payload_digest 改為原來源會員，而非被投影覆寫後的會員。

封存不加入 API 身份、claim、OAuth、session 或新版回執，也不混入管理 JSON 匯出的公開資料結構。活躍會員與資料仍使用正規化模型；原 PIN／settings／source session 的既有授權界線不變。來源沒有被當成登入／復活的旁路。

## 刪除與帳號關閉

- 成分刪除移除 `profile_source`，即使前一次 replay 已移除 legacy projection 也能依穩定 profile ID 清理，不因缺少舊 row 提早返回而保留私人證據。原 key 也從保留的 migration_map 取回，清除同一成分的 legacy-key 建立者、session／identity 原稿及刪除去向；不依稱呼或 QQ 猜測關聯。
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
- 針對性 **74 項／2 檔通過**：匯入 70 項與來源隱私 4 項。新增 JSON／native 完整原稿、原雜湊、原選擇、聯絡清空、Unicode JSON 關閉帳號改寫、數字 native recovery 排序、缺席 snapshot 的穩定 ID 建立者、重播後無 legacy row 的來源刪除，原 projection 不在而映射仍在時的原 key／憑證清除，以及 BLOB／大 INTEGER／REAL 拒絕；重跑保留新寫入。
- **23 類成分候選損壞**均阻止發布：選擇等級／順序、ownership、contact、created／note／alias／時間、會員／詞條來源漏失或重複項被改、已刪內容復活、native proof、used OAuth 原列、舊憑證變新版 claim、停用管理憑證狀態、trend、喊話名字／作者、tombstone、來源／身份映射及 erasure timestamp。逐例核對來源不變、目的不存在、staging 清除。
- 最終完整單工 **1,023 項／116 檔通過**，包含看板 59 表對帳、Python bot／outbox／gateway／財務／授權／備份／恢復差分。release source rejection 是既有負向測試，沒有發布操作。
- compiled smoke 的 API／SQLite／sharp、配對備份／歷史匯出、blocked recovery、bounded room worker、bot 本機 HTTP／WebSocket／ACK／Resume／未知投遞／simulation／CLI／SIGTERM 通過。未啟動正式 worker 或真 QQ。
- 未改 TSX；本批未重跑完整瀏覽器。第一份及恢復邊界補修後的固定映像均已驗證；最終證據使用包含補修的 source／image ID。

記錄：`/tmp/qgroup-music-reconcile-targeted-first.log`、`/tmp/qgroup-music-reconcile-targeted.log`、`/tmp/qgroup-music-reconcile-typecheck.log`、`/tmp/qgroup-music-reconcile-native.log`、`/tmp/qgroup-music-reconcile-build.log`、`/tmp/qgroup-music-reconcile-smoke.log`。補修檢查：`/tmp/qgroup-music-reconcile-orphan-before.log`（原 key 保留的失敗證據）、`/tmp/qgroup-music-reconcile-targeted-final.log`、`/tmp/qgroup-music-reconcile-native-final.log`、`/tmp/qgroup-music-reconcile-typecheck-final.log`、`/tmp/qgroup-music-reconcile-build-final.log`、`/tmp/qgroup-music-reconcile-smoke-final.log`。

## 固定來源映像

核心實作來源 `7b3a44a604002921a1e2add803d39e919d272b3a`。首輪乾淨 archive 的映像建置，在 better-sqlite3 的 node-gyp 從 nodejs.org 下載 Node v22.22.3 headers 時遇到 ECONNRESET／socket hang up，未成功產生候選映像。

隔離 Node 基底 probe 已確認 `v22.22.3`／x64 及 `/usr/local/include/node` 的 node.h／config.gypi／common.gypi 存在。`deploy/unified.Dockerfile` 現在以 `npm_config_nodedir=/usr/local` 使用同一基底內的標頭編譯，減少額外下載；不改套件版本或原生功能。實際編譯與載入仍須通過，沒有用略過 native 模組解決失敗。

新映像來源 **`b093a6009570a0c32d3b0fbde50ee0de36781d01`**、tree **`5033ebd59dbf61757edc8c83a136018b58c323bd`**。`prepare-image.ts` 已從乾淨工作目錄封存這個完整 SHA 到 `/tmp/qgroup-image-b093a60-music-reconcile/context`；purpose 是 rehearsal，未走正式發布或 registry push。來源工具的 2 項隔離測試也通過，包括未合 main 的正式來源拒絕。

第一份固定映像 `sha256:d126d0034ee26e9753a69f0a8db84ca0dcae43c4e0149e14a3edeeaff5b46666`、config `sha256:c92ed007b05dfb2829f03761a586a9ece3c3e8ac3d1be66b26ab1abc4b8c0233` 已通過 schema 15、24 shell／4 error／3 archive probe、非 root／512 MiB／network none／SIGTERM；容器與 volume 已清除。

之後新增原 projection 已缺席、mapping 尚在的恢復案例，初次驗證保留了原 key 的 creator，確認舊分支提早 return 的缺口；以映射取回原 key 修正，針對性 74 項通過。這份早期映像不包含補修，不能算作最終候選或已核准回退。補修後完整回歸 1,023 項、strict／build／compiled smoke 均通過；最終固定映像已完成以下驗證。首輪及新建置紀錄：`/tmp/qgroup-music-reconcile-image-build.log`、`/tmp/qgroup-music-reconcile-image-build-final.log`、`/tmp/qgroup-music-reconcile-image-source-final.log`、`/tmp/qgroup-music-reconcile-image-source-test.log`。

### 最終固定來源與驗證

最終來源 **`666436093189eacafad83e36e566d9cdbd166c1b`**、tree **`3165b3ddf0c611cb0b772c107c16c778876bed01`**。乾淨 archive context `/tmp/qgroup-image-6664360-music-reconcile/context`，tag `qgroup-unified:rehearsal-6664360`。實際 Docker image ID **`sha256:a6774a8b96780be98e7453ee348c376d8d0733d2dfbe5a7da14a1456f5b2cc8c`**、config digest **`sha256:8ba8e28d310026bfe3403aee5047d8433bc6803293b2b24fc8e51d054845312b`**；建置成功，包含同版 Node 標頭與映射補修。後續此文件修訂不改變已建置 runtime 來源。

本機 OrbStack arm64 模擬 linux/amd64，不視為 server2 實測。相同固定 image 驗證通過：schema 15、零 users／統一同意／回執、SQLite／sharp、公開 shell 24 項及錯誤契約 4 項。新增 archive probe 4 項涵蓋原 projection 缺席時的會員來源清除、保留分離音樂的帳號關閉、stable-ID 建立者遮蔽，以及依原 mapping 清除 legacy-key 建立者／私人 proof／刪除狀態。

UID/GID 994:992、readonly／cap-drop／no-new-privileges／network none、512 MiB／無額外 swap／1 CPU／128 PIDs、SIGTERM exit 0 通過。probe 使用額外的記憶體合成庫，主驗證庫始終零會員；沒有啟動真 QQ。映像內 bot 僅版本／合成健康，完整 mock runtime 另由 compiled smoke 驗證，不能代替實際候選組合。

驗證容器及 volume 已移除，結束後再次核對 rehearsal 標籤清單為空。沒有 registry push、正式服務操作或 main 整合。最終記錄：`/tmp/qgroup-music-reconcile-image-source-complete.log`、`/tmp/qgroup-music-reconcile-image-build-complete.log`、`/tmp/qgroup-music-reconcile-image-verify-complete.log`。

## 尚未放行的項目

**166 IDs／166 in_progress／0 完整驗收，release_eligible=false**。本批是來源欄位與候選初始化的獨立對帳，不能取代完整正式來源／歷史備份擷取、identity 原 schema／rowid／高水位封存、跨服務停寫與 real-scale 演練，也不能將已存在目的目錄的舊 manifest 當成新對帳證據。相同來源重跑仍返回初始 manifest，不重驗或覆蓋新寫入。

最新新寫入回退、候選啟用、B01–B15 與實際 bot 版本組合、效能／RAM／磁碟／耗時、實機與 QQ WebView 尚未完整驗收。新的私人封存增加資料大小；不得因合成對帳通過而直接切換正式服務。按照使用者要求先不部署。
