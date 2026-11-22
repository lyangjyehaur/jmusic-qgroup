# 恢復副本啟用工具與本機驗證

2026-11-23。變更範圍 **`both`**：新增離線恢復副本啟用工具及原生網站的 receipt／刪除紀錄綁定；輸出的資料庫供 web／bot 共用，須继续核對實際版本組合。schema、既有 bot 指令與投遞狀態未修改。實際發布 **`none`**；不合併 main、不部署、不重啟正式服務、不發送 QQ 消息。

## 實作

`npm run activate:recovery-copy -- <private-input.json> <external-input-sha256>` 只接受明確釘選的完整 v2／v3 私人回退套件、獨立保留的 erasure authority、私人 review 及 source／capture／versions／bot 四份 review 文件。各文件另外提供 SHA256；工具核對原 checkpoint、lineage、bot state、原始 unified ledger 與被審核的 authority head，不從移動中的標籤取得版本，也不讀取環境檔。

工具在記憶體中產生新 SQLite image，允許的唯一資料差異為 `rebuild_storage.recovery_required` 的 1→0。原 storage trigger 的 SQL 恢復為完全相同；全部其他表的型別、值、rowid、sqlite_sequence、DDL 及相關 SQLite metadata 均另行比對。`sending` 或非模擬 `skipped` 的完整列必須逐列記錄 `preserve`，不把它們改成 pending，不更改已送、重試或模擬資料。

新目的目錄包含 `data/` 與獨立的 `activation/`。原圖片／壁紙檔案、bot 外部檔案及原奈秒 mtime 完整保留；原 package、checkpoint 與 authority 不變。檔案使用 0600、目錄 0700，拒絕現有目的地、來源重疊、符號／硬連結、來源或目的地的晚到改寫。失敗保留 incomplete 標記，自己的資料庫改名為 `unified.sqlite3.incomplete`，receipt 也失效；不覆寫被替換的檔案或目錄。

原生 retained journal 新增可選設定：

```text
REBUILD_RECOVERY_ACTIVATION_ROOT=<獨立 activation 目錄>
REBUILD_RECOVERY_ACTIVATION_MANIFEST_SHA256=<外部保存的 receipt SHA256>
```

兩者必須一起提供，並沿用原 `REBUILD_ERASURE_AUTHORITY_*` 與原 blocked checkpoint；不得改用新 checkpoint 重新建立 sequence 0。沒有 receipt 時原 blocked checkpoint 仍拒絕啟動。receipt 證明原快照只解除旗標，並綁定原 authority 中已審核的歷史前綴；之後的 unified intent 可以沿同一鏈續寫和跨重啟讀取。舊 board／music intent 未完成 forward projection 時仍阻擋。整個生命週期保持 flock 排他、receipt 不可改寫及 SQLite inode 保護。

這兩個設定目前供隔離原生啟用演練使用。既有固定版本 runtime manifest／Compose 檢查器尚未綁定 activation receipt，現在明確拒絕這種配置，不冒稱已完成版本驗證。Python bot 的組合證據仍須另外核對；review 中的版本欄位與文件 SHA 本身不证明功能相容、正式停寫、外部保管來源鏈或 QQ 平台结果。

## 同一線上隔離副本

沿用已授權擷取的第 219 批副本，原 capture manifest 為 `591a7209bf5ef07b3a79569a4abd411899660acfcf25b24ee1fb9e38098bbd7c`。使用第 221 批完整 forward 後的 package `ca4803d50869b6951036feef29696caf56f1713ab1b304f9ac21b21c512eb327` 與獨立 authority `b262138260a053f767f02588423f2de3f4652898fd16af774fb6135d78bea759`，只產生新的本機私人副本。

核對結果：

- **97 張表**：96 張全部相同，storage 表只解除恢復旗標。獨立 Python 分別比對封存 snapshot 與原生讀取／重啟後的資料庫，含型別、rowid、DDL、sequence、metadata、integrity 與 foreign keys。
- **4 張原圖片、1 份原壁紙清單、6 個 bot 外部檔案**及奈秒 mtime 完整保留；原 unified ledger bytes 相同。
- **7 筆 `sending`／非模擬 `skipped` 審核列**完整保留，沒有重置或投遞；不能由這個數字推定它們都曾向 QQ 送出。
- 原生 retained journal 跨 **2 次重新開啟**讀取正常，同一 lineage／authority 保持不變；原生 bot 幫助指令可唯讀查詢。

本次 review 的版本參照沿用第 218 批已匯出實際 bot 映像的隔離組合，啟用後讀取使用當前本機原始碼。**沒有執行當前修改的固定映像成套驗收**，不把較早映像證據算到本批。這份來源也不证明正式跨服務停寫邊界或獨立 authority 的外部 ancestry／high-water／custody。私人來源、腳本、review、receipt 與結果均在 Git 外保留。

## 回歸與剩餘工作

本機 **160 個不同相關案例**通過：40 個本批新增案例及 120 個既有恢復、retained journal、bot runtime／reply、Compose 案例。涵蓋非空的待送／sending／已送／failed／模擬／不確定資料、原鏈續寫與重啟、舊服務 intent 阻擋、原副本啟動拒絕、晚到改寫及原生 SQLite writer lock 保全。TypeScript strict 及 API／bot bundle 建置通過。

初始測試腳本失敗保留：測試日期混淆本地日與 UTC，CLI 正確拒絕未來 review；舊服務 ledger 放置在 authority 上層，原 Python 正確拒絕來源重疊；rowid probe 先碰到 storage 的 CHECK 限制；inode probe 最初在 receipt 目錄多放了檔案，先被 inventory guard 阻擋。修正腳本位置、時間與 probe 後重跑，沒有放寬實作條件。相關既有檔案的成功案例及本批重新跑出的案例分開取證，不把初始整組失敗報成通過。

`0059259f4b5382d54aedb79a769edfddd8d4dafb` 的 [CI 45056896434](https://github.com/lyangjyehaur/jmusic-qgroup/actions/runs/45056896434) 已取得三個工作／全部步驟成功終態與原 artifacts：unit **4,063**、browser **1,047**、image 通過；browser 無 skip／retry／flaky。逐檔比對原提交的測試與固定 Python 來源 pins。该提交包含第 221 批手機工具，**不包含**第 222 批兩項跨裝置管理測試及本批 activation 修改；image 是 observed-source Python 重建組合，實際匯出映像的證據仍分開保留。較早 subprocess timeout 與間歇性恢復失敗記錄沒有刪除，也未宣稱根因已解決。

本批沒有新增完整父項驗收：仍為 **10 個既有父項通過、156 個及 U01–U03 待完整審核**。P6 剩餘為全台帳審核、當前固定版本的 activation／恢復成套驗證，以及固定舊 web／music／bot 的全部回退操作；不移到 P7。`originalP6Complete=false`、`releaseEligible=false`。本機預覽仍可於 <http://127.0.0.1:5082> 使用，schema 15 健康；操作方式見[本機測試指南](local-testing.md)。
