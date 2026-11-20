# 無成分與詞條時的歷史重置

日期：2026-11-21。變更範圍：`web`；管理重置預覽、API 與直接 TSX 操作。schema、outbox、群設定、網址、bot 指令及投遞流程沒有修改，保留 Python bot，沒有部署。

舊判斷只檢查成分與詞條，導致沒有這兩類資料、但仍有匿名找搭子、歷史留言或趨勢的站點無法重置。本次把實際找搭子與相關紀錄納入可操作範圍；相關紀錄包括原 `shouts`／`shoutHistory`／`trend`／`trend_sample` source documents 與找搭子發布紀錄。settings-only 或真正空資料仍拒絕重置，不建立 intent 或回執。

預覽新增 `historyRecords`，缺少此欄位的既有 response 解析為 0；不改既有 erasure request／result 與 durable v2 journal 格式。TSX 按實際範圍允許確認，顯示相關紀錄數，空資料給出具體原因。只有找搭子／趨勢時，完成狀態顯示已清空這些資料，取代無助於判讀的「0 份成分、0 個詞條」。沒有新增展示性文字。受重置影響的 shout／trend migration mappings 也納入 revision；範圍核對後改變映射時，寫入 durable intent 前拒絕，其他 namespace 仍保留。

**4 檔／40 個不同 unit／API 案例**通過，其中新檔 **13 個**涵蓋六種單獨殘留來源、空資料／只有設定、後續來源／限流紀錄／mapping 變動、只剩發布紀錄、混合匿名歷史及未知 mapping 保全。逐表比較 typed rows、rowid 與無關業務，驗證原設定、帳號 tombstone、bot 投遞狀態、回執與單次命令；原正常重置、原 Python 行為差分、刪除授權、SQL rollback 與舊副本重播回歸同時通過。初次新檔 7 failed／4 passed 的原報告保留，不能說每次嘗試都成功。

**3 檔／28 個不同 browser 案例**通過，新檔 **3 個**使用真實隔離 API：360px 下清空匿名活躍／歷史資料並保留 bot 通知列表、trend-only 丟失 response 後重新查回原回執、settings-only 即使輸入確認也不能送出。原 25 個管理與 durable erasure 案例的固定 IDs／標題／位置保持一致，沒有 skip／retry／flake。初期 bot query 缺少 scope、使用無活動管理權的身份，以及未清除已完成本機回執就期待看到新預覽，皆取得真正失敗並保留 trace／report。測試改用獨立活動擁有者查通知，管理員執行重置；查回結果後仍須按「完成」清除原本機紀錄。沒有放寬權限或自動丟棄憑證。

strict、完整建置、built smoke、原 Python plain／rich／dry-run 隔離驗證通過。公開 precache 為 **85 資源／1,721,246 decoded bytes**，單次原子 cache operation 上限 **4 資源／619,247 decoded bytes**；static **82 JS／CSS／277 HTTP** 原 bytes 核對通過。這些仍不是正式負載、浏览器 heap／RSS 或實機 QQ 驗收。

API 已改動，獨立 esbuild 重新核對 **177 runtime inputs**與兩個實際 compiled API bundles，不沿用第 156 號 hashes。9 個 compiled bot bundles 中 1 個 byte-identical，其他 8 個的全部差異僅為共用管理 preview schema 與管理空資料 error translation 初始化；逐塊比較保留，不能把它們稱為全部 bytes 不變。固定原 Python 55 blobs 與合成模式繼續驗證；完整候選版本組合仍須新原 Linux image 證據，實際線上 bot 版本與 B01–B15／QQ 尚未驗收。

第 155 號 run `44779742495` 的原 unit ZIP `a68659240584e470fa48be3baf487c7ded2707be7a5d78be4a3e284ce2a3fd5f` 已核對 metadata／CRC／全部 bytes，固定 **168 檔／2,681**案例逐項通過。其 browser job 尚未終態。第 156 號 run `44782162992` 的原 image ZIP `e97e522fbf80d3dafbeb29dab2ba2266c4af09787581519208edc61251dcad5a`、實際雙映像、55 原 Python blobs 與清理已核對；worker／85 precache resources 的整份 proof 與本機一致，另外依 Docker COPY／ignore 規則的同機 234 產物全 byte 對照通過。其 unit／browser 全量結果尚待終態，不能以 image 成功代表整個 run 成功。

新固定來源全量預期 **169 檔／2,695 unit、81 檔／843 browser**。完整原 Linux reports／job logs、實際雙映像、來源 ancestry／high-water／epochs／exact key reuse、latest-erasure 歷史、media／browser pending、停止 capture、正式規模、完整 bot 候選組合及 audited activation 仍待完成。此步修正現行操作，不宣稱已完成已套用 reset 的跨世代恢復。166 capabilities、0 fully accepted、`release_eligible=false`；不合入 `main`、不部署。
