# 原始重設範圍與空會員 authority 檢查點

日期：2026-11-20。變更影響按 **`both`** 評估，涉及成分刪除、共用資料恢復與新版網站啟動檢查；本次發布範圍 **`none`**。只在隔離合成資料上實作與驗證，沒有部署、合入 main、操作正式 bot、憑證、群設定或真實待送工作。

## 原操作缺口

原 `music_site.administration.erase(reset=True)` 清除 entries、members、shouts、shoutHistory、trend，但只為當下 members 寫 `{qq,erased_at}`。沒有會員時，不會增加任何 authority record；即使仍有詞條、孤兒喊話或趨勢，三份 ledger 的 bytes／SHA 均不變。舊 ledger 本身無法分辨單筆刪除與全部重設，也不足以恢復重設範圍。

本次保留原管理 Handler、proxy／admin／Origin 權限與確認文字，沒有建立新的管理命令或捏造 native 使用者 intent／receipt。只有明確安裝的隔離 old-service overlay 包裝原 `erase`，在原非可重入 upstream 鎖與 authority 排除期間，記錄後再呼叫原操作。

## 結構化 authority record

Manifest／head 保持 v1；既有 ordinary records 保持 v1 的 canonical bytes、非空 suffix 與三 domain 語意。新增 **v2 music-only** record，帶 `legacy_music_reset` operation：原 `data.json` bytes 的 size／SHA、當下 loaded data 的 SHA、原操作時間的 JSON 字串，以及五個容器的 persisted `scope` 與 `loadedScope`。

原操作先以 loaded members 寫 identity 刪除，接著讀 persisted JSON 並清空其容器；兩份範圍不能互相推導。`scope` 精確記錄原檔容器，`loadedScope` 精確記錄記憶體容器。entries／members 使用原 map key 與每筆 payload SHA；shouts／shoutHistory／trend 使用完整原列表的位置與每筆 SHA，包含孤兒、無 ID 和未知欄位。每筆 digest 的編碼是 Python UTF-8 JSON（ensure_ascii=false、緊湊 separators）及結尾換行；loaded digest 使用同一編碼。source digest 另綁定完整原檔 bytes，兩者不能混用。authority 不複製成分、喊話、趨勢內容或管理密碼。

同次重設 loaded members 的原順序及同一時間仍寫入原 music ledger suffix。TS／Python reader 都要求其 key／時間與 `loadedScope` 一致；只有 v2 reset 可用空 suffix。空會員重設仍推進 record sequence／chain／head，ledger bytes 可完全不變。兩種 reader 都檢查嚴格欄位、型別、digest、唯一 map keys、連續 list positions、canonical metadata／base64、chain 與 head；拒絕 unknown version、domain 或 operation。TS snapshot 也保護新增 records 的記憶體 view。

publication 沿用 record fsync → head → source ledger fsync。原 data 在 authority 記錄前後都再次核對 bytes／檔案身份及 loaded scope；晚變更保留已記錄 intent 並拒絕執行清除，不把失敗當成完成。讀取新 source 前使用既有 lstat-only SQLite inode 保護。

## 啟動、重播與匯出邊界

新版 retained journal 現在檢查 **old-domain records 是否存在**，並維持原 ledger size／SHA 檢查。因此空 suffix reset 同樣阻擋 native startup。現有 erasure-only forward projector 明確拒絕 v2 reset，不能只投影 qq suffix 後宣稱完整恢復。

在執行成功的同一原 service 程序，overlay 只認得自己實際完成的 reset record pins。原後續寫入和再次重設仍可執行；普通 replay 不重新清空 entries／shouts／trend。新程序、未知 reset 或未完成的 reset，停止原 music business replay。低階 `authority.recover('music')` 只恢復 ledger bytes，不表示已恢復 structured reset 業務。

有 structured reset 時，`authority.guard('music')` 拒絕舊 current／historical 匯出和 namespace catalog 下載；authority-aware 離線維護同樣拒絕業務 replay。這是尚未完成資料世代核對時的阻擋，**不是完整重設恢復已實作**。正式操作不得安裝此未完成 overlay；原 Python bot與正式舊服務沒有被更改或重啟。

