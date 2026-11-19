# 成分與身份新寫入來源合併檢查點

日期：2026-11-20。變更影響按 **`both`** 評估，涉及成分、帳號、授權及共用資料恢復；本次發布範圍 **`none`**。沒有部署、合入 main、啟動正式服務或 bot，也沒有改動正式憑證、群設定與待送工作。網站、worker 與 schema 的 runtime 不變。

## 來源與合併

`mergeForwardMusic` 接續第 120、121 號檢查點，合併回退期間舊成分站的新寫入與 native 最新有效投影。它接受原完整 checkpoint、原回退看板／成分／身份基線、native 最新 image／journal，以及舊看板／成分 JSON／身份庫最新 image。全部來源均為獨立 SHA256 固定的 bytes；SQLite 只在私人記憶體中開啟，不擷取檔案、不連線服務或 authority、不啟動投遞者。

原成分基線包含原 profile key 對照與原 identity audit mapping，由既有獨立 music／identity verifier 對完整 checkpoint 核對；不能以自行重新計算的檔案 pin 取代這項核對。native 保有同 lineage、有效 journal 及原 byte prefix。原 generated rollback key 接回原 native profile ID；舊站真正新增的 key 才建立確定性對照。任何 key／profile ID 衝突都拒絕，沒有用 QQ、稱呼或時間猜測身份。

| 資料 | 合併方式 |
| --- | --- |
| 詞條、成分 | 以固定詞條 ID／legacy member key 比較完整原紀錄；舊站未變則保留 native，native 未變則取舊站，完全相同的修改合併一筆，歧異與刪除／更新競爭拒絕 |
| 選擇與欄位 | 保留選擇順序、等級與原重複／異型表示、建立詞條、稱呼、留言、性別公開旗標、PIN hash、別名及 opaque 原時間；不以有效正規化值重寫來源表示 |
| 身份十表 | 比較原 signed rowid、每欄值及 SQLite storage class；不重編審計 ID、來源列或時間，不把 INTEGER 與 REAL 混同；不同 rowid 的 PK／UNIQUE 衝突同樣拒絕 |
| 關聯與聯絡 | 先重播 native profile recovery、contact、override／prelink／link 的舊站有效投影；再驗 JSON 與身份庫一致、跨 links／prelinks 無雙 ownership、聯絡別名與孤兒保留號碼無碰撞 |
| 喊話 | 以固定 shout ID 同時比較 active／history 狀態、作者、文字與原時間；保留兩側各自的順序，互相矛盾的排序拒絕 |
| 趨勢、舊設定 | 整份三方比較，保留原順序與重複樣本；兩邊各自改出不同序列時拒絕，不用時間猜截點或丟棄其中一邊；舊 credential 只保留為私人來源 |

對詞條、成分 key 與喊話的來源順序，單邊變更保留該側順序；兩邊同時新增時保留每側的先後限制。沒有跨來源先後證據的獨立新增採 native、old 的穩定來源順序，不宣稱是實際時間排序。限制有循環時拒絕。單邊重排及不同來源新增喊話均有直接測試。

SQLite 高水位取兩側最大值，不能降到原 checkpoint 以下。原關聯審計及 consumed OAuth history 不可改寫或丟失；按有效 native erasure 移除的原審計須在兩邊都消失，且流水號仍不得倒退。現有 identity JSON codec 無法無損表達的超大欄位整數及不支援的型別明確阻擋，保留來源，不轉成四捨五入資料。

## 權限、刪除與輸出邊界

原 native 已刪 profile、原 creator 或喊話若仍出現在舊來源，要求先依原 authority 清理；不能讓它在 source merge 中復活。沒有刪除或 structured reset 證據的原會員消失也拒絕。已關閉帳號的 ownership 要進完整 account footprint cleanup，不在此處靜默解除。第 120 號原 authority projection、原 ID／時間／journal 與已存在收據仍須由父流程保全。

原 sessions、entry_intents、限流與 consumed OAuth 的來源列、裝置 scope、target、payload、期限與 rowid 會保留在私人身份輸出；**沒有把它們啟用為新版登入或授權**。跨新舊裝置 proof 的原來源、期限、使用狀態與安全失效尚須完整重建流程核對。

