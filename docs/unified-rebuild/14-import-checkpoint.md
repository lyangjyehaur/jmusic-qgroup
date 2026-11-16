# 第八批實作：成套快照隔離匯入與舊成分投影

日期：2026-11-17（Asia/Taipei）。分支：`codex/unified-rebuild`。發布範圍 **`none`**。本批建立 P2 離線匯入器，不是正式切換工具；未讀取正式資料、未連接 QQ、未操作正式服務。完整目標與 166 項驗收門檻不變。

## 輸入與操作

新指令只接受**已停止寫入、成套且私有的副本**，以及尚不存在的隔離輸出目錄：

```sh
npm run import:rebuild -- /absolute/private-snapshot /absolute/new-candidate
```

目前明確輸入結構如下。兩份 ledger 即使沒有內容也必須明確提供空檔，避免把「未取得最新刪除紀錄」誤認為沒有刪除。此工具不從正式服務擷取快照、不取得遠端憑證，也不替代舊站維護鎖與 SQLite 備份程序。

```text
private-snapshot/
  board.sqlite3
  board.erasures.jsonl
  images/<digest-prefix>/<sha256>.png       # 有引用時必須成套提供
  music/
    data.json
    identity.sqlite3
    erasures.jsonl
    walls/manifest.json
    walls/<filename>.png|jpg|jpeg|webp
```

看板須符合凍結基線 59 張表的完整結構、索引、trigger 與 migration 1–20；成分身分庫須包含目前列明的 10 張表及欄位。未知 schema、欄位、檔案、未分類資料、JSON 重複鍵、損壞的 UTF-8、超出安全範圍的數值、不完整 ledger、缺少媒體引用、符號連結或 WAL／SHM 等正在寫入的副檔都拒絕。不能把服務運行目錄直接交給此工具。

來源檔案以唯讀方式開啟；SQLite 查詢在私有暫存副本執行，避免唯讀 WAL connection 在來源目錄建立 sidecar。匯入前後核對所有來源 bytes digest／檔案清單，來源變動就停止。單檔目前上限 512 MiB，大型來源的分塊／資源驗收仍待完成。

成功輸出 `unified.sqlite3`、獨立 `unified.erasures.jsonl`、`legacy-music.erasures.jsonl`、成套引用圖片／壁紙及 `import-manifest.json`。目錄 0700、檔案 0600；先在相鄰私有暫存目錄完成資料與媒體驗證、checkpoint、候選樹內檔案及目錄 fsync，再發布為候選目錄。發布後只同步目的地父目錄，不遍歷來源或相鄰工作目錄。失敗刪除本次暫存結果，不發布半套候選。不得用這個指令覆蓋既有候選或新寫入。

相同來源 digest 且有已提交 import marker 時只回報 `already_imported`，檢查現庫完整性，不重新寫回資料；後續使用者修改、刪除與新 profile 均保留。來源變動則要求新的隔離目錄，不暗中進行增量覆蓋。標準輸出只有狀態、來源 digest、schema 與 `releaseEligible=false`；來源列／私人資訊不寫入公開輸出。

## 看板、bot 與帳務保全

以 SQLite backup 複製原庫，保留全部 59 張表、原列／欄位、ID、排序序號、`sqlite_sequence` 高水位、BLOB、索引及追加式 trigger。不重跑舊初始化去推導名冊，不用 registration 重建 attendees，也不重算原帳單。

`migration_map` 記錄來源 namespace、表／實體、來源與目標 ID、版本、payload digest 及狀態；看板分批讀取、以 SQLite 64-bit 整數建立對照，避免 JavaScript 浮點改變大型 ID。來源紀錄先建立對照，再重播最新帳號刪除；被移除、遮蔽與重播產生的列分別標記，不靜默漏項。

成分身份與喊話保留原始來源序號，已刪除列也記錄對照狀態。匯入後刪除／關帳同步更新對照；孤立身份紀錄另標 `requires_legacy_review`，不能當成可運行的身份證據。

bot 設定、群政策、runtime、全部 outbox 欄位原樣延續：pending／sending／sent／failed／skipped、claim、重試、模擬時間、已送本文與 recipient。匯入器不啟動投遞者、不重置 sending、不讓 simulated 變成真送。這只是資料保全證據，尚未完成新網站通知、B01–B15、正式 bot 版本組合或唯一投遞者切換驗收。

## 成分權威投影與資料去向

順序為：最新成分刪除意圖 → native profile 缺失恢復 → contact 覆寫（包括空字串）→ link_overrides → prelinks → links。原 JSON `boardUserId` 不能單獨賦予 ownership；只有 JSON 關聯而缺乏權威記錄時停止，等待明確核對。已有 OAuth link 還須對上看板完整 provider／client／subject／user 關係；不使用 UnionID、手填 QQ 或名稱猜配。

