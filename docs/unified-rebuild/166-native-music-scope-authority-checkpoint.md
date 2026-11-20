# 成分刪除範圍與時間的獨立來源核對

日期：2026-11-21。變更範圍：`none`；僅離線遷移工具、測試及文件。保留 Python bot，不合入 `main`，不部署。

第 165 號的逐列 oracle 能檢查修復副作用，但 legacy overrides 仍可能取自待修復來源的 tombstone／time JSON。若這些值本身沒有原始紀錄，writer 與 oracle 仍可能一起接受它們。本次新增兩個完整投影案例：沒有紀錄的較新 marker，以及偽造原始時間 JSON。修正前兩個案例均失敗，39 個未選案例 skipped；這份基線不是通過報告。

新增獨立來源讀取器，重新讀取並固定原 authority、完整 record chain、baseline bytes 及其 checkpoint SHA。它不匯入 rollback projection 或 service writer，自行從 checkpoint／修復前已提交的記憶體來源推導 alias、生成舊 key、碰撞與本機 rebase／retirement 綁定。baseline ledger 與 checkpoint 的 marker、原 JSON 及已驗證 journal 必須一致；不可換算的歷史 opaque JSON 保留原表示。native 刪除依 journal 順序，舊服務刪除依 record／row 順序，時間倒退也不改用最大時間。最新 imported intent 的 profile、原時間與 authority／checkpoint／record／suffix／row／rebase provenance 必須逐項相符；未知 journal additions 或 native／舊服務交錯寫入拒絕。

待修復來源中已有的 marker／time JSON 只用來檢查是否屬於已知歷史，不作為新授權。沒有原紀錄支持的值會阻擋修復並保留輸入；有紀錄支持的新 tombstone 正常保留，被還原成已知舊 marker 的資料會修復成紀錄中的最新值。完整逐列 oracle 在 writer 完成後再次從原來源推導並比對傳入 context，拒絕錯誤時間、JSON、profile 綁定、缺少或重複 scope、authority pin 及 head pin。baseline、journal、舊 key、imported intents 與 closure membership 使用索引查找，避免對完整清單反覆掃描。

本次增加 23 個案例，另將原先只憑候選值保留新時間的案例改為具有真實 authority intent／receipt 的版本。11 檔／285 個不同 unit／API 案例通過，固定完整 CI inventory 為 178 檔／2,923 unit、81 檔／843 browser；變更檔案由独立 AST 展開核對。最初型別 narrowing 與三個 fixture schema 組裝錯誤保留為診斷，不列為行為證據。嚴格型別、完整建置、built smoke、原 UI 產物與 capability 檢查通過。相對第 165 號，177 個 runtime inputs、2 個 compiled API hashes 及完整 static／worker proof 相同；85 個 precache resources、1,721,246 decoded bytes、619,247 最大批次 bytes、最多 4 assets／一次 cache 操作保持一致。這些數值不代表正式負载／RSS 或真實 QQ 驗收。

第 163、164 號原完整 CI 現已核對成功，分別為 175 檔／2,836 unit、176 檔／2,873 unit，以及各 81 檔／843 browser；原 artifacts、metadata、ZIP bytes、三個 terminal logs、固定 inventory、實際双映像與 precache bytes／keys 均核對。第 165 號 run `44818399039` 的原 image job／artifact 已核對成功；原 unit／browser 在本次最後觀察時仍執行中，沒有重啟原 jobs。本次另有自己的完整 CI，必須取得本次原 run 的終態與完整證據後才能記為通過。

完整 forward projection 現回報 `externalLegacyScopeIndependentlyDerived=true`，表示本 authority epoch 的 scope／time 已從獨立固定來源推導。沒有 authority input 的獨立 row-oracle 呼叫仍回報 false。這不證明相同資料的新世代、跨 authority ancestry、全部 reset generations 或停止 capture custody；不提升發布資格。media／browser pending、完整 B01–B15 與實際版本組合／QQ、正式規模及 audited activation 仍待完成。166 capabilities 仍為 0 fully accepted，`releaseEligible=false`。
