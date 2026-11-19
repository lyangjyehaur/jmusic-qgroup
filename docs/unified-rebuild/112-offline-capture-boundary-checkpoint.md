# 離線回退封存與來源邊界檢查點

日期：2026-11-19。發布範圍 **`none`**：新增離線私人封存 API／CLI、來源證據契約與隔離測試；沒有修改 web／bot 運行程式、正式資料、憑證、群設定或待送工作。未整合 main、部署或完成全部功能驗收。

## 完整封存入口

`captureRollbackPackage` 將檢查點 111 的元件接成一次同步擷取。輸入為完整 JSON 原 bytes 及外部保存的 SHA-256，最多 64 KiB，使用 strict UTF-8／JSON／schema。它只使用已存在的業務庫與 `.bot-owner.sqlite3`，不初始化、遷移、啟動 worker、停止服務、回收工作或清理來源。

CLI 要求已存在、canonical、目前使用者擁有且模式 0600 的私人輸入檔；在持鎖檢查內再次核對原檔案，不只驗證啟動時的 checksum。以下指令僅適用隔離副本與受控的本機服務證據：

```sh
npm run inspect:rollback -- <完整-container-id> <canonical-local-docker-socket>
npm run capture:rollback -- <私人輸入檔絕對路徑> <外部保存的完整輸入-SHA256>
npm run verify:rollback -- <套件絕對路徑> <捕獲時保存的完整-manifest-SHA256>
```

輸入欄位：

| 欄位 | 契約 |
| --- | --- |
| `database`／`expectedLineageId` | 已存在的 canonical 新庫與明確 lineage；`recovery_required` 必須為 0 |
| `bot.logDirectory`／`bot.sensitiveWordsFile` | 明確最新 bot 日誌根與 nullable 自訂詞庫來源；縮寫根依實際 bot 約定推導 |
| `history.capture.root`／`manifestSha256` | 與目前 data 隔離的原始遷移 capture 及外部原 pin |
| `history.native.root`／`manifests` | 必須是業務庫父目錄的 `paired-backups`；完整指定 ID／SHA，缺失根僅容許空 inventory |
| `destination` | 不存在、與全部來源隔離的輸出目錄；已有 partial 不覆寫或續跑 |
| `dockerSocket` | 可省略；省略時只解析本機 `/var/run/docker.sock` 的 canonical 目標，明確傳入時不接受 symlink 或遠端 endpoint |
| `services` | web／bot 各一個不同的完整 container ID、不可變 image ID、完整 commit、事先核對的 narrow evidence SHA；web 必須 TS，bot 可 TS 或保留 Python |

`inspect:rollback` 只輸出 role、runtime、container ID、image ID、觀察到的 revision、narrow evidence SHA 與停止狀態，不輸出來源路徑、完整環境、指令或憑證；固定標示 `releaseSourceCertified:false`。capture／verify 輸出僅有狀態、數量、digest 與 remaining；錯誤不回顯私人路徑或底層 stderr。

## 服務與 socket 證據

Docker 子程序只允許本機 Unix socket 上的 `inspect --type container --format … <完整 ID>`；移除子程序的 Docker endpoint／context／TLS override 及 NODE_OPTIONS。格式僅選取必要欄位，不讀完整環境、logs 或 secrets。核對完整 ID、image、revision、Compose role、state／PID／restart／起停時間、實際 runtime 與最深層 bind mount；shadow、ambiguous、volume 或錯誤來源不放行。

識別的 runtime 為 `/app` 下固定的 `node .rebuild-dist/api/start.mjs`、`node .rebuild-dist/bot/start.mjs` 或 `python3 -m qgroup_bot.main`，entrypoint 也必須符合限定形狀。TS 必須 production；配置 NODE_OPTIONS 則拒絕。bot 若有 `KANBAN_BOT_ENV` override，尚未取得有效配置證據，直接拒絕；不能忽略檔案 override 後宣稱路徑正確。web 若配置原歷史根／pin 必須吻合，未配置時僅私人保全，不代表 adapter 已接上。

capturer 先固定 socket 的 device／inode，每次 inspect 前後核對；獨立 inspector 也核對單次命令前後的 socket 身份及返回 container ID。對相同型別的替換 socket 同樣拒絕。這是來源身份 fence，不是 Docker daemon 或部署排程的互斥鎖。

沒有 revision label 的保留 Python bot，僅在私人输入明確提供完整 commit 和 `commitRecordSha256` 時容許保存觀察到的 null；矛盾的非 null label 仍拒絕。**工具只保留該外部紀錄 reference，沒有讀取、驗證或認證紀錄內容，也沒有證明映像真正對應該 commit。** 包含有 label 的映像在內，实际來源版本及候選組合驗收仍未完成。

## 持續鎖與来源 fence

