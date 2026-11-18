# 第九十四批實作：三服務一致快照擷取

日期：2026-11-19（Asia/Taipei）。分支 `codex/unified-rebuild`。變更範圍 **`both`**：擷取看板／成分與 bot 共用的資料、工作與來源版本。實際發布 **`none`**；沒有合入 main、正式來源擷取、正式服務／憑證／群設定／真實待送操作。

## 輸入與鎖定

新增 `npm run capture:rebuild -- <private-capture-input.json>`。工具在 Linux 執行，需要 Node 22.22.3、已安裝相依套件、`/usr/bin/flock` 與本機 Docker Unix socket。它不停止或啟動任何容器，不能取代維護窗的部署控制鎖、停止 bot／web／music／背景寫入及外部設定保全。

輸入是實際停止服務所使用的原資料路徑，不是任意拷貝到另一處的副本。以下只示範隔離測試格式；容器／映像占位符須替換為實際完整 ID，不能直接執行：

```json
{
  "board": "/isolated/source-board/kanban.sqlite3",
  "boardLedger": "/isolated/source-board/kanban.erasures.jsonl",
  "music": "/isolated/source-music",
  "boardBackups": "/isolated/source-board-history",
  "botEvidence": "/isolated/source-board/bot-logs",
  "destination": "/isolated/new-capture",
  "dockerSocket": "/var/run/docker.sock",
  "services": [
    {"role":"web","containerId":"<完整 64 位容器 ID>","imageId":"sha256:<完整映像 ID>"},
    {"role":"music","containerId":"<完整 64 位容器 ID>","imageId":"sha256:<完整映像 ID>"},
    {"role":"bot","containerId":"<完整 64 位容器 ID>","imageId":"sha256:<完整映像 ID>"}
  ]
}
```

三個角色及容器 ID 都不可重複。Docker 唯讀檢查明確使用指定的本機 Unix socket，不追隨環境中的遠端 `DOCKER_HOST`／context／TLS 設定。只取得固定 ID／image、Compose 角色、停止狀態／PID、開始與結束時間／重啟計數、OCI revision、三個資料路徑設定及 mounts；不輸出完整 env、其他密鑰或 Docker 設定。

源容器必須為 `exited` 或 `created`、PID 0，且不是 running／paused／restarting／dead。`KANBAN_DB`、`JPM_DATA` 與 bot log dir 必須經實際 bind mount 解回輸入的宿主檔案；不能只看同一個資料目錄。嵌套掛載覆蓋、另一個 DB／JSON／log dir、非 bind、相對或未正規化路徑都拒絕。

先核對服務，再取得已存在 `.service.lock` 的真實 Linux `flock`；此鎖與舊 Python `service_lock()` 使用相同 OS 排他語意。持鎖子程序不讀原稿、清除 `NODE_OPTIONS`、父程序管道關閉即退出；使用原 inode 證據偵測鎖被替換。接著對原看板與身份 SQLite 分別取得 `BEGIN IMMEDIATE`，失敗不等待／重試、釋放已取得的鎖，不遷移或修改原業務列。

三個容器在鎖前、持鎖後、產物完成及 fsync 後共核對四次；即使啟動後又停止，時間或重啟計數變動也拒絕。兩份 DB 以含已提交 WAL 頁的 `serialize()` 保存，只將副本 header 轉為 standalone，不單抄 live main DB。SQLite 的鎖／sidecar／checkpoint 行為不等於逐 bytes 保持原 DB 物理檔案不變；業務列、schema、序號與 bot 狀態不被改寫。

## 產物與歷史邊界

只有尚不存在且與所有來源隔離的新目的目錄可用。輸出為：

```text
new-capture/
  current/board.sqlite3
  current/board.erasures.jsonl
  current/images/<prefix>/<digest>.png
  current/music/{data.json,identity.sqlite3,erasures.jsonl,walls/…}
  history/board/<原 kanban DB／images.tar.gz／privacy ledger>
  history/music/paired-backups/<原時間 ID>/…
  history/music/backups/data-<原時間 ID>.json
  bot-evidence/<原授權狀態／health／JSONL 日誌>
  capture-manifest.json
```

`current/` 可直接交給既有隔離匯入器；歷史與 bot 證據位於其他私人目錄，不混入原匯入器的檔案白名單。保存所有原媒體 bytes，包括尚未引用的原稿；當前引用的圖片還須對上 size／digest，壁紙引用不得缺檔。沒有原圖片目錄且無引用時記為明確空集合，不在原來源建立目錄。

