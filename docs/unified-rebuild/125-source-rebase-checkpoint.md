# 合併來源、原 ID 與身份審計重整檢查點

日期：2026-11-20。變更影響按 **`both`** 評估，涉及共用成分身份、原資料來源、回退與刪除相容性；本次發布範圍 **`none`**。沒有部署、合入 main、啟動正式服務／bot，或改動正式憑證、群設定、真實待送工作。修改為隔離遷移工具及其匯出核對器。

## 來源與實際重整

`rebaseForwardSources` 接續第 124 號憑證核對。固定其 13 份輸入及核對後 proof image，共 **14 份 SHA256 固定 bytes**，另要求不早於 proof reconciliation 的明確 ISO 重整時間。先執行 `verifyForwardProofBundle`，拒絕把 business image、自行改過的 proof image 或只有新 pin 的任意資料當成已核對來源。

候選沿用完整原 native proof image，只更新四張表：`music_documents`、`music_legacy_identity`、`migration_map`、`migration_runs`。重整最新詞條／成分／喊話／歷史喊話／設定原文、identity structural evidence 及私人來源列；profile source 和 mapping 明確使用原 native profile ID。更新的 namespace 以本次 run 作 `source_revision`，同一來源 key 保留原 native rowid，新列從原高水位後分配。刪除墓碑的 profile mapping 保留。

原 native 業務、修訂、creation provenance、PIN／同意／聯絡／欄位歷史、所有 claim／OAuth／登入、私人 request receipt、原 journal、帳务／活動／bot 工作及 `sqlite_sequence` 不變。trend／trend_sample 的原列、位置和真正新增的後綴也不重複匯入。本次不清除 recovery gate。

最新私人舊管理密碼只留在受保護的 settings source；rollback music 的公開設定仍為 `{}`。舊 entry creator 的 legacy key 與 relational native ID 保持各自語意。若舊站改動的 `createdAt` 與原 native `music_profile_creation` 衝突，明確拒絕，保留全部原 bytes 供核對，不補造建立時間。

## 原 ID、截點與審計

新增單筆 `source_rebase` metadata，只含固定 source pins、時間、原 `{profileId,legacyKey,mode}` 對照、native history 的 ID／profile ID／digest、namespace 截點及 frozen audit mappings；沒有複製第二份私人 audit body。

- 原生建立的 profile 維持 `mode=generated`，即使舊站修改後新增 supplementary `music_legacy_profiles`／source alias。兩個 rollback readers 及其 verifier 都核對同一已綁定的原 ID；不因新來源列誤判為 preserved，不放寬未重整来源的 collision 檢查。
- 截點使用 `music_ownership_history` 和**完整** `music_profile_audit` 的 `sqlite_sequence`，包括已刪列留下的空洞；不只取目前 surviving row 的最大值。
- frozen mappings 從原 native 的實際 identity projection 取得，保全兩個 namespace 的 source ID、原 legacy audit ID 及原高水位。重整來源中的對應 audit 必須與原 projected identity 的 row／storage class／rowid 相同。
- rollback identity 只追加截點之後的新 ownership／legacy claim；原已匯出的 native audit 不再追加。新的 audit 分配於既有 legacy 高水位之後，保留原映射及原時間。
- local reader 核對 metadata 與唯一 migration run 的 digest／manifest／時間、原 aliases、native frozen rows、sequence，以及 frozen legacy audit 對 native actor／before／after／時間的內容。截點以前插入不明列、改 action／內容、偷刪歷史或倒退高水位均拒絕。

最新舊站 owner 採取實際的 links／prelinks／override 資料；不補造 native user audit 或 OAuth。旧 sessions／entry intents 原文作私人 inactive evidence 保留，rollback projection 仍輸出空 sessions／intents，原 native 普通登入不受影響。

## 後續寫入與刪除

重整後仍可用原 native `saveProfile`、新建 profile 及 `start/attach/authorize/finish`。來源截點只限制已匯出的歷史；後續真正新寫入仍按目前業務資料匯出，新的 completed QQ claim 只取得一筆新 legacy audit mapping。

原 native privacy replay 可刪除 preserved 或 generated 成分。`eraseLegacyProfile` 能找到重整後的普通 source documents／namespaces，移除私人成分、來源身份和 profile-owned history，保留 ID 墓碑。metadata 的舊 ID／digest／audit mapping 保留為對照；被刪的 audit body 不復活，高水位不倒退。正式匯出必須由已核對 journal 的 profile erasure scope 授權 missing frozen rows。單獨 key reader 只能辨識墓碑，不能認證刪除權威或放行匯出。

