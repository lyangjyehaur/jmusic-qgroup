# 已關閉帳號的離線恢復修復檢查點

日期：2026-11-20。變更影響按 **`both`** 評估，涉及帳號、成分 ownership、投票與共用資料恢復；本次發布範圍 **`none`**。只修改隔離遷移工具及合成測試，沒有部署、合入 main、改動正式 bot、憑證、群設定或真實待送工作。

## 修復範圍

原生 `createPrivacy.apply` 見到 `erasure_applied` 會返回，`closeAccount` 見到原 `privacy_requests` 也會返回。已完成關閉的帳號若混合恢復出舊登入、收款碼、私人回應或活動存取權，原 erasure-only forward projector 只能拒絕，不能修復。原 Python `privacy.recover` 同樣會跳過已有關閉紀錄的帳號。

新增離線 `repairAppliedAccountErasures`，接入已固定原 authority／完整 checkpoint／native source 的 forward projector。先驗證 journal 全部 applied markers、native receipt 的 secret／signature，以及 account／both 回執的 request ID 和 target，再要求存活帳號原關閉紀錄的 ID／created_at 與原意圖一致。缺失或矛盾時停止，不建立替代申請或回執。music-only／administrative music 意圖不關閉網站帳號。

清除恢復出的帳號私人列、選定該帳號的 browser session 及其登入／裝置／訪客證據；其他 active account 的共用裝置保留，僅移除 dormant 的 closed-account membership。原 QQ provider／app／subject 對上的孤兒 login attempt 清除；closed-target claim 的 pending／exchanging／verified OAuth 明確失效、清空 union ID。所有 closed-target invalidation 先完成，避免前一帳號刪除裝置 claim 後漏掉後一帳號的 OAuth。已 used 或無關的 attempt 證據保留。

恢復出的 unified consent／receipts 明確刪除，不依靠已不會重跑的 insert trigger。管理員權限關閉，但不新增 role audit、revision 或時間。music 與 account-only 關閉分開：現有成分解除帳號 ownership；名稱、選擇、contact、creation 與歷史不重寫。實際 `detachLegacyAccount` 清理 links／prelinks／source session／entry-intent proofs，來源 boardUserId 清空、原 mapping 標示 erasure；原 link audit、override 證據與 source-rebase audit 截點保留。

只回收該次修復捕獲的私人碼資產；其他帳號、共享結算版本仍引用的圖片與無關孤兒資產保留。open／closed poll 每個恢復出的已關閉 voter 推進一次 vote revision，移除其 ballots／votes；decided 結果和全部 bot 工作原樣保留。負值、非整數或 INT64 容量不足會回滾整個修復。重跑不再推進版本。

原關閉申請的 status／note／created_at／updated_at／rowid、native privacy receipt、shared business／history、sqlite_sequence 與所有未授權變更的欄位保留。不把多人的共享歷史聲稱為已匿名化；本次也沒有修改線上 privacy runtime 的重播行為。

## 憑證與候選快照

已核對原關閉意圖的帳號，其 `users.token_hash` 固定為 `erased-account-v1:` 加 SHA256(JSON.stringify([userId, originalClosureRequestId]))。原網站憑證 lookup 使用 SHA256 的 64 位十六進位結果；此帶前綴值不可能成為該 lookup 的命中。帳號 ID／created_at 不改，重跑 sentinel 相同。既有隨機 tombstone hash 會在首次離線修復時正規化一次；不替換原申請或設定可登入秘密。保全原映像仍可能含舊憑證，後續 latest-erasure 過濾與受控存取門檻仍必要。

SQLite 序列化的未提交 dirty pages 不保證包含剛寫入的 markers。普通 privacy recovery 先在完全隔離、不可啟動的記憶體候選庫提交，再取得 pre-repair clone。修復與核對在下一個 held transaction 完成；只有所有來源 pin／boundary／schema／integrity／journal／footprint 通過才輸出。中間記憶體狀態不寫回原來源或 authority，不發布候選檔案。

