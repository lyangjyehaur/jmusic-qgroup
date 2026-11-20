# 原生私人修復的獨立逐列核對

日期：2026-11-21。變更範圍：`none`；僅離線遷移核對工具與測試。保留 Python bot，不合入 `main`，不部署。

原投影的私人修復使用網站共用 `replayMusicErasure`，後續 reset 核對卻以私人修復後的快照為來源。因此，共用 writer 改掉無關資料後，後續來源與候選可能一致，仍不足以證明私人修復沒有副作用。完整投影案例刻意讓此 writer 把原 bot pending 工作改為 failed：舊版正常接受結果，基線為 1 failed／35 未選案例 skipped；新版獨立核對器拒絕，確認 writer 實際改到了資料，且輸入 image 與 authority bytes 保持不變。

帳號修復先在已有的獨立帳號 oracle 下完成，並提交到此次持有的記憶體候選；其後才擷取私人修復前的完整來源。沒有以未提交交易的 serialize 結果作為來源。新增核對器不匯入 privacy、ownership 或 erasure writer，直接從已驗證的原 journal 按順序推導最新 native profile scopes，另接受原 authority／baseline 關係提供的 legacy overrides。實際修復仍使用現有 service writer；新報告以 `oracleUsesServiceWriter=false` 明確區分修復與驗證。

核對涵蓋完整 schema、metadata 與全部 table rows：tombstone 的原 revision／updated_at／rowid、私人欄位與各類歷史、認領與登入 proof、原保存操作及結果、alias identity、creator 遮蔽、留言與來源影子、mapping provenance、owner epochs，以及新增 tombstone／mapping／legacy time。SQLite storage classes、完整 opaque JSON 與 rowids 保持精確；creator 遮蔽與原 time JSON 驗證使用唯讀 SQLite，沒有數值解析後重新輸出。原 receipt 綁定、普通登入、其他成分、公開詞條、共享資料、原權威紀錄與全部 bot rows 必須保持原列。`sqlite_sequence` 除合法性檢查外，也明確逐列保持不變。負數最大 rowid 的自動分配按 SQLite 原規則處理；最大 INTEGER 下不可預測的隨機分配拒絕。

新增 **27 個案例**。最後 **10 檔／262 個不同 unit／API 案例**全部通過，與固定 inventory 及獨立 AST 展開一致，沒有 skips。一次原 Python fixture 超過本機預設 5 秒，保留 261 passed／1 timeout 的失敗紀錄後，按既有 CI 的單 worker／30 秒設定重新完整核對，不將超時報告記為通過。最初新檔命名碰到既有 merge oracle，已恢復原檔且逐 byte 核對，改用獨立檔名；最初 strict／整合失敗不列為行為證據。原保存結果 fixture 的 REPLACE 會 cascade 掉 receipt，已在來源組裝最後恢復原 receipt；新增檢查也補齊了最初缺少的明確 sequence 比對，並允許 genesis authority 的空 head。

strict、完整建置、built smoke、原 UI 產物與 capability 規則檢查通過。相對第 164 號，177 個 runtime source inputs、2 個 compiled API hashes，以及完整 static／worker precache proof 相同；沒有網站／bot 運行契約或展示文案的改動。本次完整 CI 固定預期為 **177 檔／2,900 unit、81 檔／843 browser**，仍須核對本次原 run。

第 160–162 號原完整 CI 已獨立核對成功。第 163 號 run `44810340136` 的原 browser artifact `14668923472` 已核對：81 檔／843 案例，無 skips／retries／flakes；原 metadata 的 run／commit、ZIP digest／CRC／解包 bytes、browser terminal log、固定 inventory、55 個原 Python blobs／177 runtime inputs，以及 85 個 precache resources 的逐資源 bytes／keys 均通過。其原 unit 在最後核對時仍執行中。第 164 號 run `44813600327` 的實際双映像與原 image artifact／log 已核對，unit／browser 在最後核對時仍執行中；沒有重啟原 jobs。

本次驗證完整私人修復階段的 row relation，**沒有獨立重新建立外部 legacy scopes／latest time 的來源 ancestry**；`externalLegacyScopeIndependentlyDerived=false`。相同完整圖／rowid／bytes 的新世代、全部 reset generations、media／browser pending、停止 capture custody、完整 B01–B15 與實際版本組合／QQ、正式規模及 audited activation 仍待完成。`allResetGenerationsReconciled=false`、`releaseEligible=false`；166 capabilities 仍為 0 fully accepted。
