# 原生重置的自增編號水位驗證

日期：2026-11-21。變更範圍：`none`；僅離線恢復／驗證工具與測試。沒有修改網站、bot 運行程式、schema、outbox、設定或網址；保留 Python bot，不合入 `main`，不部署。

固定的重置前／完成副本原先可以共同帶有不合法的 `sqlite_sequence` 而通過逐表核對；恢復來源與候選也可能共同低於原完成水位而通過。現在一般與 orphan-only reset 均驗證實際 AUTOINCREMENT 表名、唯一 counter、非負 INTEGER，以及不低於存活 rowid 的水位。一般私人準備模型與完整候選 oracle 也執行同一物理一致性檢查。

候選在首次修改前，按精確 BigInt 比較全部原完成 counter；缺失或倒退即拒絕，不清除任何歷史。允許後續水位升高，保留已刪除資料留下的合法水位，避免用存活最大 rowid 取代既有水位。

新增 14 個案例的原始基線為 12 failed／2 passed。修正後 **5 檔／123 個不同 unit／API 案例**全部通過，並與獨立 AST 展開的固定清單核對；涵蓋七種共同損壞來源、orphan-only、三種候選倒退、來源／候選共同倒退、較高水位与 bot 待送 rows 保全，以及 `9007199254740993` 的整數精度。strict、完整建置、built smoke、capability 檢查通過。

相對第 159 號，177 個已固定 runtime inputs、2 個 compiled API bundle hashes、worker 與全部 85 個 precache resources 的 proof 相同。沒有前台改動或新增展示文案。本次完整 CI 預期為 **172 檔／2,761 unit、81 檔／843 browser**；本機相關案例不能代替該提交的原完整 CI。

第 157 號原 run `44788292528` 已完成獨立終態核對：169 檔／2,695 unit、81 檔／843 browser，全部原報告、ZIP、三份原 job logs、Python source／runtime pins、實際雙映像及 precache bytes 已核對。第 158 號原 run `44791726727` 也已完成：170 檔／2,726 unit、81 檔／843 browser，無 skips／retries／flakes；原 unit ZIP SHA `515f8074f9ef815c49840a3209a65f94ef154641a39798391c9d064db76d4dcb`、browser ZIP SHA `93d768ec036a3f6091d4f0c75110fea0faf40fb83e0b7c73ffea79dfcf46687e`，metadata／CRC／解包 bytes、固定 inventories、原 logs、development Python 與 85 個逐資源 cache／request keys 均核對。第 159 號原 image ZIP SHA `d9098167aad9385d7df11a57104843b3ddec5d08d4d2c4652c95f3975398f220`及實際 Linux 雙映像已獨立核對，完整 run 尚待終態；不重啟仍在執行的原 jobs。

私人重置準備仍共用服務 writer；含成分來源的 `fullPrivateScopeIndependentlyVerified=false`。本次物理 counter 檢查不證明外部 high-water custody、完整 epoch／key-reuse ancestry、多重 reset 或停止 capture。166 capabilities 仍為 0 fully accepted，`releaseEligible=false`；完整 bot B01–B15／實際版本組合與 QQ、私人歷史、media／browser pending、正式規模與 audited activation 仍待驗收，整體目標未完成。
