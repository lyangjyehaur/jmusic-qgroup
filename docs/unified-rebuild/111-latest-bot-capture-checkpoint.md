# 最新 bot 外部狀態與持鎖封存檢查點

日期：2026-11-19。發布範圍 **`none`**：修改離線工具、私人套件契約及隔離測試，沒有修改 web／bot 運行程式、正式資料、群設定、憑證或待送工作。尚未整合 main、部署或完成全功能驗收。

## 最新 bot 外部來源

檢查點 110 保存的是最初遷移 capture 的 bot evidence，不能取代重構後新增的 bot 狀態。本次新增 `tools/migration/rollback-bot-state.ts`，明確接收 database、logDirectory 及 nullable sensitiveWordsFile，不讀取環境檔、QQ 憑證或啟動 worker。縮寫結果來源按現行 `dispatch-business.ts` 推導為資料庫父目錄下的 `bot-abbreviation-results/`。

完整保留以下私人原 bytes：

- 群發送授權／拒絕檔案 `bot-group-state.json`、群範圍版本及原錯誤碼；不得把 `push_authorized:false` 清除。
- `bot-health.json`、`bot-events.jsonl` 與 `.1`–`.4`，僅作歷史證據，不宣稱舊 ACK／健康時間代表目前在線。
- 縮寫 metadata、原本文、重新屏蔽後的版本本文及 worker 可能留下的原子寫入暫存檔。保留群 hash、原 created、byte offset、budget、uncertain、body 及 section_ends，沒有自動重送或清除。
- 明確配置的自訂屏蔽詞原檔；未配置記 null，已配置但檔案缺失則拒絕。內建詞庫仍隨固定 bot 版本提供，不從任意工作目錄推導。

每份檔案保存原 `mtimeNs`，供後續恢復遵守現有清理規則；不續期 metadata.created。現階段原時間保存在私人 index，落盤器沒有把套件改成可直接啟動的 bot 目錄，也沒有實作時間恢復或結果重新投遞。暫存／不完整／過期 bytes 保留作證據，不解析或轉換為新工作。

來源讀取使用 canonical regular files、單一 hardlink、no-follow FD，讀前／FD／讀後核對 inode、size、mode、mtime／ctime 與 bytes。保存完整檔名 inventory、存在／缺失的目錄和父目錄身份；再次檢查拒絕換檔、改內容或時間、增刪檔案、目錄替換及原缺失目錄突然出現。未知檔案及子目錄拒絕，不猜測可忽略。全部來源唯讀，不 chmod、建立目錄或清理暫存。

外部 bot 檔案不可 alias 業務 SQLite、owner SQLite 或其 sidecars。POSIX SQLite 鎖是程序級記錄鎖，不能靠額外 FD 讀取再關閉這些 inode；外部檔案讀取器與鎖檢查必須避免釋放已有鎖。

## 持續持鎖的基礎 API

`withRollbackMediaCapture` 讓同一 standalone IMMEDIATE 交易涵蓋媒體擷取、後续投影及落盤，提供 `assertUnchanged`。再次核對完整新庫 checkpoint、journal／applied markers／receipts、媒體 inventory／bytes 及主庫 inode；內部保留獨立 checkpoint／journal，不能以修改捕獲的 Buffer 改寫原基準。callback 返回後也核對，失敗釋放／回滾交易；返回或失敗後 guard 永久失效。原 `captureRollbackMedia` API 保留。

`withRollbackBotExclusion` 使用已存在的 `.bot-owner.sqlite3`，沿用 Python／TS 的 DELETE／BEGIN EXCLUSIVE 協議及同程序 registry。它不建立缺失 owner、不 chmod、不接受 WAL／既有 sidecars、不回收 outbox、不啟動 bot；SQLite 取得鎖時可能建立並於關閉時清理自己的暫存 journal。捕獲過程的 guard 只 stat 主庫／owner，不額外開啟再關閉它們的 FD；核對原 inode、私有模式、owner 大小／時間及交易仍持有。

這些 callback 和落盤來源 guard 必須同步；thenable 拒絕。它們是受控工具的程式契約，不能當作不可信 callback 的執行沙箱，也不能代替停止服務、排程及部署協調。鎖只涵蓋同一主機／目錄且遵守現有 ownership／SQLite 協議的程序，沒有跨主機或繞過協議的投遞排除。