既有 Python／TS owner 排他鎖與業務庫 standalone IMMEDIATE 持續涵蓋最新 journal／media／bot／history 擷取、全部投影、獨立對帳、private package IO／fsync 和來源核對。來源 SQLite、owner 及 sidecars 不經額外原 FD 開關，避免釋放程序級 POSIX SQLite 鎖。

完整 raw erasure journal 另存原 bytes，保留空白、空行與缺失語意，不 chmod。格式解析及 applied markers／receipts 必須一致；只有真正空且一致的來源容許缺失 ledger。外部 raw file 以 no-follow、單 hardlink、metadata／bytes／原 parent 身份固定；每次重讀先檢查原 metadata，避免開啟已被替換成鎖定 SQLite 的檔案。

原 capture、native archives、images、walls 另外保存完整 metadata／檔名／目錄身份 fence，包含空或缺失的根；retention 刪除、換根、新檔及變更時間均拒絕。history 只取得一次，從已持有 bytes 投影，持續保留 acquisition guard 至全部 IO 結束。

初始觀察 web／bot 各一次，其後在投影前、writer 保留輸出前、preseal、postseal、writer 返回後各再檢查兩服務，共 12 次。每次先觀察服務，再查來源，避免 inspector 引發的來源變動逃過最後檢查。所有 callback／input guard 必須同步，thenable 拒絕；不是不可信程式的沙箱。

late failure 沿用私人 partial 保全。writer 返回新增只針對原輸出／parent inode 的 `markIncomplete()`，外層在 writer 返回後、資料庫或 owner 結束時失敗也嘗試補 marker；固定 reader 拒絕。替換的輸出目錄不標記、不覆寫、不移除；原失敗仍為權威結果，不能把倖存 manifest 當成成功捕獲證據。

## 私人套件 version 3

v3 保留 v1／v2 全部 state、media、history、最新 bot 原 bytes／mtime 與 pins，新增 `captureBoundarySha256` 和下列私人產物：

- `private/latest/capture-boundary.json`：輸入／checkpoint／journal entries／media／bot／history digests、lineage、raw journal descriptor、兩服務原 narrow observations。
- `private/latest/capture-input.json`：外部核對的完整原輸入 bytes，不正規化替換。
- `private/latest/source-unified.erasures.jsonl`：存在時保存原 journal bytes；與 canonical 投影 journal 分開。

獨立 verifier 只使用已封存 checkpoint／bytes 和 reviewed input，核對全部跨領域 pins、來源參照、原 journal／markers、service pins 與 canonical inventory，不探測或重開原 live paths。v1／v2 仍可讀寫；版本／pins／inventory 嚴格配對，拒絕 downgrade 遺留新檔及外層 rehash 後的語意竄改。

邊界固定記錄實際已具備的控制：`existing-local-sqlite`、`standalone-immediate`、`stopped-observations`、`source-fence-only`、`not-coordinated`；`rollbackEligible:false` 不可修改。不把停止觀察當成完整停寫權威，不把 metadata fence 當作 retention 排程鎖，也沒有取得外部部署／跨主機投遞排除。

## 驗證與剩餘工作

隔離測試涵蓋 TS／保留 Python／無 label 紀錄 reference、全部 outbox statuses／claim／retry／simulation／已送本文、原 journal 空白／缺失、完整 v3 固定 reader、兩 CLI redaction、socket 同型替換、原 pins、來源與輸出替換、retention、late partial、輸入改動及外層 rehash 竄改。真正 Python SQLite 程序在 held boundary 競爭業務庫與 owner，均被排除，返回後可重新取得；沒有呼叫真 QQ 或啟停 Docker 服務。

Docker CLI 測試使用假 `docker` executable、真一次性 Unix socket及合成 inspect response；對 Go-template 三種指令 predicates 作結構解析核對，**未執行實際 Docker／Go-template**。此結果不能取代實際 Docker／映像／有效配置／來源版本證據。

相關 **225 項／4 檔通過**，Strict TypeScript 通過；完整單工回歸 **1,558 項／130 檔通過**。紀錄：`/tmp/qgroup-capture-boundary-targeted-final.log`、`/tmp/qgroup-capture-boundary-typecheck-final.log`、`/tmp/qgroup-capture-boundary-native-final.log`。完整回歸中的 release-source 拒絕文字來自預期拒絕的隔離測試，不是本次發布操作。

仍缺外部部署／retention 協調及完整停寫邊界、有效 bot override 與實際版本紀錄認證、外部 bot 原時間／狀態恢復、舊歷史入口 adapter、歷史看板最新 erasure 恢復、browser pending／proof、固定舊 web／music／bot 全套讀寫與 forward restore、正式規模／實機 QQ／候選版本組合。台帳維持 **166 in_progress／0 完整驗收，release_eligible=false**。不部署。