- entries 保留原 ID、名稱、kind／category、aliases、建立者與時間；原 category 為「领域」且缺 kind 時依舊規則投影 main。
- 每份舊成分保留 legacy key，固定新 profile ID 由 namespace＋legacy key 的 SHA-256 推導；不以舊數字鍵作登入帳號。不為未關聯成分建立假 users。
- 有效 links／prelinks 一次導入既有會員，直接使用共用 session 存取原成分，不要求再次認領。沒有唯一有效對照、不同表衝突、重複 owner、遺失 user、聯絡號衝突或孤兒 selection／created entry 時停止，不搶占資料。
- 明確解除關聯不會被 JSON 舊 boardUserId 補回；profile contact 的清空不會被 native JSON 補回。帳號已關閉時保留成分並解除 ownership。
- 依舊 `norm_selection` 保留順序、去重、舊純 ID 的程度 3 及 1–4 範圍；領域原有程度保留，不改成統一預設。無法完整解析的資料拒絕，不悄悄刪掉。
- 成分稱呼／同意、PIN hash、聯絡號、建立詞條及性別／公開旗標／留言／各種時間等，分別保存在受保護欄位與 typed-domain 待接入資料中。沒有把成分稱呼覆蓋會員稱呼。
- 喊話、喊話歷史、趨勢與舊設定保留獨立 documents；舊 adminPasswordHash 僅是停用的遷移資料，不會設定或授予新管理權限。
- 原身分庫所有未刪紀錄保存在受保護的遷移表，包括 links、prelinks、override、history、native、contact、used_oauth、限流及 pending session／intent。舊 session／intent 尚未接新 adapter，台帳標記 `requires_legacy_adapter`；保留原資料不代表已能續用，這會阻擋正式切換。

原成分的完整公開 API／搜尋／推薦／編輯欄位、舊 PIN 認領及管理關聯修正仍待實作。現有 `/me/music` 只使用白名單，PIN、身份摘要與遷移原文不進會員回應；不能把「已匯入」當成所有成分功能已完成。

## 刪除優先與匯入後生命週期

舊成分 erasures 在 native recovery 之前套用；移除該成分、身份恢復資料、喊話／歷史，清空詞條建立者，保留 ID-only 墓碑及最新 ledger。新版 music／both 刪除意圖若對應已映射的舊 profile，同樣先阻擋匯入復活。帳號 journal 先重播再決定 ownership。

本批同步擴充既有刪除流程：

- 刪除已匯入成分會一併移除 PIN／聯絡號／私人欄位／native payload／舊 session 與 intent、該成分關聯歷史、喊話及詞條建立者引用，保留墓碑。重跑原來源不重新寫入，不能復活。
- 只關閉帳號保留獨立成分及選擇，刪除舊 account links／prelinks／該成分 session／intent，並清空 native recovery 的 boardUserId；不讓恢復路徑重建原關聯。
- 仍含帳號 ID 的成分關聯歷史計入 shared review，後台以「成分關聯歷史」列出，不謊稱全刪。latest deletion receipts 的語意沿用既有實作。
- 私有圖片只複製目前仍被 image_assets 引用且 digest 符合的 bytes；缺少引用圖片就拒絕。未引用／刪除後孤兒圖片不帶入候選；壁紙保留 manifest、啟用狀態和 bytes，不轉碼，路徑越界／缺檔拒絕。

原始來源副本與外部歷史備份仍須遵循刪除與保全政策，不由匯入器私自刪除。完整歷史快照下載濾除、paired backup 歷史、還原／回退匯出及來源保管期限尚待實作；本批不宣稱所有備份已完成刪除。

## schema 與驗證

新增 schema 3，總計 75 張使用者表（59 張相容表＋16 張新站／遷移表）。2→3 只增加遷移 manifest／mapping、舊成分欄位／詞條詳情、身分遷移、documents 與 erasure 墓碑；不改原看板表。已存在的 schema 1／2 開發庫循序升級，失敗回滾當次遷移。schema 2 的舊重構程式不能開啟 schema 3；正式回退方案尚未完成。

- `npm run test:rebuild`：105 項通過，新增 12 項成套匯入與 2 項版本遷移測試。涵蓋全部看板列／trigger／序號／BLOB、原 outbox 狀態、原 profile 直接讀寫、再次匯入不覆蓋後續寫入、兩套最新 erasure、native／contact／unlink、unknown／orphan／duplicate／身份衝突拒絕、來源 bytes 不變、媒體引用、私有檔權限、損壞 UTF-8 拒絕、不遍歷相鄰目錄及 CLI 最小輸出。
- 合成成套來源對原 Python 的 native recovery、contact、admin projection 與 norm_selection 做差分；有效 ownership、contact、稱呼與選擇一致。未使用正式資料或憑證。
- 匯入後分別刪成分／只關帳號，檢查舊 PIN、native、contact、identity 與 history 的實際去向；確認不能從原來源重播恢復已刪資料。
- strict TypeScript、React／API 建置、隔離空庫 built smoke、舊 UI 型別／生成產物及能力台帳檢查通過。前端仍約 538 kB，有既有單 bundle 警告，未掩蓋。
- 全套 Chrome 瀏覽器回歸 47 項通過，核對目前身份、成分及管理／刪除操作；不把桌面 Chrome 或合成資料等同真 QQ／WebView 與正式版本組合驗收。

## 接續工作

P2 尚未退出。接下來完成舊 PIN／QQ OAuth 認領與恢復、聯絡號編輯／查詢、管理關聯修正、完整成分欄位與活動名單成分；再推進既定 P3–P6。歷史備份、browser 草稿／Service Worker、舊協議 adapter、還原／回退匯出、資源測量及實際版本組合仍阻擋正式切換。維持 **先不部署**。