## 私人套件 version 2

新增 `pinRollbackPackageSourceV2` 與 `assembleRollbackPackageV2`。version 2 保留檢查點 110 的全部 state／media／history 與原 pins，另以 `botStateSha256` 固定完整 bot index：來源角色／路徑、真實 capture 時間、目錄存在狀態、完整檔名、size／SHA 和原 mtime。

新增的封存位置為 `private/latest/bot-state-index.json` 與 `private/latest/bot/{logs,abbreviations,configuration}/`。不混入舊可讀投影或公開下載。獨立 verifier 核對外部 pin、canonical／唯一／排序 inventory、來源角色、目錄缺失語意、自訂詞庫有無及全部原 bytes／時間。decoder 重新編碼核對 canonical metadata 及完整 inventory。修改 cursor／uncertain／scope／mtime、遺失檔案或更換來源，即使更新外層 manifest checksum 也無法通過原 bot pin。

version 1 仍可讀寫，沒有假造最新 bot 狀態；其 remaining 明確包含 `latest_external_bot_state`。version 2 也保留 `fixed_bot_external_state_restore` 和 `quiescent_capture_boundary`，不把 private evidence 當成恢復完成。manifest 版本與 source pins 嚴格配對，拒絕把 v2 改為 v1 後留下未分類 bot 檔案，或把新 pins 塞入 v1。

`writeRollbackPackage` 可接收同步來源 guard，分別在保留輸出目錄前、完成全部 IO／fsync 後且 manifest 前、固定 reader 驗證後執行。第一處拒絕不建立輸出；後兩處拒絕沿用檢查點 110 的私人 partial 保全，封存後才失敗也補回 incomplete marker，讀取器拒絕。沒有自動清理或覆寫来源。

唯讀 `verify:rollback` 同時支援 v1／v2，輸出仍僅含 redacted status／數量／digest／remaining，不輸出 bot 原文或來源路徑。外部 pin 必須在真正捕獲時保存；从任意輸入重算 pins 仍不能證明來源、配置或停寫權威。

## 隔離證據與剩餘工作

合成測試把現有 owner 排除、業務 IMMEDIATE 鎖、最新 bot／media、state／history 投影、完整套件 IO 和三次來源 guard 放在同一同步邊界。每次 guard 後用真正 Python SQLite 程序競爭兩個鎖，均拒絕；另以 Python BotOwnership 和 TS entrypoint 競爭 owner，均拒絕。返回後兩個鎖可重新取得，業務／outbox 保持不變。這些測試也重現並防止「額外 FD close 釋放 POSIX 鎖」，不是只看 `inTransaction`。

實際 `AbbreviationDelivery.continuation` 在一次性目錄讀取原 byte cursor／本文，保持 uncertain／created，拒絕不同群與過期 token；實際群授權 reader 保留拒絕。沒有調用 QQ 發送。其餘測試涵蓋原 mtime／mode、暫存 bytes、來源替換與缺失、未知檔案、SQLite alias、錯誤／非同步 callback、改動 checkpoint／journal、v1／v2 round trip、原 bot pins、外層 rehash 竄改、三個落盤 guard 的失敗保全及相同唯讀 CLI。

相關 **174 項／5 檔通過**，Strict TypeScript 通過。紀錄：`/tmp/qgroup-bot-capture-targeted-final.log`、`/tmp/qgroup-bot-capture-typecheck-final.log`。完整單工回歸 **1,496 項／129 檔通過**，紀錄為 `/tmp/qgroup-bot-capture-native-final.log`。

本次完成的是持鎖／最新外部 bot／v2 套件的基礎元件與合成組合，尚未提供完整 native source 建立 CLI、停寫服務檢查與邊界 manifest、實際配置和來源版本核對、部署／retention 排程協調、外部 bot 原時間／狀態恢復，以及固定舊 web／music／bot＋forward restore 演練。舊歷史入口 adapter、歷史看板最新 erasure 重播、browser pending／proof、正式規模與實機 QQ／候選版本組合仍未驗收。全部套件 **`rollbackEligible:false`**；台帳 **166 in_progress／0 完整驗收，release_eligible=false**。沒有部署。