獨立 `reconcileAppliedAccountRepair` 不匯入 writer，也不採用 writer 的變更清單；從修復前完整影像和原 journal 重新推導範圍，逐表逐列核對可刪除／可修改項及其他全部欄位、rowid、SQLite storage class、schema、metadata、原 sequences 與回執。任何新增列、未授權欄位／歷史／投遞／資產變更均拒絕。

## 驗證與邊界

新增 42 項案例，包括 legacy／native account／both、music-only 帳號保留、共用裝置、provider-matched orphan attempt、closed-target OAuth、consent restoration、付款圖片引用、投票與 aggregate overflow、跨帳號清除順序、缺失／矛盾的申請／markers／回執，以及逐表／型別／rowid／sequence／metadata／bot 竄改拒絕。原 projector 的三項 restored-private rejection 案例改為正向修復與重跑驗證，其餘 pin／schema／mapping／reset／interleaving gates 保留。

兩項完整整合案例先執行 business／proof reconstruction 及 source rebase，再以原 Python `privacy.close` 和明確 authority overlay 產生真實原關閉紀錄。將原 `privacy_requests` 列合入候選後核對其原 ID、status、時間、rowid；不由只有 user／request／time 的 ledger 推導原 review status。再混合恢復私人 footprint，驗證 completed claim 與原 generated profile 的 ID／mode、frozen audit mappings／截點、原 journal bytes／head、所有 bot 工作及 account-only 音樂內容。獨立 Python readonly oracle 從原閉帳紀錄／journal 驗憑證 sentinel，逐表核對重跑資料與 storage classes，並核對共享歷史、bot 和 sequences。

私人來源及測試證據位於 `/Users/danersaka/.codex/rebuild-verification/forward-account-127-97ab2ee95e644778a1af4ac35de9e2d2/`。固定 plan SHA256：`cfc56755269507f47acf5c36f9fca782ece32502bfabcefeb6785b62a475c3e6`；1,009 份非文件來源，完整 inventory 145 檔，本輪選取 70 檔／9 批，每批一個 worker。開發失敗與修正另記，不沿用為最終來源驗證。

最終固定來源回歸 **70 檔、1,490 項全部通過**；9 批各一個 worker，零 failed／pending／todo／skipped。獨立 verifier 核對每筆 assertion、選取檔案與 1,009 份來源不變。strict、完整 build、隔離 build smoke 和台帳檢查均通過，建置與 smoke 後來源 SHA 再次相同。全部 13 檔 TS bot 已納入；本輪未重跑完整 145 檔 inventory，最後一次完整 inventory 回歸仍為第 120 號的 137 檔／1,890 項（`e29a769b494b1cb55c2cf9ed286834ea81cdfd91`）。

12 個建置 bundles 與已提交第 126 號（`a9248a6208c8779f836a1362b90f1178210f8029`）的 bytes 完全相同，涵蓋 API、database、分房 worker 與全部 9 個 bot bundles。此次沒有 schema 或運行程式變更。build smoke 驗證隔離 native HTTP／WebSocket、ACK／Resume、outbox／不確定與模擬狀態、CLI 排除與 SIGTERM，以及 SPA／API／圖片／備份和 recovery block；這些合成結果不代替真 QQ 或 Linux 固定實際版本組合。

最終 source plan、逐批結果、獨立 summary、strict／build／smoke／台帳紀錄與 runtime comparison 均在上述私人 evidence 目錄。提交後另核對 Git blob 與該固定來源清單，並核對兩個遠端功能分支的完整 SHA；不整合 main 或部署。

## 尚未解除的門檻

此次僅補離線 account footprint 修復與完整已 rebase 候選上的原關閉流程證據，不表示任意備份恢復、完整 latest-authority business merge 或線上恢復已放行。跨 domain orphan request receipts、舊 music frozen-history erasure 授權、structured reset 完整世代／ancestry／歷史過濾、原私人映像 latest-erasure 存取控制、重複 source epochs、媒體／browser pending／proof、真正停寫 capture、外部 custody／高水位／audited activation、Linux 固定實際 web＋Python／TS bot 組合與全前後台／B01–B15／實機 QQ／資源驗收仍須完成。

全部 166 項能力維持 `in_progress`，`release_eligible=false`。新 TypeScript worker 完整驗收前保留現有 Python bot；本輪不部署。