合併後另以一次性的空白記憶體模型驗未知欄位、選擇／建立詞條引用、owner、OAuth board identity、聯絡保留與 source graph。該模型只作驗證，會關閉並丟棄；固定驗證 stamp、其中的 migration_map 及正規化 profile ID 不會成為輸出。**不能把 fresh import 的資料庫替換 native 最新資料庫**，這會丟失 native-only PIN、修訂、審計、同意、收據與原 provenance。

輸出只有合併的私人 `music` 來源／原 key mapping 與身份 image，固定標示 `sourceOnly=true`、`nativeReconstructionRequired=true`、`authenticationActive=false`、`recoveryRequired=true`、`rollbackEligible=false`、`releaseEligible=false`。不是可啟動的新庫、完整 forward restore 或發布候選。

## 驗證

新增 **41 項**合成案例通過。原 Python `Store.create_profile`、`contacts.save`、selection／shout handler、`admin_links.change`、session／entry intent 與限流方法在私人資料副本實際寫入；合併後保留新增成分、聯絡號、選擇、喊話、原解除關聯審計與待完成 proof。另一側 native 私人留言更新及原 generated profile ID 同時保留。另用原 Python `maintenance.replay` 驗 native 最新刪除已套入舊來源後不復活。

獨立 TS verifier 不呼叫 merger 或使用其 change list；重新讀取所有 JSON 實體、排序、mapping、十張身份表、storage class 與 sequence，再推導候選期望。測試重新改寫輸出 mapping、PIN、趨勢、額外欄位、身份列及 pin 後仍被拒絕。另一個 Python readonly oracle 直接讀原身份／候選十表及私人成分 JSON 對帳，不使用 TS 摘要或 migration_map 作期望。

負向涵蓋十份來源 pin、未核對 checkpoint、未知 JSON 欄位、重複 JSON key／shout、斷裂選擇／created 引用、會員消失、schema／storage class、row／PK／ownership／contact／趨勢／排序衝突、刪除復活、consumed OAuth 與高水位，以及最後邊界的 bytes／pin 變動和非同步 callback。第一輪 38 項中 37 項通過；失敗測試在合併前就違反來源唯一鍵，已改為兩份各自合法、合併才衝突的 native／old 新 prelink。原失敗結果保留在私人證據，沒有把它記成 pass。

本次固定來源相關回歸涵蓋 **27 檔**：本元件、看板合併／erasure／privacy、rollback board／music／identity／checkpoint／state／bot exclusion、原 snapshot import、全部 13 份 TS bot 測試，以及三份 database／migration 測試。最終 **481 項全部通過**，零 failed／pending／todo／skipped；獨立 verifier 核對每批 assertions、檔案清單與 985 份來源未改變。最新 strict、完整建置及隔離 build smoke 已通過；12 個 API／bot runtime bundles 與第 120 號 bytes 相同，離線來源工具沒有加入 runtime。

私人證據：`/Users/danersaka/.codex/rebuild-verification/forward-music-122-71a2a408d799443c8a68686e1ea3a898/`；固定來源 plan pin `4ff387ffe90b62bbf84077b060f0ba2ac4fcfdcb684067282f93814a5986c32e`，985 份來源、139 份完整 inventory，明確選取 27 份測試／3 批，每批一個 worker。第 120 號完整 1,890 項／137 檔回歸仍綁定其原提交，本輪不冒稱重跑目前全部 inventory。

## 尚須完成

- 將本成分／身份 source pair 與第 121 號看板結果一併重建 native 的完整資料圖；只按有效差異接回原 native profile ID，保全所有 native-only 列、原 receipts／proof／審計／PIN／同意及 source evidence，不重新建立業務或偽造收據。
- 完整 merge 後重播最新原 authority，修復已 applied／closed account 的私密 footprints 與跨域 request receipt 引用；原 audit mapping／sequence 在刪除與再次投影後仍須保全。structured reset 的詞條、歷史截點與原 scope 需要獨立證據。
- 真正停寫的成套 old／native capture、原 package provenance、媒體／wall／歷史資產、browser pending／proof，以及 authority epoch rebase／external high-water／custody 仍須完成。
- 固定 Linux 實際 web／Python 或 TS bot 版本組合、B01–B15、全功能瀏覽器、QQ／實機及資源規模驗收仍未完成。166 能力保持 `in_progress`，正式切換仍不放行。

按使用者要求先不部署，完整實作與逐項驗收的原目標不變。
