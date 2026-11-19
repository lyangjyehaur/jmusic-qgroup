# 舊服務刪除紀錄保全與離線維護檢查點

日期：2026-11-19。發布範圍 **`none`**。僅新增私人回退演練工具和明確安裝的舊服務 overlay，未修改運行中的 web／music／bot、正式憑證、群設定或真實待送工作；沒有合入 main 或部署。

## 保全紀錄與恢復協議

`rollback-erasure-authority.ts` 從完整驗證且有外部 manifest pin 的回退套件建立新的私人 authority，保留 board／music／unified 三份最新 ledger 的原 bytes。immutable manifest 綁定隨機 authority ID、套件／checkpoint／journal pins 和三份 baseline；後續每筆 immutable record 綁定序號、前筆 digest、domain、原 suffix 的 canonical base64，以及追加後的完整 ledger size／digest。`authority-head.json` 指向最後已發布紀錄。

Python `ErasureAuthority` 先 fsync record／目錄，再發布並 fsync head，最後追加及 fsync 舊服務 ledger。thread RLock 與持續持有 FD 的非阻塞 flock 保全同程序及跨程序排除，read guard 在原 upstream lock 內核對最新 ledger。新 intent 先有保全紀錄，原帳號關閉／成分刪除仍執行原 SQL 與業務規則。

恢復只接受本地 ledger 是 authority 的 byte prefix，涵蓋缺失、舊 baseline、截斷或半行；外來、未記錄或衝突 bytes 明確拒絕。程序中斷若只留下最後一筆完整但尚未發布的 record，重啟會驗證完整 chain 後補完 head；缺失 head、破損／半筆 record、遺失已記錄 intent、未知 inventory 均阻擋，不丟棄或重新生成來源。

獨立 TS reader 核對全部 chain、三 domain 原 byte 格式、ledger metadata、private owner／mode／nlink／inode、inventory 及返回的 view；只讀取已完整發布的 snapshot，不補寫 head，不混合不同發布狀態。驗證逐 domain 使用 incremental hash／chunks／request-ID conflict map；這是實作方式，並不代表正式規模效能已達標。

目錄使用 owner 0700、檔案 0600、exclusive 新建及 fsync；來源／輸出 root、parent、baseline、records 和 lock 都有身份檢查，late preparation failure 保留 incomplete marker。authority 必須位於明確服務資料恢復及 retention roots 之外。已知 SQLite DB／WAL／SHM／journal 的 inode 用 lstat 收集並持續保留，新觀察到的恢復 DB／sidecar 也加入；**alias 拒絕必須在 raw FD 開啟前**，避免 close 額外 raw FD 釋放程序的 SQLite POSIX locks。固定服務、恢復工具與 sidecar 生命週期仍須成套驗證，不能僅依路徑隔離聲稱完整可用。

## 舊服務與維護入口

`install_legacy_erasure_authority` 只在明確選定的舊服務安裝，不靠環境變數自動啟用。核對 board DB／music folder 與原 module aliases，包覆原 privacy journal／recover、music administration record／replay／snapshot 及 service replay。每次啟動、重啟或恢復服務檔案後，在接收流量前必須呼叫 wrapped recover／replay。

原 namespace HTTP adapter 可明確接入 authority；普通歷史與目前管理匯出也在 authority guard 下使用原 current identity／PIN／contact 投影。既有 proxy／管理權限／confirmation 仍生效，guard／保存失敗向原操作回短而不含來源資訊的 503；啟動恢復失敗持續阻擋啟動。`authority=None` 保留第 114 號 adapter 行為。

新增 authority-aware 離線維護入口，使用原 service flock 排除運行中的 music，要求已存在的私人 DB／JSON，核對 schema／integrity，不建立或遷移缺失 DB，不匯入 HTTP service。先恢復並重播現有最新 intent，再對新刪除保存 authority intent 並執行原 `maintenance.replay`。支援 `erase`／`recover` 和兩種既有會員鍵。錯誤只輸出固定保全提示，結果只含狀態／紀錄筆數／不可回退標記。

**原 `python3 -m music_site.maintenance` 仍會直接寫本地 ledger，沒有自動被此 overlay 包覆。** 使用 authority 的候選演練必須選用下列新入口，並禁止任何直接寫 ledger 的入口；所有部署／排程入口的封鎖與固定舊映像認證仍待驗收，不能宣稱已涵蓋任意原維護指令。

