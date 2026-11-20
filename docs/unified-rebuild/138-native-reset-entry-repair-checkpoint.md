# 已套用原生重置的詞條恢復修復

日期：2026-11-20。發布範圍 **`none`**。離線資料恢復按 **`both`** 評估 web／bot 相容性；沒有修改正式服務、Python bot、schema、outbox、憑證或群設定。不部署、不合入 main。

## 實作與核對範圍

從混合快照恢復時，原生 `reset_music` 的 applied marker、真實回執與管理紀錄可能已存在，詞條及其子資料卻再次出現。一般 journal replay 會保留已套用操作，原 forward projector 只拒絕這種詞條復活，未提供修復。

新增 `repairAppliedNativeResetEntries`，只從已驗證的原生 version 2 reset intent 取得詞條 ID。完整核對 applied markers、原 signature／secret hash、回執中的 request／command／profile 數／entry 數及完成狀態，然後在 disposable SQLite 的 foreign-key transaction 清除指定詞條、details、selections、creation memberships、entry source documents，並把原 mapping 狀態改為 deleted。保留原 mapping 的來源、revision 與 digest；不另發回執、建立管理操作或重播 bot 工作。

`reconcileAppliedNativeResetEntries` 不呼叫 writer，也不使用其變更報告。它從修復前的已提交 image 與原 journal 重新建立預期，核對完整 schema、metadata、每張表所有列／順序／值／SQLite storage class、sequence 高水位及 FK integrity。只允許授權範圍的子資料刪除與 mapping 狀態變更；其他詞條、創作歸屬、喊話、趨勢、帳號、回執、管理紀錄及 bot 資料都必須逐列相等。

forward projector 已接入這個獨立階段。先提交原帳號／成分修復到記憶體候選，再固定 reset 修復前 image；完成獨立 oracle 後才回傳 bytes。原始輸入與 authority 不寫入，候選保持 recovery required，`rollbackEligible=false`、`releaseEligible=false`。

這只完成原生 reset 的明確詞條 ID 範圍。原 intent 沒有記錄全域喊話／趨勢的精確來源世代，不能藉重播全域清除把重置後的新內容也刪掉。report 明確保留 `globalResetGenerationsVerified=false` 及 `native_global_reset_generations`。structured old reset 仍拒絕，不能用這個階段替代原 persisted／loaded 五容器 scope 與來源世代核對。

## 本機驗證

原 forward projection 全檔 34 項與新增 reset repair 全檔 23 項，共 **57 項全部通過**，零 failed／pending；strict 通過。涵蓋真實 Python authority 記錄的原生 intent、保留已套用回執後復活詞條的混合 image、未知／缺失 receipt scope、候選 schema／metadata／額外列／mapping provenance／創作歸屬破壞、重複修復、連續兩次重置的 scope 聯集、獨立核對失敗後整筆交易回滾，以及另一 Python SQLite 程序對 serialized source／candidate 的完整逐表與 storage class 核對。

跨 pipeline 案例核對 pending／sending／sent／failed／skipped 的全部 bot 工作、claim／retry／simulation／delivered payload、設定與歷史，以及財務／結算／活動歷史和原管理回執逐列不變。重置後新詞條與喊話保留；authority head、原 journal bytes、輸入 image 均不變。測試初跑有一項 fixture 使用不存在的 provenance 欄位；已改用實際 `payload_digest` 後重新執行完整兩檔，沒有刪除案例或放寬 assertion。

新完整 unit inventory 預期為 **150 檔／2,363 項**；browser 仍 78 檔／833 項。本機 focused 通過不代表尚未執行的新固定來源完整 CI 已通過。

## 已取得的固定來源證據

[第 136 號 run 44670100869](https://github.com/lyangjyehaur/jmusic-qgroup/actions/runs/44670100869) 已 terminal **failure**，來源 `026779924922022dc10f821cee0642ce421a2d9b`。完整 unit 149 檔／2,331 項為 2,330 passed／1 failed；唯一失敗是已於第 137 號修正的舊 inline fixture 抽取。完整 browser 78 檔／833 項全部 passed once，零 skip／retry／flake；實際雙映像亦成功，但不能把整個 run 記為成功。原 ZIP／GitHub digest／CRC／所有解包 bytes、完整 inventories 及原失敗 JSON 已獨立核對。

第 136 號 unit artifact `14599739340` ZIP SHA256：`8aa9146e128f5835221fe421fa5fc94ad640d1895b335b3b34316da10e0eb43f`；browser artifact `14599754320`：`22c75049b5ba166ef7655651f449833aec6f204cb18030c8e86ef2b8bc4c2cee`。原報告保存在私人第 136 號證據目錄。

[第 137 號 run 44672621057](https://github.com/lyangjyehaur/jmusic-qgroup/actions/runs/44672621057) 固定 `41da48c9c2faf39c4c3f2d329f40fe651cb874c4`。其 image job 已完整獨立核對：web `sha256:9cce4607147b3c52e60fcb630713cf44f1f52ad383cfadb03ab02ee2dc142f06`，固定 Python `sha256:a962a373e87e28d4388992e8802eef2a2a8226d9093ed6912c79887b3fcaea35`。55 原 blobs／Dockerfile／實際 websockets 17.4、三模式原被動 dispatcher／callback／投遞 counters、85 HTTP／10 fixture／52 shells 及兩容器退出清理都已核對。這是固定盤點 Python，不能當作已知目前正式 bot 或真實 QQ 驗收。最新 unit／browser 完整結果尚待終態。

## 剩餘門檻

166 項仍 `in_progress`，0 項 accepted，`release_eligible=false`。完整 music erasure／structured old reset／原生全域 reset 世代、外部 epoch ancestry／custody／高水位、私人歷史 latest-erasure、media／browser pending／proof 恢復、真正停止來源服務的 capture 演練、完整 B01–B15／實機 QQ／TS bot＋actual web image 及 audited activation 均仍阻擋正式切換。
