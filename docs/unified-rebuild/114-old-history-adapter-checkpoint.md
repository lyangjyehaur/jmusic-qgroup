# 舊成分歷史 namespace 與 HTTP adapter 檢查點

日期：2026-11-19。發布範圍 **`none`**：新增隔離回退工具、可明確安裝的舊服務 overlay 與合成 HTTP 演練。沒有修改舊服務原檔、新網站 runtime、正式資料、憑證、群設定或待送工作；未整合 main、部署或完成全功能驗收。

## 三種 namespace 保留

舊服務只列出並接受 `YYYYMMDD-HHMMSS` 的 paired backup；回退套件的 `legacy-pair-<stamp>`、`legacy-json-<stamp>`、`native-<完整 ID>` 無法用同一時間戳名稱表示。不能把同秒 pair／JSON／native 改成假的日期或覆蓋原目錄，也不能混入舊備份 retention 根。

`writeRollbackHistoryCatalog` 從已固定且完整驗證的 v1／v2／v3 私人套件取得全部歷史 JSON 投影，產生新的 owner 0700／0600 私人目錄：

- `histories/<完整 namespace ID>.json`：檢查點 109 的最新 erasure／身分投影原 bytes 表示，不複製私人原 identity、圖片、DB、session、bot 或 raw histories。
- `baseline-music.erasures.jsonl`：與投影配合的完整原 music ledger bytes。
- `history-catalog-manifest.json`：原套件／checkpoint／journal pins、唯一且排序的完整 namespace、sourceStamp、真實已知 native createdAt／schema、每檔 size／SHA，固定 `rollbackEligible:false`。

舊 pair／JSON 的 createdAt 和 schema 仍為 null，不解析檔名推論時區；native 使用原已知值。全量原素材仍保留在原私人回退套件，catalog 只是給舊 HTTP 下載的固定投影，不是完整歷史資料恢復或有效服務根。

輸出與套件及已記錄來源根隔離；v3 另外排除原 capture root。較舊格式沒有記錄全部原絕對路徑，操作者仍須獨立選擇隔離輸出，不能宣稱工具核對了未記錄來源。來源套件在 reservation／preseal／postseal 持續核對；同步 guard 可供後續協調器接入，thenable 拒絕。exclusive 新建、逐檔／目錄 fsync、最後 manifest、source／root／parent／histories inode fence 與 late incomplete 保全沿用前批原則。已有輸出不覆寫或續跑，替換的 root／parent 不觸碰。

`readRollbackHistoryCatalog` 要求外部保存的完整 catalog manifest SHA，核對 strict metadata、namespace 與來源型別對應、唯一排序、path／size／SHA、完整 inventory、private owner／mode／nlink、canonical paths 及原 inode／bytes guards。它核對固定 catalog 與外部 pin，不取代原 package 的完整跨領域來源認證。

準備命令：

```sh
npm run prepare:rollback-history -- <私人回退套件絕對路徑> <原套件外部-manifest-SHA256> <全新私人-catalog-絕對路徑>
```

CLI 不啟動 HTTP；stdout 僅有狀態／數量／digest／`rollbackEligible:false`，stderr 不回顯私人 path、原資料或底層錯誤。

## 明確安裝的舊 HTTP overlay

`rollback_history_runtime.py` 提供 `install_rollback_history_adapter(service, catalog_root, external_catalog_sha256)`。它不從環境旗標自動啟用、不寫回或替換舊原始碼，也不啟動服務。新產品前後端仍為 React／TypeScript；此 Python overlay 限定於尚待驗收的固定舊服務回退候選。

安裝前檢查 private catalog 與固定 pin，要求 catalog 與舊 writable music 根互相隔離，拒絕重複安裝。讀取時檢查 strict UTF-8／JSON、重複 key、不安全整數／非有限數、metadata／namespace、完整檔名與 private bytes／inode；不開啟 catalog 以外的私人 DB 或 raw archive。舊 identity 庫僅以 `mode=ro` 在目前 authority 流程讀取，不能靜默建立缺失資料庫。

overlay 接管以下兩個既有入口的 namespace 分支：

| 入口 | 行為 |
| --- | --- |
| `/api/admin/backups` | 保留普通時間戳備份並加入全部 namespace；name 可由原管理頁直接顯示及 URL encode；不新增宣傳文案 |
| `/api/admin/backup?name=<namespace>` | 只接受 manifest 內的完整 ID，沿用 JSON attachment filename／no-store 下載；未知 ID 拒絕，不把名稱拼成任意 filesystem path |

