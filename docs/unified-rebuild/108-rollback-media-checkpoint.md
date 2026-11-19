# 第一百零二批實作：同一快照的收款圖片與壁紙回退

日期：2026-11-19（Asia/Taipei）。分支 `codex/unified-rebuild`。變更範圍 **`both`**：看板歷史圖片、最新外觀設定、完整來源快照及 bot 相容回退包有跨服務依賴；實際發布 **`none`**。只使用合成來源、私人記憶體與隔離暫存檔，沒有 main 整合、正式資料或服務操作。

## 資料庫與外部圖片一起捕獲

新增 `rollback-media.ts`，限定 canonical file-backed schema 15 與 standalone `BEGIN IMMEDIATE`。同一個真實 writer lock 內驗證最新 journal／applied markers／receipts，捕獲完整新庫 bytes，再讀取外部 `images/` 與原 `walls/` 檔案。收款圖片逐一核對 content-addressed 名稱／SHA-256、原 size／MIME 與全部 image_assets 列；任何引用圖遺失、bytes 不符、連結、特殊檔案、不明路徑、捕獲後 inventory／bytes 改變或資料庫檔案被替換，都拒絕。

原檔案 bytes 全部保留在 `originalFiles` 私人資料，不刪除或修改來源。沒有目前 image_assets metadata 的圖片分開列為 orphan，不能放進舊看板的有效圖片集；原壁紙目錄只是私人來源證據，不能用它覆蓋目前資料庫 BLOB。原目錄不存在時可以明確捕獲空原檔案集；不能因此省略資料庫中實際存在的圖片引用。

目前 source／原檔案捕獲都是私人記憶體元件，不提供服務啟用、保留排程、公共下載或完整落盤包。每個外部檔案的讀取上限沿用 512 MiB；沒有把這個上限或 writer lock 當成正式規模下的資源保障，完整記憶體／執行時間量測仍待完成。

## 最新壁紙向舊格式投影

依最新 wallpaper_items／assets／config 產生原 `/walls/<file>` 路徑、manifest、原 BLOB bytes，以及 ID／source／digest／原 position／missing 可逆映射。保留最新名稱、排序、參與輪換、輪換秒數及 PNG／JPEG／WebP；新增壁紙即使沒有外部檔案，也從資料庫 BLOB 重建原網址。現有格式、MIME 與舊副檔名不能一致表達時拒絕，不偷偷轉碼或改 bytes。

原本 digest=NULL 的遺失項仍是遺失項；來源目錄即使留下同名舊檔也不補回。已刪除的壁紙不從殘留檔案復活。未變的已知 manifest 欄位保留原表示，例如字串秒數、缺省 name／enabled、原空白／換行與欄位順序；有最新設定時只投影目前有效值。

原 manifest 中固定舊壁紙程式未讀取的額外欄位，及不適合公開的非 boolean enabled／非法 rotateSeconds 表示，按原 JSON 路徑記為 archivedFields；完整值留在私人來源 checkpoint，不能進入有效的公開 manifest。不復活舊管理憑證，也不把原目錄 manifest 當成目前設定。

## 同一快照的跨領域組裝與獨立對帳

`rollback-state.ts` 新增 `projectRollbackStateFromCheckpoint`，驗證完整 schema／integrity／journal／receipts 後，從媒體捕獲的同一 bytes 組裝看板、成分、身份及刪除紀錄，不再捕獲較晚的即時資料庫或 journal。輸入先 clone，不改傳入快照；呼叫者必須保留原捕獲來源或外部 pin，不能從任意 bytes 猜正式來源。原 `projectRollbackState` 沿用此組裝器。

新增 `rollback-media-reconciliation.ts`，由獨立提供的固定完整來源、已驗證 intents 和原檔案 bytes 重新核對。驗證者不讀來源檔案、不呼叫媒體 projector、不信任 report，核對完整 checkpoint、原檔案完整集合／SHA、看板圖集、壁紙有效欄位／原表示、BLOB／MIME／舊路徑／映射、missing 及 inactive original files。刪圖、改 bytes／name／order／enabled／秒數型別／mapping、加入未知 manifest 欄位、丟原檔案或改 checkpoint／journal 均拒絕。

結果始終 **`rollbackEligible:false`**、`sourcePolicy:private_original_files_latest_active_projection`。當下媒體與資料的一致捕獲已具隔離證據；歷史來源、private 落盤／fsync／manifest、完整回退與重新向前恢復、browser pending／失效 proof，以及固定舊 web／music／bot 實際候選組合仍未完成。

## 驗證與限制

最終相關 **65 項／2 檔通過**，Strict TypeScript 通過；完整單工回歸 **1,306 項／125 檔通過**。紀錄：`/tmp/qgroup-rollback-media-targeted-final.log`、`/tmp/qgroup-rollback-media-typecheck-final.log`、`/tmp/qgroup-rollback-media-native.log`。

測試以真正的第二個 Python SQLite writer 驗證捕獲時鎖仍存在，捕獲後能取得寫入鎖；捕獲途中新增檔案／替換資料庫時拒絕，保留檔案供核對，來源資料庫不被改寫。媒體捕獲之後即時資料有新寫入，後續回退組裝仍用同一 checkpoint digest。帳號關閉移除私人碼及不再被引用的外部圖，但其他人共享的 immutable 結算／BLOB 與歷史引用按原規則保留。

實際匯入原 `qgroup_core.media`／storage，只在隔離生成的舊看板庫及有效圖集讀取兩個結算版本的 file／inline BLOB 圖，再逐列／rowid／storage／sequence 對帳。另從固定 `music_site/upstream.py` 原 AST 提取 `load_walls`／`save_walls`／`walls_payload` 三個函式，不初始化原服務；在隔離壁紙檔案讀取原名稱／秒數／enabled／missing，再修改 manifest，來源仍保留。這些是原元件讀寫演練，**不是完整舊 HTTP／bot／候選映像驗收**。

**166 IDs／166 in_progress／0 完整驗收，release_eligible=false**。本輪沒有修改 TSX、API／worker runtime、schema 或 bot 指令／投遞，沒有建置候選映像或瀏覽器／QQ 驗收。不部署。