原 music paired history、舊單 JSON、看板歷史 DB／圖片 tar 及舊 ledger 都不覆寫、不輪替、不重新生成；缺少配對 JSON／身份庫、孤立看板圖片 tar、未分類／symlink／特殊檔、損壞 JSON／當前 ledger 或不完整 bot JSONL 皆拒絕。舊歷史 tar／DB 在此階段只是 opaque 私人原稿，**尚未完成完整配對內容對帳、最新刪除下載 adapter 或恢復驗收**；有配對名稱不代表可恢復。

私人 manifest 保存來源路徑、服務映像與重啟證據、相對檔案 checksum／size、歷史與 bot 證據列數、鎖種類、source digest 與未完成門檻。只有有效的 OCI SHA label 會記成 `sourceCommit`；沒有 label 時保留 `null`／`external-record-required`，不從 tag 推導 commit。這不是對來源 commit／main 來源或候選版本組合的放行。

來源原稿 bytes／檔案清單、DB logical image 與 inode 在完成及最後發布前重驗；更改、替換原 DB、服務復跑、失去鎖或競爭目的目錄均拒絕。stage 0700、每檔 0600、檔案與目錄 fsync，排他 reservation 防止同工具同目的地並發；最後才 rename。失敗清理本次 stage／reservation 並釋放兩庫與 music 鎖，保留來源及競爭者資料。rename 後發生同步或清理錯誤仍須檢查目的地，不能據錯誤直接覆蓋。

CLI 只有 status／sourceDigest／releaseEligible=false，不輸出私人資料或完整輸入。單檔上限 512 MiB；整批仍同步序列化並持 writer lock，實際規模的 RAM／磁碟／停寫耗時尚待量測。

## 隔離驗證與下一步

新增 `capture-snapshot.test.ts` 涵蓋固定版本與角色／資料路徑／重啟拒絕、兩庫真實 writer lock、WAL／全部 bot 狀態／原 schema／ID／高水位、原歷史／媒體、來源變動／原 DB 替換／鎖失效／目的地競爭、缺檔／symlink／不完整原稿及鎖取得失敗清理；擷取產物接續既有匯入並通過獨立看板／成分對帳。原 Python 程式未改動。

實際 Docker inspector 對三個未啟動的本機 fixture 容器通過，明確本機 socket 能排除無關遠端 DOCKER_HOST，其他 env 值未輸出，容器已移除。`verify-capture-locks.mjs` 在 readonly／network none／256 MiB／無額外 swap／1 CPU／64 PIDs／64 MiB tmpfs 的本機 Linux/amd64 模擬容器通過：OS flock 外部排他／inode 替換／釋放、兩庫 writer lock、WAL 與合成原列不變。Linux probe 的容器 evidence 是注入 fixture；Docker inspector 與 kernel lock 各有實測，不能當成正式 Linux 上完整流程或原 QQ／實際候選 bot 組合已驗收。

Linux probe 重用前一批固定映像 `sha256:a6774a8b96780be98e7453ee348c376d8d0733d2dfbe5a7da14a1456f5b2cc8c` 的 Node／SQLite 相依環境，擷取工具 bundle 以 readonly 掛入；沒有建立新的候選映像或 registry push。記錄：`/tmp/qgroup-capture-docker-inspection-final.log`、`/tmp/qgroup-capture-linux-probe-complete.log`、`/tmp/qgroup-capture-targeted-complete.log`。最終完整單工 **1,088 項／117 檔通過**，新增 **37 項**擷取測試；針對性 37 項亦通過。Strict TypeScript、production React／API／bot build 與 compiled smoke 通過，包含 mock bot HTTP／WebSocket／ACK／Resume／不確定投遞／模擬／CLI／SIGTERM、隔離 SQLite／sharp、原生配對備份／歷史匯出與恢復啟動阻擋。記錄：`/tmp/qgroup-capture-native-verified.log`、`/tmp/qgroup-capture-build-complete.log`、`/tmp/qgroup-capture-smoke-complete.log`。未改 TSX／UI，未重跑瀏覽器；主 JS 仍 **1,482.05 kB／gzip 432.87 kB**，效能拆包仍未完成。

**166 IDs／166 in_progress／0 完整驗收，release_eligible=false**。接續完成歷史備份下載的最新刪除／身份覆寫與原稿保全、新寫入回退匯出、部署控制／實際停寫擷取演練、來源 commit 補證、B01–B15 與實際候選 web／bot 組合、效能、實機／QQ WebView／平台驗收。依使用者要求先不部署。
