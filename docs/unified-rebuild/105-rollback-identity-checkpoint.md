# 第九十九批實作：最新成分身份 SQLite 回退重建

日期：2026-11-19（Asia/Taipei）。分支 `codex/unified-rebuild`。變更範圍 **`both`**：身份與看板帳號、成分、刪除及固定舊 runtime 有跨服務依賴；實際發布 **`none`**。只操作合成來源與 memory／暫存副本，沒有 main 整合、正式資料或服務操作。

## 最新身份的投影

新增 `rollback-identity.ts`，在 standalone `BEGIN IMMEDIATE` 下驗證完整 schema 15、latest journal 及傳入 music JSON／key map 與此來源一致，再重建固定舊身份 schema 的 10 張表。與看板／成分元件一樣，來源應來自檢查點 104 的同一完整快照；不從舊備份直接恢復，不提供 CLI 或啟用。

原 links 僅在 owner 與最新 QQ provider／client／subject 明確相符時保留；原 prelinks 保留最新有效 owner。已完成新 QQ claim 由本次 completed intent、已 used attempt、最新 external identity 與 claim audit 共同驗證，投影為同一 provider link；缺少證據就拒絕，不根據姓名／QQ 聯絡號猜授權。原生新增成分透過初次 creation audit 恢復 prelink 及舊格式 native recovery body。管理改關聯／解除依最新 owner 和原 revision／history 重建 override，帳號關閉不重連。

舊 `sessions`／`entry_intents` 明確失效，原 proof 只留在完整私人來源 checkpoint，不激活到舊 runtime。無法對應成分的 orphan links／prelinks 同樣不授權，仍保留完整來源；orphan contact 繼續保留 alias reservation。原 used_oauth 與新版已用 QQ attempts 保留，最新 PIN 限流 attempts 保留，不把原歷史限流與目前表重複加總。這些安全失效仍需之後 browser／固定版本回退流程給出恢復入口，不是完整操作恢復驗收。

原 native_profiles payload 以當下 music 投影更新，保留新選擇、PIN、owner、明確 contact 清空及姓名／留言，防止原 recovery document 重建過時內容。數字 legacy key 的查詢 QQ 在舊 runtime 固定為該 key，若候選 contact 被改成另一個號或清空就拒絕回退；不能默默把 JSON 清空改回舊號。

## rowid、審計與高水位

`rollback-identity-source.ts` 只解碼已封存的原 DDL／columns／rowid／storage／sequence 與仍保留的 private rows，不處理 ownership。未知欄位、缺少 structural evidence、非法／不安全值、audit id 不等於 rowid 都拒絕。原 signed rowid、原 `link_audit` ID 及包括空表的 64-bit high-water 保留；新列的 rowid 不碰原已使用範圍。無法容納新審計時拒絕，不倒退序號。

新版 ownership history／claim audit 追加為舊 `link_audit`，原 actor／before／after／seconds 保留，提供每個原 namespace／source ID 到新 legacy ID 的可逆對照；新版完整 reason、revision、receipt 等仍在 full checkpoint。追加順序按 profile ID 與該 profile 的 authoritative revision，避免時鐘回撥改變操作先後；不同 profile 沒有共同原 counter，不以時間猜全球順序。重複的跨表 profile revision 或生成 key 撞到原 orphan identity 都拒絕。

## 獨立驗證與限制

`rollback-identity-reconciliation.ts` 不呼叫身份 projector，重新讀最新 owner／QQ evidence／history／contact／used attempts／rate attempts，以及原 row decoder。核對完整 fixed schema、column storage、有效 ownership 集合、原 rowid、native body、contact reservation、全部 audit／mapping 與高水位；刻意增加舊 proof、錯 owner／contact／native body／audit／rowid／schema／sequence 都拒絕。music 及 journal 重新驗證，不信任傳入 report。結果始終 **`rollbackEligible:false`**。

最終相關 **83 項／4 檔通過**，Strict TypeScript 通過。完整單工回歸 **1,194 項／122 檔通過**；完整回歸啟動後補了 key／orphan 衝突、原 evidence 欄位、revision 排序、兩項相關測試及 OAuth-only profile 不可額外加 prelink 的拒絕檢查，最終相關 83 項與 strict 再次通過。紀錄：`/tmp/qgroup-rollback-identity-targeted-final.log`、`/tmp/qgroup-rollback-identity-typecheck-final.log`、`/tmp/qgroup-rollback-identity-native.log`。

測試實際匯入原 Python `Store`／contacts／admin_links，僅在本次生成的隔離身份 SQLite 與 JSON 上讀有效 prelink、清空聯絡號、解除 owner、追加舊審計，確認失效 session 不可用。沒有啟動 HTTP service／bot、沒有正式憑證或 QQ；這是原 identity 元件讀寫演練，**不是固定舊 web／music／bot 完整候選版本組合驗收**。本輪沒有修改 runtime entry、TSX、schema 或 bot 邏輯，未建置候選映像或瀏覽器驗收。

## 尚待完成

**166 IDs／166 in_progress／0 完整驗收，release_eligible=false**。完整回退 package／CLI、private 落盤／fsync／manifest、latest erasure 包轉換與重播、圖片／壁紙／歷史、browser pending requests／原稿與失效 proof 恢復、完整固定舊 web／music／bot 讀寫及重新向前恢復仍未完成。原管理 credential 的安全恢復／設定承接也須成套驗證；不得直接拿這個 memory identity 啟動舊服務。實際 QQ／裝置、候選版本組合及正式規模驗收仍待取得；不部署。
