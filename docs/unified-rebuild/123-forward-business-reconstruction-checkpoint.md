# 看板與成分新寫入資料重建檢查點

日期：2026-11-20。變更影響按 **`both`** 評估，涉及共用資料、成分、帳號及恢復；本次發布範圍 **`none`**。沒有部署、合入 main、操作正式服務、bot、憑證、群設定或真實待送工作。runtime、schema 與 UI 不變。

## 實際重建範圍

`reconstructForwardBusiness` 接續第 121、122 號檢查點，接受十份獨立 SHA256 固定的原 checkpoint、回退基線及兩側最新資料。候選從看板合併後的**最新 native 資料庫**開始，再只套成分來源的有效差異；沒有用空白匯入庫取代 native。

原 profile ID、原有 rowid、native-only 資料、歷史帳務、已存在的收據、審計、PIN／聯絡／欄位／ownership 歷史、同意及建立來源均保留。舊站真正新增的成分才建立確定性 ID。原 generated rollback key 接回原 native ID，兩階段暫存 ID 轉換只在一次性的正規化模型進行，該模型及固定驗證時間均丟棄。

| 資料 | 候選行為 |
| --- | --- |
| 看板與 bot | 原 59 表三方合併結果逐列保留；原活動、名冊、帳務、通知內容、待送／重試／不確定／模擬／已送狀態不被成分重建改動 |
| 詞條與成分 | 只更新來源實際改變的欄位，保留未改變的 native metadata、原 ID 與 rowid；舊詞條的 opaque 建立／更新時間原樣保留 |
| 修訂與關聯 | 舊來源變更使既有 profile 及受影響欄位／聯絡修訂增加一次；新 profile 修訂為 0。ownership 變更使前後 owner 的 account epoch 各增加一次，包含雙向交換 |
| 選擇 | 等級變更保留原 rowid 及 gapped position；順序或數量變更時，受影響成分的位置依選定來源順序重排，避免新增詞條排到原 position 100 前方 |
| 建立清單 | 舊 created 清單保存在該成分資料；刪除詞條或移除原直接建立引用時清除失效引用，原 catalog action 歷史不變 |
| 喊話 | 保留 ID、作者、來源時間、archive 狀態及原 author throttle；來源選定順序需要重排時才重編 ordinal，保留其他原欄位及歷史 |
| 趨勢 | 原 native 樣本保持完整，只附加選定來源的新後綴。刪除、替換或重排原前綴要求 structured reset authority，本元件拒絕 |
| 限流與私人身份 | bucket／時間及重複限流列接回原 native rowid；舊身份 rowid 另保存在配對 identity image。原 session、entry intent、consumed OAuth 等私人來源保留，但沒有啟用為新版登入 |

新增列必須使用原 native 高水位以上的 signed SQLite rowid，不採 SQLite 滿額時的隨機分配。趨勢 position 使用 BigInt，能精確保留 JavaScript 安全整數以外的序號；signed SQLite 上限、修訂或 epoch 容量不足均拒絕重建。

傳入的 `reconstructedAt` 是本次重建操作時間，用於修訂與 migration run。它不是舊使用者的操作時間；沒有補造 native user audit、業務收據或原 ownership proof。

## 保全與啟動邊界

交易只在私人記憶體候選內暫停 trigger／foreign key，完成後恢復原完整 schema 與 trigger，驗 `integrity_check`／`foreign_key_check`。十份來源在開始及輸出前再次核對，callback 必須同步。失敗關閉所有連線，不輸出半成品。

原 `music_documents`、`music_legacy_identity`、`migration_map`、所有原 migration runs 及原 native journal 完整保留；只新增實際的 forward migration run 及趨勢後綴。最新 raw 成分來源、原 key mapping 與 identity image 另隨候選輸出，未來父套件必須一併封存，不能只保存 native image。

