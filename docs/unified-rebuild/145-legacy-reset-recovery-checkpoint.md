# 原全域重設後的完整恢復候選

日期：2026-11-20。發布範圍 **`none`**；資料與恢復相容性按 **`both`** 評估。沒有部署、合入 main 或操作正式資料、bot 憑證、群設定與真實投遞。

## 實作

`forward-legacy-reset-recovery.ts` 接通已完成原 reset 的世代來源、原生刪除投影、完整 business reconstruction、pending proof reconciliation 與首次 source rebase。原 checkpoint、authority、vault、最新舊站 board／music／identity，以及原生分支 image／journal 分別保留 hash 與 bytes。處理過程只產生記憶體中的隔離候選。

共同 baseline 必須由原 checkpoint 單獨套用已核對的重設投影。原生最新分支另行投影；不能用它當 baseline，否則後來新增的原生成分、曲目與留言會被誤認為舊站刪除。實際原 Python Store／save 與兩次 reset fixture，驗證舊站後來重新使用曲目／留言鍵、新會員與新版獨立新增的會員／選擇／留言／趨勢能一起進入 business、proof 和 source rebase。

趨勢允許兩邊保留完整共同前綴後各自追加：共同追加前綴只取一次，之後保留 native 全段，再接 old 的不同尾段。不以时间猜順序，不在不同位置去重相同樣本；重寫或刪除共同前綴仍拒絕。獨立 oracle 自行推導序列。數字物件鍵依 JavaScript array-index 規則枚舉，其他鍵維持約束順序；留言陣列不套用物件排序。

已重新綁定來源的 rollback projector 保留舊 JSON 未填／隱含的 contactQQ 表示；另外核對實際聯絡語意，數字 QQ 鍵仍是有效聯絡號。只在原值語意與現值一致時保留，改變時輸出現值。獨立 oracle 同時核對原欄位表示與實際資料；原未 rebase 的輸出契約維持。

恢復 verifier 重新建立來源環境與 reset reverse relation，逐一核對提供的 source bytes／pins／完整 inventory，再使用既有獨立 business／proof／rebase 全表 oracle；不重跑這三個 writer。business journal 與各 retained image／paired source bytes 必須一致。所有報告的來源、SHA、reconciliation、實際已驗證 migration record 及控制旗標亦核對，不能靠重新填 hash 或把 releaseEligible 改成 true 放行。原輸入／tree／metadata／時間及整組輸出在同步 boundary 再核對。

結果仍 `recoveryRequired=true`、`latestSourceAncestryVerified=false`、`allResetGenerationsReconciled=false`、`releaseEligible=false`；所有普通服務 startup 拒絕候選。完整外部 custody、歷史／媒體／browser 與實際 bot 版本組合尚未通過。原影像、authority 與 vault 不改動；bot 待送／sending／sent／failed／skipped、設定／歷史／runtime、privacy receipts、catalog actions、活動與帳務歷史逐列保全，沒有啟動投遞者。

## 驗證

新 recovery 檔 44 項與 music merge 檔 45 項，共 **89／89 通過**，零 failed／pending。另三種真 Python 關聯／ABA／unlink、session／entry intent 寫入案例 **3／3 通過**，獨立 readonly Python 核對十張身份表全部原 rows／rowid／storage class、實際 audit 數與九張 bot／歷史表，合計 **92 個不同案例通過**；strict、台帳與 diff 通過。完整新來源 inventory 預期 **157 檔／2,544 unit**，browser **78 檔／833 項**。完整相關 18 檔先跑完 **581 項／580 passed／1 timeout**：`forward-account-business` 的 late-authority 案例超過本機預設 5 秒，原失敗報告保留。採 CI 同一 30 秒上限重驗該完整檔 **70／70 通過**，原逾時及全部斷言保留。以完整固定 inventory 逐名核對三份原 JSON，最終 **19 檔／584 個不同相關案例全部通過**，零 pending／遺漏；没有改動或刪減原測試。已通過端到端有／無原生新增分支；擴充測試覆蓋原來源 pins／boundary、未知資料拒絕、獨立中間產物腐敗、retained bytes、報告與晚期輸出突變。最初物件鍵排序與 contactQQ 表示差異的端到端失敗、測試 SQL 欄位錯誤及 TypeScript 診斷保留，不計為通過。

## 固定 Linux 來源

[第 143 號 run 44686125294](https://github.com/lyangjyehaur/jmusic-qgroup/actions/runs/44686125294) 已完成成功：固定 `55516baa08cf707a168fb8c65c78c9f3e857cf8d`，完整 **154 檔／2,475 unit**、**78 檔／833 browser** 的 inventory、identity、location、passed once 均獨立核對，零 skip／retry／flake。unit artifact `14608187832` ZIP SHA256 `e6dfbf8cc7721678bc160dd83a9fcd1934e04569dbb1cefe3775e51132a4e8a0`；browser artifact `14608410316`：`d0e699d6d8d0e5cfd682c0f31b51e8efe3e52cb200be3c6bd3b31f768d77703f`。原 ZIP CRC／全部解包 bytes、175 runtime inputs／55 原 Python blobs、三模式 dispatch／callback／counters、52 deep-link shells 及三個原 job logs 均核對保存。

[第 144 號 run 44702527069](https://github.com/lyangjyehaur/jmusic-qgroup/actions/runs/44702527069) 固定 `bb8d5f6b8bd50797bb5b98926c997b3c874fe74a`；image job 已成功並獨立核對，web `sha256:9c61aa2a81455827dc1dbfd613c275a87c759544ef0dbc7256a0a301ef6b801a`、Python `sha256:dbe0788b9ef09e260b21ebe054236fd9cff45c3dd3480d217ec6947eee2892d5`。artifact `14614015897` ZIP SHA256 `b3848cffdc4d78467d145491b1f1be02e13675c363934173fefc73a979054f64`；pair report `3bfc404b565d48489d008afa946da80e222219b7d01b348264bd31f09a29e835`。browser job 已成功，**78／833** 完整 inventory／identity／location／passed once、原 ZIP／CRC／全部 bytes 及 175 runtime inputs／55 原 Python blobs 的 development counters／dispatch 均獨立核對；browser artifact `14615107184` ZIP SHA256 `e9d408f882cfca31a7a7ac52240a47cb66fd335e19872844af83d48fd3dd18b7`。unit 與整組已 terminal success，**155 檔／2,493 項 unit** 完整 inventory 與原 report 均獨立核對；unit artifact `14614788065` ZIP SHA256 `6a1123ff458999fc5c5836e10b5a51f85f3f945bc5ea9fdc515cb343f3ebe2a3`，三個原 job logs 保存並記錄 SHA／size。不能用前一版結果代替本次改動。固定原 Python 與合成平台不能代替目前線上 bot 身份、B01–B15 或實際 QQ 驗收。

## 剩餘

166 項保持 `in_progress`、0 accepted、`release_eligible=false`。仍須處理 loaded／persisted-only 會員與身份差異、後續 native global reset／重複 epoch／確切 key reuse 的來源鏈、latest-erasure 私人歷史、外部 ancestry／custody／high-water、media／browser pending、真正停止來源 capture、完整 bot／實機／正式規模／固定候選組合及 audited activation；不部署。
