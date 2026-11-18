# 第九十一批實作：看板來源與刪除結果獨立對帳

日期：2026-11-18（Asia/Taipei）。分支 `codex/unified-rebuild`。變更是離線匯入工具及驗證；因匯入結果包含網站、bot 共用資料，影響先按 **`both`** 評估。實際發布範圍 **`none`**：未合入 main、未部署、未讀取或修改正式資料／bot／憑證／群設定／待送工作。

## 固定來源範圍

原匯入器用表名前綴排除部分新表，可能把 appearance、unified_privacy、legacy_local 或 create_intents 等表當成舊看板來源。現在直接從凍結 `legacySchema` 取得 **59 張表**；原始及刪除後的計數、board／erasure 映射只涵蓋這份清單。新增表不會混入來源統計。

`tools/migration/board-reconciliation.ts` 在候選發布前，另外打開不可寫的來源副本及全新的私人預期副本。預期副本只含原看板 schema，按照獨立的帳號關閉規格重播刪除，不呼叫 API privacy replay，也不根據 migration_map.status 推斷哪些異動可以通過。

每張來源表核對原欄位及外鍵、schema SQL／索引／trigger、rowid、主鍵和全部欄位。schema 15 的 `unified_privacy_erasure` 是候選 schema 中明確存在的額外 trigger，不將它算成舊來源；未經目前 schema 定義的額外 trigger 會拒絕。序號與預期副本完全相同，包含刪除前高水位及管理角色關閉新增的審計序號，不能任意降低或增加。

逐列核對來源映射的原 payload digest、revision／version、target ID 及保留／刪除／遮蔽狀態；新增刪除審計與請求逐筆核對 erasure 映射。兩個 namespace 的總數也必須相同，防止錯分類、漏列或插入假映射。讀取每批 256 列並使用 SQLite safe integers；不將大整數轉成 JS Number，BLOB、NULL、字串及原時間全部保持原型別和值。

## 刪除與 bot 邊界

獨立規格涵蓋帳號關閉的 session／裝置／QQ 授權清除、個人資料與收款碼清除、無引用圖像移除、管理角色降權及審計、活動查看授權移除、活躍投票票數版次、帳號匿名化及 privacy request。來源本來已存在的 privacy request 保留其原歷史；配對 music 匯入新增的共享歷史也需要獨立核對是否轉為 shared_review。

只有此次刪除意圖真正關閉的帳號，其隨機 token_hash 使用固定佔位值比較；仍檢查實際 token 是 64 位 hex，且不是任何來源帳號的原 token。其他 user 欄位完整比對。報告分別保留實際最終列與比較列的 digest，不把匿名化差異藏入通用「忽略欄位」清單。

活動、名冊、財務、每版結算、BLOB 及全部 bot 表與來源逐列比較；除了明確的刪除規格，不接受任何差異。已送／待送／sending／failed／skipped、simulation、claim、重試時間、已投遞本文、群及模板設定都不可被匯入重寫。這是離線資料保全證據，不是候選 bot 的真實 QQ 或實際線上版本組合驗收。

刪除 applied marker 必須與唯一意圖集合一致；新版簽名回執的 signature／secret_hash 與原 ledger 一致，回執總數正確。衝突的舊版 request ID 也會拒絕，即使 API replay 原本因已有 applied marker 而跳過第二筆。此處不宣稱完整 music 來源對帳或所有回執本文均已完成獨立驗收。

## 私人報告與失敗處理

`report.boardReconciliation` 記錄 tableCount、來源／重播列數、撤銷 token／刪除意圖數、schema／sequence digest，以及每表來源／最終數量、preserved／redacted／erased／replayed 數量和三種表 digest。沒有列內容、使用者 ID、原 token 或簽名原文；報告與候選仍在私人目錄。CLI 維持只輸出 status、sourceDigest、schema、releaseEligible=false。

任何差異在匯入交易及目錄 rename 前拒絕，移除 staging 目錄，不發布半成品。成功後預期及來源暫存副本與 sidecars 一起移除；正式輸入副本不改動。新增預期副本需要額外磁碟及掃描時間；正式資料規模、RSS、耗時與停寫鎖尚未驗收。

相同來源重跑保留既有目的目錄及較新的業務寫入，只回傳原匯入 manifest。`verified` 是當次初始匯入的看板對帳證據，不能當成現行庫持續對帳、舊 manifest 升級、回退、整體遷移或正式切換放行。

## 隔離驗證

- 匯入測試 **40 項通過**，包含既有 14 項、600 列跨批次、超過 JS 安全整數範圍的 SQLite INTEGER、BLOB 原字節、來源零修改、私人權限、重跑保全、管理降權、重複／既有／不存在帳號刪除、open／closed／decided／cancelled 投票及跨 session／QQ 授權刪除。
- **22 類候選損壞**均拒絕發布：已送變待送、simulation 清除、claim／retry、已送本文、BLOB 缺字節、rowid、原 token 復活、其他 user 欄位、錯誤 shared status、序號前後異動、原 trigger 缺失、額外 trigger、未分類欄位、映射 digest／漏列／假來源／錯狀態／審計，以及刪除 marker 缺失／多出／簽名回執變更。逐例核對來源 digest 不變、目的不存在及 staging 清除。
- 最初一個新案例以 positional INSERT 忽略了 privacy_requests 的第六個既有欄位，fixture 準備失敗；改為明確欄位後通過，未放寬產品驗證或刪除斷言。
- Strict TypeScript 與 React／API／bot production build 通過。主 JS 維持 **1,482.05 kB／gzip 432.87 kB**，仍有 bundle 過大警告；此批沒有完成效能驗收。
- 完整單工原生回歸 **989 項／115 檔全數通過**（`npm run test:rebuild -- --maxWorkers=1`），包括既有 Python bot、gateway／outbox／投遞、金融、備份／恢復、跨語言差分與匯入。release source rejection 是既有負向測試，沒有發起發布。
- Compiled smoke 通過空合成庫的 API／SQLite／sharp、配對備份／歷史匯出、blocked recovery、bounded room worker，以及 bot 的本機 HTTP／WebSocket／ACK／Resume／未知投遞／simulation／CLI／SIGTERM。沒有真 QQ 連線或正式 worker。
- 未改 TSX、API runtime、bot runtime 或 schema；本批未重跑完整瀏覽器或建立新的固定映像。不將既有瀏覽器／映像證據算成這批的新驗收。

本機記錄：`/tmp/qgroup-board-reconcile-targeted.log`、`/tmp/qgroup-board-reconcile-typecheck.log`、`/tmp/qgroup-board-reconcile-native.log`、`/tmp/qgroup-board-reconcile-build.log`、`/tmp/qgroup-board-reconcile-smoke.log`。

## 待完成

保持 **166 IDs／166 in_progress／0 完整驗收、release_eligible=false**。此批完成看板來源範圍及獨立刪除對帳，仍需 music／identity 全來源逐欄對帳、最新新寫入回退、候選啟用與實際 web／保留 Python 或 TS bot 版本組合、B01–B15 成套驗收、效能及實體裝置／QQ WebView。按照使用者要求先不部署。