輸出固定標示 `businessCandidateOnly=true`、`proofReconciliationRequired=true`、`sourceRebaseRequired=true`、`recoveryRequired=true`、`rollbackEligible=false`、`releaseEligible=false`。正常服務啟動仍被拒絕。這是資料重建元件，完整 forward restore 與逐項驗收尚未完成。

## 驗證

新增案例包括實際資料重建、native-only 更新、generated profile 原 ID／creation、原詞條時間、created 清單、聯絡移動、ownership 交換與 epoch、gapped 選擇、喊話重排、趨勢後綴、超大 position／流水號耗盡、signed／重複限流列、私人 session 來源及固定輸入重跑。獨立 verifier 不呼叫重建器或使用其 change list 作授權，重新推導候選列、metadata、schema、sequence、修訂、原 source documents 與歷史。

負向直接改寫原歷史、收據、source document、mapping、profile ID、選擇／修訂、ordinal、趨勢 position／rowid、限流 rowid、recovery、metadata、sequence、額外列及 run report，均要求拒絕。原恢復旗標 fixture 的 immutable trigger 原樣復原後才驗 verifier，未將 trigger 先拒絕當成 verifier 成功。

原 Python `events.create`、`Store.create_profile`、`contacts.save`、selection／shout handler 在私人副本實際寫入；重建保留原活動、bot outbox、新成分、聯絡及喊話，沒有啟動 QQ worker。另一個 Python readonly oracle 對帳全部 59 共享表及所有不受本次管理的 native-only 表，再驗原 profile ID、私人留言、選擇、聯絡、喊話及候選禁止啟動。

最終固定來源相關回歸 **28 檔、518 項全部通過**，零 failed／pending／todo／skipped，包含全部 13 份 TS bot 測試。獨立最終 verifier 核對每批 assertions、完整檔案清單及所有 989 份來源未改變。strict、完整建置及隔離 build smoke 通過，12 個 API／bot runtime bundles 與第 120 號 bytes 相同。最新全 inventory 的 1,890 項／137 檔回歸仍綁定第 120 號提交，本輪不冒稱重跑目前 140 份全部 inventory。

私人證據：`/Users/danersaka/.codex/rebuild-verification/forward-business-123-d58cc86e492341079d0a42ac00fcdfc8/`；source plan pin `acc3a820f8916546894f255a5c54c32c441b0bd891384c9846c9fe3ddfb09136`，989 份來源、140 份完整 inventory，明確選取 28 檔／3 批，每批一個 worker。開發初輪 21 案例中 18 通過，後續 22／27／29 案例全部通過；補流水號邊界後 37 案例中 36 通過，失敗 fixture 缺少必要的 `boardUserId`，在觸及容量檢查前就被來源一致性檢查拒絕。已補上合法的空 owner；上述原結果保留在私人證據，不改寫成 pass。

## 下一步與未通過項目

- 最新來源須完整 rebase：原 identity 已包含 native 投影的 audit，必須保留原 mappings、截點、generated mode 與 sequence，避免再次投影重複 audit。補充 legacy row 的 native profile 仍保留原 creation 與外部 generated mode，原 rollback key reader 尚會把它推定為 preserved；不能直接啟用這個中間候選。
- 原 pending／completed claim proof、私人登入、舊 native 收據仍按原列保全；ownership／PIN 改變後須核對失效與只查結果的行為，保留已完成 proof 證據，不能直接呼叫會刪除所有 claim intents 的一般 ownership invalidator。
- 完整業務合併後須依原 authority 重播最新刪除、處理 closed account 私密 footprints 與跨域 receipt 引用，以及 structured reset 的原詞條、截點與 scope。
- 媒體、browser pending／proof、真正停寫 capture provenance、authority epoch rebase／external high-water／custody、audited activation、Linux 固定實際 web／Python 或 TS bot 組合、全功能瀏覽器與 B01–B15、QQ／實機及資源驗收均未完成。

166 能力維持 `in_progress`；按使用者要求先不部署，完整實作與驗收的原目標不變。
