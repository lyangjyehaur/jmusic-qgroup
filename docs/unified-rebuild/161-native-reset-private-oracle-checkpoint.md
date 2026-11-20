# 原生重置私人資料的獨立來源核對

日期：2026-11-21。變更範圍：`none`；僅離線驗證工具與測試。網站、bot 運行程式、schema、journal 契約、outbox、設定及網址沒有修改。保留 Python bot，不合入 `main`，不部署。

原一般 reset 的來源核對曾使用 `replayMusicErasure` 準備私人資料預期模型，可能與服務 writer 重現相同錯誤。本次移除該呼叫，從已核對的原 intent 與重置前副本直接建立唯讀逐列關係；不匯入成分刪除、ownership、claim 或 catalog writer，不生成替代回執。

核對涵蓋成分墓碑與原 revision／updated_at、成分私人欄位與歷史、原生建立紀錄、匯入欄位、認領與 owner 相關證明、pending／exchanging／verified 嘗試失效、completed／failed 與普通登入保留、每位有效 owner 的 epoch 增量、保存回應的精確 410 結果、完整詞條與 membership 範圍、來源文件清除／creator 遮蔽、legacy identity 與 mappings、legacy erasure timestamp upsert。新 epoch／legacy erasure 的 rowid 及插入順序也由原 rows 推導；其餘每張表的 rowid、儲存類型與內容均須精確保留。

JSON 只用唯讀 SQLite `json_extract`／`json_set` 處理需要改動的路徑；不把整份 opaque JSON 轉成 JavaScript number 再序列化。案例保留 `9007199254740993`、`1e+05` 與 `-0` 的原數字內容。epoch 使用精確 SQLite 整數／運算與儲存類型核對。

含成分的固定來源與全站候選報告現在為 `profileProjectionUsesServiceWriter=false`、`fullPrivateScopeIndependentlyVerified=true`。**這個旗標只證明所提供單次 reset 的重置前／完成副本私人變化已獨立核對**；不代表後續候選的全部私人世代、所有歷史恢復或正式切換已驗收。完整投影本身仍沿用已存在的私人修復實作，其 generation／key-reuse 閘門仍須完成。

新增檔有 **31 個案例**，包含 13 類被塞回完成副本的原私人 rows，以及保持 old tombstone、claim status、身份 provenance、新增 rowid 順序、精確 epoch、保存結果與 opaque JSON 的回歸。有效的首批 18 案例在舊驗證器上為 16 passed／2 failed：被刻意污染的 shared writer 與 completion 同時把普通登入改成 failed 時，舊驗證器錯誤接受；新唯讀 oracle 拒絕且 mock writer 呼叫為 0。最早 fixture 帶有多餘 preview 欄位的無效基線另存，不能當作行為證據。

最終本機 **6 檔／154 個不同 unit／API 案例**全部通過，與獨立 AST 展開的固定清單一致，無 skips。既有完整投影第一次執行仍期待舊的 writer 旗標，更新為本次獨立來源語意後，全檔重跑通過；沒有放寬候選資料比較。strict、完整建置、built smoke 與 capability 規則檢查通過。相對第 160 號，177 個固定 runtime source inputs、2 個 compiled API hashes、worker 與 85 個 precache resources 的 proof 相同；沒有前台變更或新增展示文案。

本提交完整 CI 預期為 **173 檔／2,792 unit、81 檔／843 browser**；相關案例不代替原完整 CI。第 159 號原 run `44796568591` 的 171 檔／2,747 unit 原 ZIP SHA `13c77824b31cc1c7db3b8218c23b359c58b11e5344b8727b205a921ca716f52e`已核對原 ZIP／metadata／CRC／解包 bytes、固定 inventory 與全 assertion 結果，browser 尚待終態。第 160 號原 run `44800843634` 的實際 Linux 雙映像與原 image job log 已核對；unit／browser 尚在原 run 執行，不重啟。

166 capabilities 仍為 0 fully accepted；`allResetGenerationsReconciled=false`、`stoppedCaptureCustodyVerified=false`、`releaseEligible=false`。完整 epoch／exact-key-reuse ancestry、latest-erasure 私人歷史、media／browser pending、停止 capture 與 custody、完整 bot B01–B15／實際版本組合與 QQ、正式規模與 audited activation 均仍待驗收。