context／proxy key 和 admin_actor 使用原 Handler 驗證，且在讀取 catalog 前驗證。普通時間戳下載、非備份 GET、POST 和 HEAD 均保留原 Handler 流程；不新增寫操作、登入方式、QQ 請求或權限捷徑。原管理頁已使用 name.TextContent 與 encodeURIComponent，因此無需重新啟用舊 DOM 作為新版產品 UI；新網站不掛載此 overlay。

## 下載時的目前權威

固定 catalog 已套捕獲當時的最新 erasure 和身分；恢復後仍可能有新刪除、解除關聯、PIN 或 contact 更新。namespace 下載在原 upstream._lock 內讀取當前 ledger，驗證其保留 catalog baseline，使用原 sanitize 處理新增 QQ erasures，再以同一 readonly identity SQLite 交易取得 link_overrides／prelinks／links／profile_contacts 的目前有效值。

歷史資料的 boardUserId／pinHash／contactQQ 全部重新投影：目前存在的成分採目前 identity mapping、目前 data PIN 與目前 contact；歷史獨有成分即使原資料含舊憑證，也清空三欄。管理 hash 不進下載。舊歷史 identity、session 和 outbox 不被載入或啟動。

current ledger 缺失、不完整、重複 JSON key、baseline 遺失或讀取期間變動，或目前 identity 缺失／更換／資料型別無法核對，均停止下載，以 redacted 503 返回，不 fallback 至 raw archive。catalog 變動或額外檔案也阻擋清單／namespace 下載。

同一 overlay 程序在原 lock 下記住已驗證 ledger 的原 byte prefix，觀察到新刪除後若 ledger 截短則拒絕，防止同程序重新提供已刪資料。**這個水位只在記憶體內，不是 durable／跨程序／重啟後的刪除權威證明。** 捕獲與重啟仍須外部最新 ledger 保全及部署／retention 協調，不把此防護當作完整切換保障。普通時間戳下載沿用舊行為，本次未宣稱修正或驗收其全部恢復後隱私語意。

## 隔離證據與剩餘門檻

測試從真正 full package 產生同秒三種 namespace，保留 null 舊時間／schema 和真 native metadata，核對全量投影及來源 DB／bot claim 不變。source／late guards、already-existing／overlap／symlink 拒絕、root／parent／histories 替換、permissions／hardlink／inventory、manifest view 和外層 rehash metadata 均有拒絕案例。

HTTP 演練直接 import 未修改的 `music_site.service.Handler`，明確安裝 overlay，在 127.0.0.1 隨機 port 的一次性 server 發送真 HTTP 請求，finally 關閉 server／thread。使用合成 proxy key、隔離 identity／JSON／ledger，沒有正式憑證、外網、QQ 或 worker。驗證原 proxy／非管理拒絕、完整清單、三個下載／filename／no-store、普通 timestamp 入口、HEAD／格式拒絕，以及 PIN 更新／unlink／歷史獨有憑證清空、最新刪除、觀察後 ledger 截短、missing identity 不建立、catalog 竄改和 redaction。

這是 **本機原 Handler＋明確 overlay 的 HTTP 演練**；不包含正式反向代理／gateway、管理頁瀏覽器、固定候選映像、overlay／舊服務版本來源認證、完整舊 web／music／bot 啟動／讀寫、worker 續送或真正 QQ 驗收。不得把安裝這個模組當成原歷史映像已含相容 adapter，候選版本組合仍須明確保存及核對 overlay 來源。

相關 **133 項／3 檔通過**，Strict TypeScript 通過；完整單工回歸 **1,645 項／132 檔通過**，包含本次 adapter 的全部 41 項。紀錄：`/tmp/qgroup-history-adapter-targeted-final.log`、`/tmp/qgroup-history-adapter-typecheck-final.log`、`/tmp/qgroup-history-adapter-native-final.log`。release-source 拒絕文字來自預期拒絕的隔離測試，不是本次發布操作。

完整歷史入口 candidate／browser、歷史看板最新 erasure 恢復、原服務與 bot 全套恢復／新寫入 forward restore、browser pending／proof、有效配置／原版本紀錄認證、外部部署／retention 控制、正式規模／實機 QQ 仍未驗收。原 package 的 `old_history_namespace_adapter` remaining 先保留，等待固定候選及整套流程證據。全部私人產物 **`rollbackEligible:false`**；台帳 **166 in_progress／0 完整驗收，release_eligible=false**。不部署。
