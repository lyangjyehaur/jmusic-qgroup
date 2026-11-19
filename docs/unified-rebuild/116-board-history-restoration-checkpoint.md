# 歷史看板資料與图片恢復檢查點

日期：2026-11-19。發布範圍 **`none`**：新增離線歷史投影、私人產物與驗證工具。只使用合成資料及隔離目錄，沒有修改運行中的 web／bot、正式憑證、群設定或真實待送工作；未整合 main 或部署。

## 歷史來源與最新刪除

`rollback-board-history-source.ts` 從完整驗證且有外部 pin 的私人回退套件讀取歷史原 bytes，不開啟記錄中的原服務路徑。保留兩種完整 ID：

- `legacy-board-YYYYMMDD-HHMMSS-ffffff`：原看板 DB／gzip 圖片配對，createdAt／schema 保持 null，不從檔名猜時區。
- `native-board-<完整 native backup ID>`：保留原 schema 13／14／15、createdAt、database digest 及 manifest digest；沿用來源、lineage 與升級驗證。

目前 legacy 路徑要求固定 59 表 schema、獨立 SQLite header、完整性、外鍵及序號檢查。其他歷史 legacy schema 明確拒絕，**更早期 schema 的完整恢復仍未驗收**。原備份完整保留，不能把拒絕當成已覆蓋所有舊版本。

`rollback-board-history.ts` 先套用最新刪除，再產生舊看板表投影。legacy 使用原 Python `privacy.erase` 的帳號關閉語意；native 先重播完整最新 unified journal，再投影舊表，並補套原看板 closure markers，涵蓋已匯入但未出現在 unified journal 的舊申請。music-only／reset 意圖不轉成帳號關閉。

撤銷管理權、session／外部身份／UnionID 與待授權資料、私人付款碼、該帳號的投票及無引用圖片；保留原申請 ID／時間、共享帳務及其真實待審狀態。open／closed 投票按原規則更新 vote_revision，decided 歷史不改版次，其他會員的票保持。新的無效 token 使用隨機值。凍結帳單、負數金額、原 actor 名字、BLOB 收款碼／憑證、所有舊 bot pending／sending／sent／failed／skipped、claim、retry、simulation 與實際已送本文均保留為**歷史資料**；不啟動 worker 或投遞工作。

## 圖片與獨立對帳

gzip／ustar 在記憶體有界解碼，最大 512 MiB，不執行 filesystem tar extraction。只接受內容定址的 regular files，核對 header checksum、digest 路徑與分片、唯一 inventory、檔案大小／digest、padding、完整 terminator 與 trailing data；拒絕 links、PAX／GNU extensions、路徑穿越、重复檔及不完整 archive。先核對原 DB 全部 image_assets，再套刪除並篩選輸出，不能用最新刪除掩蓋原配對損壞。無外部圖片的舊 DB-only 備份仍可用。

`rollback-board-history-reconciliation.ts` 重新開啟同套件保留的歷史來源，以另外的 closure SQL 規格推導預期結果，不呼叫歷史 projector。核對全部 59 表、schema／index／trigger、signed rowid、storage class、SQLite metadata、序號高水位、原 journal／checkpoint pins 及每張圖片。隨機 token 先核對 64 hex、唯一且不等於原／最新 user 或 session token，再只在 disposable 比較庫正規化；原輸出 bytes 不改動。帳號有 completed marker 但仍可登入或留有私人投票資料時拒絕，不因原 recovery 會略過它便放行。

## 私人恢復產物

準備與讀取命令：

```sh
npm run prepare:rollback-board-history -- \
  <私人回退套件絕對路徑> <外部套件-manifest-SHA256> \
  <完整歷史-ID> <全新私人輸出絕對路徑>

npm run verify:rollback-board-history -- \
  <私人歷史輸出絕對路徑> <外部歷史-manifest-SHA256> \
  <原私人回退套件絕對路徑> <外部原套件-manifest-SHA256>
```