不能依檔案 mtime、單獨 applied marker、ID 或 payload digest，分辨舊備份回復與後來使用同 ID 的真實新增／修改；也不能每次恢復都再次清空全站。本次提供原 operation evidence，後續仍須驗證來源 epoch／before-after ancestry、全部 write／restore 路徑、native-only／post-reset business 保全，以及歷史下載的最新重設過濾，才能解除上述 gate。

## 驗證與保全

開發第一輪 31／33 通過；兩項 forward gate fixture 用了帶 WAL 標記的 `db.serialize()`，尚未到 gate 就被 standalone-source 檢查拒絕。改用實際封存的 checkpoint image 後，第二輪 33／33 通過。另四項鎖／來源晚變更／v1 空 suffix 的選取回歸通過，該開發選取含 33 skipped，沒有當成完整測試通過。首次固定來源已跑完新 38 案與 source-rebase 46 案；檢視原 erase 的重新載入行為後，停止該回歸編排，保留原 plan、結果及部分批次輸出，不沿用為新來源的完整證據。新增 persisted-only／loaded-only 分流與完整新來源回歸，另立 source plan。

第四輪開發全檔 **40／40** 通過，含兩份不同原 scope。最終重新固定來源回歸 **68 檔、1,448 項全部通過**，9 批各一個 worker，零 failed／pending／todo／skipped。獨立 verifier 核對每筆 assertion、完整檔案清單及 1,004 份來源不變；沒有沿用被中止 epoch 的結果。strict／完整 build／隔離 build smoke 全部通過，建置後來源 SHA 再次相同。

私人證據：`/Users/danersaka/.codex/rebuild-verification/legacy-reset-126-08916319fcc74d669f07601d55e21b5b/`。最終 source plan SHA256 `9d54dd382e41f49b131088012f019a66f19f17ab81b95ab18180875011188d4d`，1,004 份非文件來源、143 份完整測試 inventory，選取 68 檔／9 批，每批一個 worker。最終 plan／results／summary／build／smoke／runtime comparison 位於其中 `final-source-scopes/`。包括原 authority／native retained journal、全部 rollback／forward、database migration、相關 privacy／auth 及全部 13 檔 TS bot。本輪不宣稱重跑全部 143 檔。

實際舊 Python Handler 的真 loopback HTTP 檢查 admin／proxy／confirmation、完整及空會員兩次 reset、原 settings 保留、重設後原 API 建詞條與 replay 保留、匯出 503 及 uninstall。獨立 Python hashlib／JSON oracle 分別從原 source／loaded data 計算兩組 scope，不使用 capture helper 的結果推導預期。persisted-only／loaded-only 成分、詞條、喊話與趨勢另驗原 JSON 清除及 contact identity 刪除範圍，不捏造額外 identity erasure。四個真 Python exit 中斷點保全空會員 scope，重啟不默認完成。來源晚變更、SQLite live alias／鎖仍有效、offline replay 停止及兩種 reader 負向案例亦納入。

所有 native source／原套件及 pending、sending、sent、failed、skipped bot 工作均保全；沒有啟動 worker 或真 QQ。沒有 schema 或 bot runtime 邏輯修改；12 個 API／bot bundles 與第 125 號建置 bytes 比較：**全部 9 個 bot bundles**、database 與分房 worker 完全相同；只有 API `start.mjs` 隨原 authority protocol／startup gate 更新。build smoke 驗證合成 native HTTP／WebSocket、ACK／Resume、outbox／不確定與模擬狀態、CLI 互斥與 SIGTERM，以及 SPA／API／圖片／備份與 recovery block。macOS 的原 authority factory 案例使用明確 Python flock helper；實際 Linux 預設 flock 啟動及固定版本組合仍待驗收，不能用此本機結果代替。

## 後續門檻

合併後最新 authority／closed-account 舊 footprint／跨域 request receipt、structured reset 的完整資料世代與修復、私人原映像的 latest-erasure／reset 過濾、再次 source epoch 的 ancestry、媒體／browser pending 與 proof、真正停寫 capture、外部 custody／高水位／audited activation、Linux 固定實際 web＋Python／TS bot 組合，以及全前後台／B01–B15／實機 QQ／資源驗收仍須完成。

166 能力維持 in_progress，release_eligible=false。繼續原完整目標；先不部署。