```sh
npm run prepare:rollback-erasure-authority -- \
  <私人回退套件絕對路徑> <外部套件-manifest-SHA256> \
  <全新私人-authority-絕對路徑>

npm run verify:rollback-erasure-authority -- \
  <私人-authority-絕對路徑> <外部-authority-manifest-SHA256>

npm run maintain:rollback-music -- erase \
  --folder <私人舊-music-資料絕對路徑> \
  --authority <私人-authority-絕對路徑> \
  --manifest-sha256 <外部-authority-manifest-SHA256> --qq <會員鍵>

npm run maintain:rollback-music -- recover \
  --folder <私人舊-music-資料絕對路徑> \
  --authority <私人-authority-絕對路徑> \
  --manifest-sha256 <外部-authority-manifest-SHA256>
```

私人的 `.service.lock` 必須是原服務使用的相同 inode、owner 0600 的空 regular file。工具拒絕 public／link／SQLite alias，不會以新 lock 覆蓋舊 lock。以上都是隔離副本演練命令，不是正式部署或任意刪除的授權。

## 證據與限制

新增 **58 項測試通過**：三非空 baseline 的 Python 原 JSON bytes 互讀；真程序在 record_fsynced／head_published／before_source／source_fsynced 四階段 exit 77 再恢復；恢復舊 DB／JSON／identity 及缺失／舊／partial ledger 後原 Python recovery 重跑兩次；真 loopback 原 HTTP Handler 的刪除、PIN／unlink 投影、ledger 遺失及競爭 process；來源／root／parent／baseline／records／lock 替換、衝突 ID、破損 metadata、thenable 拒絕與 CLI redaction。離線 CLI 的原 replay、兩次恢復、真 service／authority flock 競爭、缺失檔案不初始化及固定錯誤也有直接案例。

兩個實際 SQLite writer 排除案例核對原及安裝後才觀察到的恢復 DB inode：持有 BEGIN IMMEDIATE，再把 ledger 路徑改成該 DB inode，authority 在 raw FD 開啟前拒絕，另一 Python writer 仍被排除。保留全部五種 bot 工作狀態、claim／retry／已送本文及來源 bytes；沒有啟動 worker 或真實投遞。原 history adapter 的 41 項既有案例另在完整回歸重驗。

完整原生回歸 **1,793 項／134 檔全部通過**。使用固定來源指紋、完整檔案清單與 **15 個單工批次**，最終獨立重新核對每檔及每項 assertion 的 passed 狀態、完整清單無重複或遺漏、逐批 plan pin、exit code、原始碼指紋及結果總數。不以先前 checkpoint 測試取代本次證據。Strict TypeScript、能力台帳及 `git diff --check` 通過。

私人紀錄根：`/Users/danersaka/.codex/rebuild-verification/erasure-authority-117-869c09d287ef4b9e9a1ec0d95df32fb7/`。`regression-plan.json` SHA256 為 `a638fc4127df0c4edfa379433b96242853b9f37c4fc47744ca568f812ca10ead`；`targeted-sqlite-refresh.log`、`typecheck-sqlite-refresh.log` 及逐批 log／result／status 保存原紀錄；`verify-final.mjs` 和 `final-summary.json` 保存最終獨立核對。

早期 fixture 曾把一份合成 music backup 寫到 repository 的預設備份目錄，已核對只有合成會員與詞條，將該檔移到私人紀錄根並設 0600，移除空目錄。後續 fixture 明確指定私人的 BACKUP_DIR；正式資料沒有被讀取或修改。

本次只保全**authority 本身獨立保留時的服務檔案恢復／重啟**。若 authority 全部 records 和 head 一起倒退或刪除，僅 baseline pin 無法證明最新高水位；外部 custody／retention／deployment coordination 仍是正式門檻。native unified 只保全 baseline 和協議，尚未接入新版 erasure writer／startup。舊 music reset 的 structured term scope、corrupt publication 的審計修復工具、全部維護入口約束、固定 image／overlay／gateway／browser 全服務組合、更早期 legacy schema、forward restore、browser pending／proof、實際候選 B01–B15、正式規模／效能／裝置／真實 QQ 均未完成。

所有輸出保持 **`rollbackEligible:false`**。台帳維持 **166 in_progress／0 完整驗收，release_eligible=false**；未授權部署，繼續按原計畫實作與驗收。