帳號關閉保留共享審計歷史並清除原 ownership／登入／私人 proof；不把歷史 audit 的 owner 當成目前權利。最新原 authority 的完整恢復、早期 closed-account footprint 和 reset 仍是後續獨立門檻，本次原生新刪除測試不能取代它們。

## 保全與核對

輸出包含候選 native image、原 native journal、**完整原 proof image、原 business image**及最新配對 music／identity source 原 bytes。被替代的原 documents、mapping、認領與私人回執都在精確配對原映像中，不隱藏在新庫的另一份 unchecked 私人 archive。父套件須以 `verifyForwardSourceRebaseBundle` 核對全部保全 bytes；仍須取得外部 custody／retention，並對原保全映像執行最新刪除與存取限制。

`verifyForwardSourceRebase` 不呼叫 rebase writer 或使用其 change lists；直接從固定原 proof image／source pair 推導全部 native 表、欄位、storage classes、rowids、schema、metadata 與 `sqlite_sequence`。structural codecs、row digest 和 local metadata reader 共用；核對後另呼叫實際 rollback music／identity projectors，驗證候選 source epoch 可繼續匯出及完整組裝。沒有把這個額外 probe 宣稱為另一份完全獨立規則 oracle。

所有輸出仍為 `externalRetentionRequired=true`、`externalRetentionVerified=false`、`latestErasureReplayRequired=true`、`recoveryRequired=true`、`rollbackEligible=false`、`releaseEligible=false`。資料庫可離線組裝不等於網站或 bot 已可啟動。

## 驗證

新增 **46 項**合成案例涵蓋：generated 原 ID／mode、completed claim 重複投影、真正 Python unlink／relink／ABA、新 ownership 與 native claim／profile 保存、sequence 空洞、原生 preserved／generated 成分刪除、account closure、完整 rollback state、inactive 舊 proof、建立時間衝突、父 bundle 精確 bytes、全表／身份／mapping／metadata 竄改、三種 rowid 容量、最後來源邊界、固定來源重跑、私人 settings 與 creator 語意。

使用原 native use cases 和合成 consumed QQ proof，沒有 provider 或真群投遞。真正 Python `Store.admin_state`／`admin_links.change` 在私人來源副本執行兩次 owner 操作；另一個 readonly Python oracle 獨立比較 proof／保全映像全部表、候選全部非修改表、creation provenance、generated metadata、原 legacy audit ID／內容、有效 owner、空 sessions／intents 及 integrity／FK。

開發失敗紀錄完整保留：首輪預期列的 property order 與 `it.each` fixture 形狀錯誤；完整第三輪 34／39，揭露 fixture 未沿用同一 in-memory journal、比較含 report 的 projector 與正式 state shape，以及負向刪除被原 append-only trigger 攔截。第四輪 41／42，account closure 的 fixture 錯誤要求不存在且無需新增的 override，已改核對真實 inactive ownership。第五輪擴至 46 項，全數通過。最終核對使用下述重新固定的來源，沒有把開發失敗改寫為 pass。

最終固定來源回歸：**67 檔、1,408 項全部通過**，零 failed／pending／todo／skipped；獨立最終 verifier 核對每批 assertions、檔案清單及全部來源未改變。strict／完整 build／隔離 build smoke：全部通過；建置後 1,001 份來源仍符合原固定 plan，12 個 API／bot runtime bundles 與第 120 號 bytes 相同。

私人證據：`/Users/danersaka/.codex/rebuild-verification/source-rebase-125-c46d5125b4354fdb9476f3a3d75c7c20/`。source plan pin `342d2e468c9d53af63a1a8bfef5deb83341e707b35704303dc4a7d24da435b54`，1,001 份來源、142 份完整 inventory，明確選取 67 檔／8 批，每批一個 worker。本輪不宣稱重跑全部 142 檔；最新完整 inventory 回歸仍是第 120 號提交上的 1,890 項／137 檔。

## 後續門檻

本元件處理第 124 號之後的首次完整 source epoch rebase。既有 metadata 再次重整須另驗證來源鏈與已刪審計對照，不能直接覆寫；同一固定輸入可重跑產生相同候選，後續原生寫入及刪除可繼續投影。

仍須完成：合併後最新原 authority／closed account 私人 footprint／跨域 request receipt／structured reset、私人原映像 latest-erasure 保全、媒體／browser pending 與 proof、真正停寫 capture 認證、authority epoch／外部 custody 與高水位／audited activation、固定 Linux 實際 web＋Python／TS bot 組合，以及全前台／後台瀏覽器、B01–B15、QQ／實機及資源驗收。

166 能力仍為 `in_progress`，完整目標不縮減；先不部署。
