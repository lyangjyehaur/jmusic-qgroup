# 第九十五批實作：舊歷史備份管理下載

日期：2026-11-19（Asia/Taipei）。分支 `codex/unified-rebuild`。變更範圍 **`web`**：管理 API／React 下載頁及離線來源驗證，不改 schema、outbox、群設定、bot 指令或投遞。整體重構切換仍按 **`both`** 評估；實際發布 **`none`**。沒有合入 main、操作正式資料／憑證／群設定或真實 QQ。

## 歷史來源與下載

原生配對備份、舊成分站 `paired-backups/<YYYYMMDD-HHMMSS>` 及 `backups/data-<YYYYMMDD-HHMMSS>.json` 現在共用 `/admin/backups`、`GET /api/v2/admin/backups` 與 `GET /api/v2/admin/music-export?backup=…`。舊兩種格式使用 `legacy-pair-<stamp>`／`legacy-json-<stamp>`，避免同時間原稿或原生 UUID 名稱碰撞。舊檔名沒有時區證據，`createdAt`／`schema` 保留 `null`，畫面顯示 `sourceStamp`，不推導成 UTC 日期或當前 schema。

候選 web 可明確設定兩個私人環境欄位，缺少其中一個會拒絕設定：

- `REBUILD_LEGACY_HISTORY_ROOT`：檢查點 100 產出的完整 capture 根目錄，必須為絕對正規路徑、非 symlink。未來由維運以 readonly 私人 mount 提供，不放入公開 static root。
- `REBUILD_LEGACY_HISTORY_MANIFEST_SHA256`：從可信擷取紀錄核對的 `capture-manifest.json` SHA-256；不是移動中的檔名或自動接受重新計算的值。

未設定時沿用原生備份；沒有移動原稿、匯入歷史身份或改動運行資料。此處是實作介面，**尚未配置正式服務或修改部署 mount**。

每次列清單／下載驗證 manifest 固定雜湊、檔案清單 fingerprint、重複及不安全路徑，將 capture 的 `current/` 檔案轉成匯入器原 fingerprint，要求與資料庫已提交的 `migration_runs.manifest_json` 完全一致。不能拿另一份捕獲或較舊來源給目前候選庫。這是來源關聯與 checksum，不是 manifest 數位簽章或正式來源 commit 驗收。

下載驗證兩個當前來源 ledger、原歷史目錄清單、逐檔 size／SHA-256、必需的 JSON／身份配對，以及壁紙 manifest 的引用；缺檔、新增未分類原稿、symlink／特殊檔、壞 UTF-8／重複 JSON key／不安全數字／未分類欄位均拒絕。歷史身份 SQLite 只讀取 Buffer 中的獨立副本，檢查 integrity／foreign keys 與既有身份結構，不開啟原 DB，不載入其 session、OAuth 或管理身份。完成下載前再驗來源檔案與固定 manifest。

## 最新隱私與原稿保全

沿用當前管理員／帳號 scope、下載限流與 `no-store`，在 SQLite writer lock 內驗證最新 unified erasure journal 與 applied markers／receipts，持鎖到完成 JSON 投影，避免下載過程中的另一個合法刪除交易改變來源。捕獲時的帳號刪除意圖必須仍存在於最新 ledger；缺失或變更不下載。

舊下載保留原歷史稱呼、私人留言、選擇原型與重複／順序、建立詞條、喊話及趨勢，不用目前欄位覆寫歷史內容。最新刪除鍵、profile ID、`music`／`both` 及管理刪除／reset 優先，詞條作者的舊鍵與轉換後 profile ID 一起移除引用。帳號單獨關閉只解除 ownership，保留成分。

只採目前有效 profile 的 ownership／PIN／聯絡號，包括明確空值；歷史獨有、沒有目前身份資料的成分保持未關聯與空 PIN／聯絡投影，不把歷史憑證重新啟用。原 JSON、身份 DB、壁紙及捕獲 manifest 不被修改；settings 中的舊管理 hash 不進下載。

舊 JSON 沒有 unified applied markers，不能按檔名、mtime、稱呼或時間猜 reset 是否完成。按捕獲的 profile／entry IDs 套用刪除，reset 另清歷史喊話／趨勢。原生配對備份仍使用自身 markers，已套 reset 後的新資料不會再次被清空；兩種來源的不同證據邊界保留。下載不改 live DB、不執行 bot 工作、不輪替舊歷史；原生 30 份／14 天輪替仍只處理原生資料。

React 保留私人資料確認、重查管理 authority、撤權／切帳號與離頁取消、防止收到的晚回應釋出下載、URL 回收及不寫 browser storage。來源標籤與未確認時區提示幫助辨識同時間的兩份原稿；沒有增加展示文案。

## 驗證及未完成範圍

合成目前資料先經實際匯入器，再連接來源清單；檢查點 100 的真實捕獲產物也接續匯入並由新 provider 下載，該測試的服務 evidence／music lock 仍是注入 fixture，不當成正式 Linux 全流程。

新隔離測試涵蓋兩格式、最新 ownership／PIN／明確清空、歷史獨有成分、原稿 bytes 不變、不匯入認證或重播 bot、`music`／`both`／`account`／舊 account ledger／管理刪除及 reset、profile-ID 作者、捕獲 erasure 不遺失、來源錯配、損壞／未分類／symlink／缺檔與權限拒絕。

完整單工 **1,111 項／118 檔通過**（其後新增捕獲 erasure 來源與競爭寫入兩項測試，並修正合成可編輯聯絡 fixture）。最終相關三檔 **77 項通過**；Strict TypeScript、production React／API／bot 建置及 compiled API／bot smoke 通過。Smoke 包含 mock HTTP／WebSocket／ACK／Resume／不確定投遞／模擬／CLI／SIGTERM，SQLite／sharp、原生備份／恢復啟動阻擋；其中尚未對完整候選映像做歷史 mount 驗收。

相關瀏覽器 **7 項通過**，涵蓋原生與兩種舊下載、360px／1280px、鍵盤確認、明確聯絡清空、失敗重試、救援身份、撤權／切帳號／離頁及不保留私人 JSON。後續重新載入桌面 viewport 的兩項亦通過，截圖已檢視。數字 QQ 原成分查詢標識不能自行清空的既有規則有保留，瀏覽器聯絡清空使用原生成分；最初該 fixture 被 409 拒絕並非功能退化。

記錄：`/tmp/qgroup-legacy-history-native.log`、`/tmp/qgroup-legacy-history-targeted-complete.log`、`/tmp/qgroup-legacy-history-typecheck-final.log`、`/tmp/qgroup-legacy-history-build-verified.log`、`/tmp/qgroup-legacy-history-smoke-verified.log`、`/tmp/qgroup-legacy-history-browser-final.log`、`/tmp/qgroup-legacy-history-browser-layout.log`。截圖位於 `test-results/unified-legacy-backups-{mobile,desktop}.png`（合成資料，未追蹤入 Git）。主 JS **1,482.80 kB／gzip 433.13 kB**，效能拆包仍未完成。

**166 IDs／166 in_progress／0 完整驗收，release_eligible=false**。這不是完整系統恢復包：看板歷史 DB／tar 的內容對帳、歷史完整恢復、舊 `/music/api/export`／`admin/backup` URL adapters、正式歷史來源與規模／時間量測、readonly mount 及候選 image 驗收仍待完成。接續做新寫入回退匯出、部署控制與實際停寫擷取演練、B01–B15／實際 web＋bot 組合、效能與實機／QQ 平台驗收。依使用者要求不部署。
