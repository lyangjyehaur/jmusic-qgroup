# 原生重置候選的 epoch 與墓碑邊界

日期：2026-11-21。變更範圍：`none`；僅離線驗證／恢復工具與測試。網站、bot 運行程式、schema、journal 契約、outbox、設定及網址沒有修改。保留 Python bot，不合入 `main`，不部署。

第 161 號已獨立核對 reset 的重置前／完成副本，但候選仍可能帶有較低 owner epoch、重新啟用或變更的原成分墓碑，或不同內容的原詞條 ID。原有全候選逐表比較只能證明修復來源與候選一致，不能證明兩者都沒有倒退。

现在來源與候選的 owner epochs 均須為唯一、非負 SQLite INTEGER；原完成副本的每個 counter 是候選的最低水位，缺失、倒退、TEXT 或 REAL 均拒絕，使用 BigInt 保留 64 位整數精度。較高水位與後續不同 ID 的成分／詞條保持原樣。

原有效成分的完成墓碑必須保留同一 rowid、revision、updated_at、空 owner 與擦除時間。只有原完成 journal 之後已套用且精確核對的 music／both／administrative／imported erasure 可以改變相應墓碑的時間；按 journal 順序取最後一個 intent，不按日期大小猜測。原 reset 詞條 ID 若重新出現，parent row 的 rowid、內容與儲存類型不能與原重置前來源不同；不同內容／位置的同 ID 要求世代證據。

完整投影在第一次 `createPrivacy`／私人修復寫入前，就對已套用 reset 的原始記憶體輸入執行邊界核對。原始 journal 由原 authority intents 與實際 applied markers 精確對應，尚未套用的真實 intent 交由後續恢復；不把待套用 intent 當成已完成的時間或水位證據。原 reset 尚未套用時仍允許原有恢復流程，之後的全站修復也再次核對邊界。

新增檔 **21 個案例**的有效舊版基線為 1 passed／20 failed；最早 owner fixture 觸發既有 CHECK constraint 的無效報告另存。修正後 21 個全部通過，涵蓋五種候選 counter 問題、六種墓碑變化、三種來源 counter 違規、來源／候選共同倒退、較高大整數與後續資料保全、三種真實後續 erasure 的精確時間，以及詞條 ID 的內容／rowid 重用。

既有完整投影案例加入一個原生成分與其原 owner：完成 reset 後重新啟用該 ID 並把 epoch 降至 0，舊私人修復會先把 epoch 加回 1，掩蓋倒退。該原版整合基線為 1 failed／35 未選案例 skipped；新 raw boundary 在 writer 執行前拒絕，而且保持輸入 bytes 與原 authority 不變。最初使用匯入成分的 fixture 被既有 erased-key 檢查拒絕，不能當作新 raw boundary 的證據，因此改用原生成分覆蓋真正缺口。

最終本機 **7 檔／175 個不同 unit／API 案例**全部通過，與獨立 AST 展開的固定清單一致，無 skips。strict、完整建置、built smoke 與 capability 規則檢查通過。177 個固定 runtime source inputs、2 個 compiled API hashes、worker 與 85 個 precache resources 的 proof 相對第 161 號相同；沒有前台改動或新增展示文案。本次完整 CI 預期為 **174 檔／2,813 unit、81 檔／843 browser**；相關案例不代替原完整 CI。

第 159 號原 run `44796568591` 已完整獨立核對：171 檔／2,747 unit、81 檔／843 browser，全量無 skips／retries／flakes，原 ZIP／metadata／CRC／解包 bytes、固定 inventories、三份原 terminal job logs、55 原 Python blobs／177 runtime inputs、實際雙映像、逐資源 precache bytes／keys 均通過。第 160／161 號原 runs `44800843634`／`44802697285` 的實際 Linux 雙映像與原 image logs 已核對；unit／browser 在最後核對時仍執行中，不重啟原 jobs。

本次是必要的最低世代邊界，**相同 key、相同內容與 rowid 的真正新世代仍無法由這些資料判定**；也未完成多次 reset、外部 epoch／high-water custody 或停止 capture。`allResetGenerationsReconciled=false`、`stoppedCaptureCustodyVerified=false`、`releaseEligible=false`。166 capabilities 仍為 0 fully accepted；latest-erasure 私人歷史、media／browser pending、完整 bot B01–B15／實際版本組合與 QQ、正式規模與 audited activation 仍待驗收。
