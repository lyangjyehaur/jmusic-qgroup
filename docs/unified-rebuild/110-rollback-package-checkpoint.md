# 第一百零四批實作：完整私人回退套件落盤與固定讀取

日期：2026-11-19（Asia/Taipei）。分支 `codex/unified-rebuild`。變更範圍 **`both`**：完整來源、身份、刪除、媒體、歷史與 bot 工作需成套保全；實際發布 **`none`**。只使用合成來源與隔離輸出，不整合 main、不操作正式資料或服務。

## 完整套件與來源 pins

新增 `rollback-package-codec.ts`，把既有完整 state、media 和 history 組裝成一個套件。先以外部捕獲的完整 checkpoint SHA、原媒體完整 inventory／size／SHA、原 capture manifest SHA 和每份 native manifest SHA 核對來源，再逐領域驗證同一固定 checkpoint 的全部資料、journal／receipts、原列／rowid／序號、身份與審計映射、最新 erasure scope、壁紙及圖片、歷史投影。驗證者不相信 component reports；呼叫者偽造 `rollbackEligible:true` 不會改變結果。

`pinRollbackPackageSource` 供捕獲邊界保存 pins；從任意 bytes 重新計算 pins 不能證明來源權威。組裝器與落盤器沒有取得部署鎖、停止服務／備份排程或證明實際候選版本；這些仍是正式回退的門檻，不把完整落盤等同可上線。

套件包含三組固定 namespace：

- `private/latest/`：完整新 SQLite、完整統一 journal、music key／identity audit／erasure scope／media index。全部新表、憑證、已刪證據及 bot claim 原 bytes 保留。
- `private/original-media/`、`private/legacy-capture/`、`private/native-history/`：全部原檔案、原 manifests、歷史 DB／JSON／身份／圖片及 bot 證據，保持 byte-identical。
- `projection/`：舊看板 DB／ledger／有效圖片、最新 music JSON／身份／ledger／壁紙，以及三個不碰撞的歷史 JSON namespace。資料下載投影已套最新隱私／身份規則，私人原資料不混入。

這些 namespace 用於套件封存與對帳。所有檔案都是私人套件的一部分；沒有為 raw archives 新增公開下載 API，也沒有把歷史身份或 outbox 啟用。原 manifest／壁紙 bytes、缺失項、生成 key、重置後新寫入及完整新庫證據沿用檢查點 102–109 的獨立對帳。

## 獨佔目錄與失敗保全

新增 `rollback-package.ts`。落盤前驗證整套資料、明確 canonical 輸出與 source roots，拒絕來源／輸出重疊；`/` 也按真正祖先處理。以 exclusive mkdir 保留最終目錄，不用 rename 覆蓋既有目錄。既有 file／directory／symlink 一律拒絕，不覆蓋或自動續跑。

目錄為 owner 0700，檔案以 `O_EXCL | O_NOFOLLOW` 新建為 0600。先保存 `incomplete.json`，逐檔寫入並 fsync，落盤 bytes 再完整解碼與對帳，全部子目錄依序 fsync；最後移除 incomplete marker、再新建及 fsync `rollback-manifest.json`，同步 root／parent。manifest 列出完整固定檔案集、size／SHA、來源 pins、真實建置時間及固定 `rollbackEligible:false`。

失敗保留全部不完整 bytes，不清除來源或猜測可續跑。封存後才發現失敗時，在原 owner／inode 仍成立的目錄補回 incomplete marker；根／父目錄被替換則不碰替換目錄或別人的檔案。沒有完整 manifest，或存在 incomplete marker 的輸出都無法通過讀取器。manifest 與 fsync 不能證明服務停寫，也不提供舊程式啟動限制。

## 固定讀取與唯讀 CLI

`readRollbackPackage` 必須收到外部保存的完整 manifest SHA。先核對 root／每層目錄 owner、0700、canonical／inode、每個 regular file 的 owner／0600／單一 hardlink、完整 inventories 與每個 size／SHA，再重建全部 domain 並執行獨立對帳。重新編碼必須與完整實際檔案集及 canonical metadata bytes 相符，拒絕額外、遺失、重複引用、路徑穿越及未知 metadata。manifest 自稱 eligible、改 checksum 後丟失原 capture 或原媒體 pin、改最新 ownership／claim 也無法通過。

回傳的是私人記憶體證據，沒有暴露原 SQLite connection。`assertUnchanged` 再核對 bytes／manifest／完整 inventories 和原目錄 inodes。所有臨時 SQLite 仍按既有元件 finally 關閉，不修改讀取的套件或 live source。

新增唯讀命令：

```sh
npm run verify:rollback -- <private-package-directory> <external-manifest-sha256>
```

CLI 成功只輸出 status、檔案數、checkpoint digest、`rollbackEligible:false` 與尚缺驗收；拒絕時輸出固定 redacted 錯誤，不帶私人路徑、PIN、claim、session 或 raw data。沒有建立套件的 live-source CLI，也沒有服務停止／啟動或部署操作。當前每檔支援上限 512 MiB，完整套件含數份記憶體副本；正式規模 RSS／CPU／執行時間／磁碟與故障恢復仍需獨立驗收。

## schema 14 歷史備份讀取修正

既有 version 2 manifest 只接受目前 REBUILD_SCHEMA_VERSION（15），因此 schema 14 的正常歷史備份無法讀取；合成 manifest 已重現拒絕。PairedBackupManifest 改為明確接受 version 2 的 schema 14／15，未知版本仍拒絕，version 1／schema 13 規則不變。實際原 bytes／內部 schema／lineage／journal／images 照常核對，升級只在記憶體副本進行。原 schema 14 SQLite 和 manifest 不改寫，歷史 metadata 仍記 schema 14，新增的 unified consent 表保持空，不能推導新的同意。

隔離測試同時經過原配對備份 list／open、完整 history／package 及目前管理員 HTTP music-export 路由，核對待送 claim、原 native DB bytes 及歷史 schema。這是合成版本／API 相容證據，沒有正式候選映像或 QQ 驗收。

## 驗證與未完成門檻

測試涵蓋完整跨領域 round trip、source／bot 不寫入、0700／0600、原 manifests／bytes、外部 pins、既有輸出拒絕、來源重疊、symlink／hardlink／public permissions、額外／遺失檔案、更新輸出 checksum 後的 domain／raw source 竄改、incomplete／fsync／封存後故障、目錄替換、固定 reader 後變更，以及真正 CLI 成功／redacted 拒絕。額外記錄實際 fsync calls，確認全部 payload files 和目錄都先於最終 manifest 發布，不只檢查 manifest 最後存在。

相關 **57 項／2 檔通過**（package 41、既有 admin backups 16），Strict TypeScript 通過。紀錄：`/tmp/qgroup-rollback-package-targeted-final.log`、`/tmp/qgroup-rollback-package-typecheck-final.log`。完整單工回歸 **1,415 項／127 檔通過**，紀錄為 `/tmp/qgroup-rollback-package-native-final.log`。

本套件仍 **`rollbackEligible:false`**；台帳維持 **166 in_progress／0 完整驗收，release_eligible=false**。下一步需要控制與證明同一停寫捕獲邊界、舊歷史入口 adapter、歷史看板最新刪除恢復、browser pending／proof 恢復、固定舊 web／music／bot 全套讀寫／forward restore、正式規模及實機 QQ／實際候選組合。沒有部署。
