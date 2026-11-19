# 合併後認領憑證與原回執核對檢查點

日期：2026-11-20。變更影響按 **`both`** 評估，涉及共用身份、成分授權、原回執及恢復資料；本次發布範圍 **`none`**。沒有部署、合入 main、啟動正式服務或 bot，也沒有改動正式憑證、群設定或真實待送工作。API／bot runtime、schema 與 UI 不變。

## 來源與有效權限

`reconstructForwardProofs` 接續第 123 號實際業務重建。除原十份固定來源外，另固定該重建的 native image、成分来源與 identity image，共 **13 份 SHA256 固定 bytes**。先用原獨立 business verifier 完整核對候選，不接受自行改 image 後只重新計算 pin。操作時間必須是明確 ISO 時間，憑證核對不得早於資料重建。

原看板 `browser_sessions`／訪客 session、native 認領 intent、OAuth attempt、外部 QQ identity、profile revision／PIN／account epoch 一併核對。以仍有效的原裝置及 target scope 保留有效的 pending、authorized、completed 證據；不要求所有會員重新找回成分，也不把舊 identity session 直接當成新版登入。

最終 owner 相同不足以證明權限沒有改變。工具逐列對照原回退 identity 基線與舊站最新 `links`、`prelinks`、`link_overrides`、`link_audit`，辨識解除／再關聯及途中取得另一份成分的帳號。原審計、override 版本、rowid 與原時間保留，不根據時間猜測操作先後。

原權限變更使受影響 profile revision／account epoch 增加一次；第 123 號已增加者不再重複增加。途中取得又失去成分的既有帳號也撤銷原找回權利。revision／epoch 或新增 rowid 達到容量上限時拒絕核對，不隨機分配歷史 ID。

## 認領、OAuth 與原回執

| 紀錄 | 候選處理 |
| --- | --- |
| 有效 pending | 原 profile 未被擁有、修訂／PIN／目標 epoch 相同、期限及原裝置 scope 有效時，保留所有原欄位與 rowid |
| 有效 authorized | 除上述條件外，必須有本次 consumed QQ attempt、相同 app／subject 及目前 target 的 external identity；不以旧 session 或稱呼補授權 |
| 無效 pending／authorized | 從可操作的 `music_claim_intents` 移除；原完整 intent 保留於配對的原 business image。過期、PIN／修訂、裝置／帳號 scope、暫時取得成分、撤權及不可驗 OAuth 均有明確 disposition |
| 已完成認領 | 保全 stage、attempt ID、QQ subject、原 target、時間、rowid 及原 native claim audit。撤權、改 owner、PIN 變更或裝置 scope 不再有效時，只把原 current token hash 改成沒有 session 的固定撤銷 scope，原裝置查不到此 intent，不重做原操作 |
| 未消耗 OAuth | 只將附屬於被移除 intent 的 pending／exchanging／verified attempt 改成 failed，並清空未確認 union ID；原 attempt ID、日期、provider、方法及其他欄位不變，無關 attempt 不變 |
| 已消耗 OAuth | `used` attempt 與旧 identity consumed history 完整保留，永不改回待用、重送或未消耗；即使原認領已失效也保留原證據 |
| 成分私人操作回執 | ownership 變更或曾解除／再關聯時，原 key、signature、時間、rowid 與 profile receipt mapping 保留；可查結果改為 410 `PROFILE_REASSIGNED`。原私人 response 完整保存在配對原 image，不當成最新可重播內容 |
| 其他回執與登入 | 未受影響的成分操作、帳務／活動／其他結果，以及普通網站登入不變；PIN 變更本身不改 ownership 回執 |

没有直接呼叫會刪除 completed claim evidence 的一般 ownership invalidator，也沒有補造 native user audit、原使用者操作時間或新業務收據。profile 修訂及新增 migration run 使用明確的本次核對時間。

## 原證據與父套件

輸出除了核對後 native image，還包含**原 business image 的完整原 bytes**、原 native journal、最新配對成分來源及 identity image。新增 migration run 固定全部 source pins、兩次操作時間、原 image pin 及逐項 disposition／變更 rowid；既有 runs、歷史、source documents、mapping、PIN、同意及所有無關表完整保留。

`verifyForwardProofs` 不呼叫 writer 或使用其 change list。它與 writer 共用明確的權限政策 evaluator，另逐列推導輸出欄位、SQLite storage class、rowid、schema、metadata、所有表及 `sqlite_sequence`，並呼叫實際原生 `createMusicClaims.status` 驗每份原裝置的可讀結果。政策 evaluator 的行為另由原生 use-case 及真正 Python 操作驗證，不把共用 evaluator 當成完全獨立的規則 oracle。