輸出含 `board.sqlite3`、`board.erasures.jsonl`、`images/...` 與 strict canonical `board-history-manifest.json`；使用 owner 0700／0600、exclusive 新建、逐檔與目錄 fsync、最後 manifest。原套件 pin 必須另外保存；驗證時必須同時提供原套件，僅重算被改動 DB 的外層 manifest 無法通過語意對帳。

reservation／preseal／postseal 持續核對原套件及同步 boundary guard，拒絕 thenable。root／parent 與自建立時固定的 images 目錄身份持續核對；late failure 保留 incomplete marker。相同 bytes 的圖片目錄在最後 guard 被替換也拒絕，並在仍屬本次的原 root 標記 incomplete；被替換的 root／parent 不寫入。固定 reader 同時核對完整 inventory、mode／owner／nlink、inode、原 bytes 與返回的 manifest／projection view。

v2／v3 排除已記錄的最新 DB、bot logs 與自訂詞庫來源根，v3 另排除原 capture root。v1 沒有完整原絕對路徑，v2 也沒有原 capture root；操作者須獨立選擇隔離輸出，不能宣稱工具核對未記錄的來源。私人檔案權限不代表舊服務必然唯讀。

所有輸出固定 **`historyOnly:true`、`rollbackEligible:false`**。工具不切換目前資料、不建立運行設定或投遞 owner、不啟動任何服務。保留 latest ledger 的副本也不代表已完成跨程序／重啟後 durable erasure authority。

## 隔離證據與剩餘工作

測試以未修改的 `deploy/backup.py` 產生真正舊 SQLite＋gzip tar 配對，只注入合成時鐘；首次 TS 關閉結果與未修改的 Python `privacy.recover` 對帳。legacy／native 產物另使用原 Python recovery 重跑兩次及原 media readers 驗證。保留合成凍結帳務、BLOB、五種 bot 工作狀態及超出 JS safe integer 的 admin audit 高水位：`9007199254741015` 恢復後追加為 `9007199254741016`。

native schema 13／14／15、較早匯入 closure、假的 completed marker、損壞原 DB／archive、token／金額／bot／audit／圖片竄改、外層 rehash、來源與輸出 late replacement、private permissions／view mutation 及 CLI redaction 均有案例。v2／v3 完整套件直接驗證两種歷史產物、最新 DB／bot 原 bytes 不變，以及已記錄來源根的隔離拒絕；v3 service inspector 使用合成 response，不宣稱再次取得真 Docker 或實際 bot 版本證據。

歷史看板 **86 項完整測試通過**；完整原生回歸 **1,735 項／133 檔全部通過**，Strict TypeScript、能力台帳與 `git diff --check` 通過。完整回歸中斷後改以固定 input 指紋、完整 133 檔清單及 **15 個單工批次**執行，保留私人原紀錄與逐批 JSON 結果；不把中斷程序算成通過。最終重新核對所有檔案、逐項 passed 狀態、逐批 plan pin 及原始碼指紋，確認無重複、遺漏或不同版本混合。雙歷史產物整合測試使用明確 20 秒上限，全部資料斷言保持。

私人紀錄根：`/Users/danersaka/.codex/rebuild-verification/board-history-116-02d6786232cd47c3b7f9e5926c491144/`。`regression-plan.json` 固定原始碼指紋與分組，SHA256 為 `c39516d5109f20d268dec366cee6bb529d9d01c32f944474eb74ddbdc67a679f`；`final-batch-*.log`、`final-batch-*.result.json`、`final-batch-*.status.json` 記錄實際結果，`final-summary.json` 保存最終核對。`poll-closures.log` 與 `typecheck-final.log` 保存相關檢查。先前 `/tmp` 紀錄因執行環境重置已不存在，不能作為可交付紀錄。回歸中的 release-source 拒絕來自隔離負向測試，沒有發起發布。

仍缺更早期 legacy schema、durable latest erasure authority、固定舊 web／music／bot／history overlay 的完整讀寫／圖片／gateway／browser 與 forward restore、實際候選版本組合、browser pending／proof、有效配置與版本認證、外部 deployment／retention 協調、正式規模／效能／實體裝置及真實 QQ。台帳維持 **166 in_progress／0 完整驗收，release_eligible=false**。依使用者要求不部署。