父套件須再執行 `verifyForwardProofBundle` 核對原保全 image、journal 及兩份來源的精確 bytes。只驗 native image 不能證明被替代的私人憑證／回執保留。仍須完成外部 custody、保存與最新 erasure 套用；本元件回傳 bytes 不是已取得外部 retention 認證。

輸出仍固定 `proofCandidateOnly=true`、`sourceRebaseRequired=true`、`latestErasureReplayRequired=true`、`externalRetentionRequired=true`、`externalRetentionVerified=false`、`recoveryRequired=true`、`rollbackEligible=false`、`releaseEligible=false`。正常網站與 worker 啟動繼續被拒絕。

## 驗證

新增 **39 項**合成案例全部通過：有效的三階段認領、期限、PIN／修訂、帳號切換、訪客期限、OAuth 身份移除、未消耗及已消耗 attempt、completed 原證據、ownership 交換、同 owner 的解除／再關聯、prelink 無資料差異的 ABA、途中取得另一成分、旧 sessions／intents 保全、固定來源重跑、完整父 bundle、容量及最後邊界。

原 native `start`、`attach`、`authorize`、`finish` use cases 建立合成認領與已消耗 QQ proof；沒有呼叫 QQ provider。原 Python `Store.admin_state`、`admin_links.change` 在新私人副本執行真正解除／再關聯，原 audit ID、兩次操作及 override revision 接入候選；沒有操作正式服務。

另一個 Python readonly oracle 逐表比較原 business image 與保全 image 的所有 rows／storage classes，並比較候選的所有非受影響表。它另外直接驗 completed proof 除 token scope 外完全不變、used attempt 不變、原私人 receipt 仍為 200、新有效 receipt 為 410、epoch 為 2，以及 integrity／foreign key。所有 bot 工作和歷史仍逐列相同，沒有啟動投遞者。

第一輪 29 項中 10 通過；兩個 fixture 問題分別是缺少原生 attach 步驟及重建 identity 後重複 sequence row，已按原流程修正。第二輪 28／29，直接序號竄改揭露 verifier 漏列 `sqlite_sequence`，已補完整高水位核對。第三輪 38／39，空 journal 的負向 fixture 沒有實際改 bytes，已改為真正不同的 bytes；strict 的 union 型別問題一併修正。第四輪 39 項全通過。原失敗結果完整保存在私人證據，未改寫成 pass。

最終固定來源相關回歸 **33 檔、619 項全部通過**，零 failed／pending／todo／skipped。範圍包含本元件、原生認領／管理成分／登入／裝置、前次業務／看板／成分合併、erasure／privacy、rollback／snapshot import、全部 13 份 TS bot 測試及三份 database／migration 測試。獨立最終 verifier 核對每批 assertions、檔案清單與 995 份來源未改變。strict、完整建置及隔離 build smoke 通過，12 個 API／bot runtime bundles 與第 120 號 bytes 相同。

私人證據：`/Users/danersaka/.codex/rebuild-verification/forward-proofs-124-eca06bf10d7d49c4b15a23d7c6327915/`；source plan pin `97e2237b52aa8f73c4bc9131ce2a95239cc3acbedebd3651d3eb39a4388f0319`，995 份來源、141 份完整 inventory，明確選取 33 檔／4 批，每批一個 worker。最新完整 inventory 的 1,890 項／137 檔回歸仍綁定第 120 號提交；本輪不冒稱重跑目前全部 141 檔。

## 尚須完成

- 最新成分／identity 來源完整 rebase、generated key 原 mode、原 audit mappings／截點／sequence，以及重新投影不重複 audit。最新原來源仍隨候選外部保全，原 rollback readers 尚不能直接消化這個中間 image 的所有舊 ownership 變更。
- 完整 merge 後的最新原 authority 重播、closed account 私密 footprints、跨域 request receipt、structured reset 原詞條／截點／scope，以及私人保全 image 的最新刪除與存取限制。
- 媒體、browser pending／proof、實際停寫 capture provenance、authority epoch rebase／外部高水位／custody、audited activation，以及固定 Linux 實際 web／Python 或 TS bot 組合、全功能瀏覽器、B01–B15、QQ／實機與資源驗收。

166 能力仍為 `in_progress`，完整目標不縮減；按使用者要求先不部署。
