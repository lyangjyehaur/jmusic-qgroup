# 第四十二批實作：配對備份與成分匯出

日期：2026-11-17（Asia/Taipei）。分支 `codex/unified-rebuild`。發布範圍 **`none`**：本批只在本機隔離實作與驗收，未整合 main、未部署。維持 schema 13、93 張資料表及原 Python bot。配對備份涉及身份、圖片、刪除與 bot 待送狀態，跨服務影響仍按 `both` 評估；本批不是已驗證的正式恢復或切換方案。

## 管理入口與下載

`/admin/backups` 合併目前成分匯出及歷史清單，從管理後台直接進入，帳號管理員不需要先建立成分，也支援獨立救援登入。下載前提示 JSON 含私人留言、聯絡號與成分口令雜湊，要求確認保管；不增加宣傳、裝飾或重複介紹。360px 可使用，下載內容不進入 query cache、localStorage 或 sessionStorage。

- `GET /api/v2/admin/backups`：原生配對備份的名稱、時間、總位元組與 schema。記憶體庫回傳未啟用持久備份；備份目錄無法核對則顯示錯誤，不能假報空清單。
- `GET /api/v2/admin/music-export[?backup=<原生備份 ID>]`：目前或歷史成分 JSON。重新檢查管理權限與帳號 scope，strict query，名稱不得包含路徑；回傳 attachment、JSON、`no-store`、`Vary: Cookie` 及 `nosniff`，限制每分鐘 12 次。

下載反映目前權威表的詞條、分類、別名、建立者、時間、建立清單、選取順序與程度、成分稱呼、性別可見性、私人留言、找搭子及其歷史、原趨勢與新抽樣。保留舊成分 key，新成分用穩定 profile ID。新舊 createdBy 對應相同成分 key；刪除建立者資訊後不復活。設定不直接倒出 `music_documents`，不包含其保留的停用舊管理口令雜湊、登入 session 或救援憑證。

歷史下載先驗證配對檔，再載入記憶體副本，重播最新成分／帳號刪除與管理 DELETE／RESET。最新已刪成分及 legacy erasure key 另作投影過濾；最新關聯、明確清空的聯絡號與找回 PIN 狀態覆蓋歷史值，其餘成分資料維持歷史內容。帳號關閉保留應保留的成分，解除帳號綁定；RESET 清空其範圍的成分／詞庫及全部找搭子／趨勢。已套用標記避免再次清掉 RESET 後的新資料。下載不改原備份、現行資料或原圖，也不啟動舊管理入口。

獨立 ledger、`erasure_applied` 與新式刪除回執必須相符；缺失、截斷、衝突及未完成重播均停止匯出／新備份。歷史備份內的 ledger 必須完整包含於最新 ledger，不能用舊 ledger 取代新的刪除紀錄。故障時沒有未清理 JSON 的降級下載。

瀏覽器接收檔案後再次核對管理授權；切換帳號、撤權、scope 變更或離頁時，不建立下載連結。失敗保留重試操作，私有 Blob 只短暫存在記憶體，下載後／卸載時撤銷 object URL 並取消未完成請求。

## 原生配對備份

檔案庫同層的 `paired-backups/<UTC 時間>-<隨機 ID>/` 包含：

- `state.sqlite3`：全部原表、新表、身份、帳務、圖片引用、壁紙原圖 BLOB、追加歷史及 bot 工作狀態。
- `state.erasures.jsonl`：同一快照的刪除意圖副本。現行獨立 ledger 保持在備份目錄外，不隨輪替刪除。
- `images/<前兩碼>/<digest>.png`：`image_assets` 所列的全部外部原圖。原表內 BLOB 仍包含在 SQLite。
- `manifest.json`：格式版本、schema、唯一 ID、實際建立時間、持久 sequence、每檔 size／SHA-256，以及明確的 `restoreEligible=false`。

在 SQLite immediate writer transaction 下同步完成；即使呼叫者先開 deferred transaction，也先取得真正 writer lock，避免圖片寫入／清除或刪除意圖與資料庫快照交錯。使用 SQLite serialize 取得包含已提交 WAL 頁的完整 DB image，不複製活動中的主庫或 WAL 檔；僅對這份獨立副本設定 rollback header，使它能由 SQLite deserialize 正確讀取。原庫與 journal mode 不改。

以 0700 暫存目錄、0600 檔案逐檔寫入並 fsync，資料夾同步後 rename 發布，再同步父目錄。原圖核對 digest／size；讀取禁止 symlink 與非一般檔，manifest 限 4 MiB，核對檔名、重複路徑與圖片 prefix。讀取快照驗全部檔案 checksum、SQLite integrity／FK、ledger 與 image_assets 的完整配對；manifest 遺漏圖片也拒絕。失敗清掉本次暫存，不發布半套備份。

啟動時若一小時內無新備份就建立，之後每小時檢查，關閉 API 時清理排程。管理角色／備註、註冊設定、成分關聯／PIN／刪除／RESET、詞庫、找搭子移除及壁紙寫入，在原操作回執判定之後、實際寫入之前完成備份；圖片解碼完成且再次核權後才建立快照。備份失敗回應 503，原操作尚未執行。搜尋、預覽、查回執及登出不要求新備份；已完成的原操作重試可直接取回回執，不因新備份故障而失去查詢能力。

保留最近 30 份、最多 14 天，同秒不覆蓋。持久 sequence 控制建立順序與跨程序重啟的相同時間排序，避免用隨機 UUID 排保留次序。輪替只刪可驗證的原生備份目錄，拒絕 symlink／未分類內容，保留其他維運檔案。原有 Python 兩站的 `music/paired-backups/YYYYMMDD-HHMMSS` 尚未納入此原生清單。

## 隔離驗證

- 本批 15 項 API／配對備份測試：目前投影、歷史最新身份／聯絡／PIN、刪除／RESET／帳號關閉、RESET 後新資料、WAL 與外部圖片／壁紙 BLOB、完整 bot 表／實際 Python bot 讀取（含非空 pending、模擬、sending／不確定投遞、sent、failed／retry 及 skipped，連同 claim、凍結 payload、回執原值保留）、私有權限、缺圖阻止寫入、原操作回執與登出、解碼期間的並行變更、真正 writer lock、啟動／每小時／停止排程、同時刻及重啟排序、保留期、安全路徑、checksum／manifest 遺漏、原件不變及 ledger 遺失／待重播／回執衝突。
- 本批 5 個瀏覽器流程已通過：目前／歷史附件下載、私人確認、360px、無瀏覽器持久副本、聯絡號清空投影、故障重試、收到檔案後切帳／撤權、離頁取消、救援管理及未啟用持久庫提示。首輪有兩項失敗：聯絡用例未建立已關聯合成成分，及 ACCOUNT_CHANGED 後畫面未刷新；補合成資料／正確契約、修正 session invalidation 後 5 項全部重驗通過。
- 既有 Python bot 311 項及時間投票 bot 15 項已通過。所有資料及平台呼叫均為隔離／模擬，不使用正式憑證或真實群聊。
- 已建置 API 的 smoke 實際執行原生 SQLite／sharp、原圖 round trip、管理寫入前備份、目前與歷史 JSON；包含正常啟動時的趨勢抽樣。strict TypeScript、既有 UI 產物檢查與新增下載頁建置已通過。
- 完整後端回歸 69 個檔案、534 項通過；最後補入非空 bot 工作狀態後，本批 15 項再次通過。完整瀏覽器 329 項通過；最後補上 ledger 一致性核對後，本批 5 項再驗通過。360px 下載頁截圖已實際檢視，提示、確認、下載及歷史清單可讀，無水平溢出。
- strict TypeScript、重構建置、既有 UI 產物、capability ledger、diff check、已 bundle API smoke 均通過；production dependency audit 為 0 vulnerabilities。166 項能力 ID 保留、0 項完整驗收。前端 1,097.25 kB（gzip 319.46 kB）、CSS 121.08 kB、API 約 661.4 kB；大 bundle 提示仍存在，效能驗收未完成。

## 待完成與切換限制

A14／O12／O13 保持 **in_progress**，166 項能力仍保留，`release_eligible=false`。本批具備新快照及清理後的歷史 JSON 下載，尚無完整離線恢復 CLI，也不能將 JSON 當成完整恢復包。`restoreEligible=false` 為目前狀態，不是已實作的自動發布／恢復閘門。

後續須匯入兩站舊歷史配對備份；完成只寫新隔離目錄、最新 ledger 保全／重播、圖片配對、身份與舊入口處理的恢復工具及回退匯出。恢復仍須核對備份後的最新 bot `sent`／`simulated`／`sending`／`unconfirmed`／retry 等工作與消息紀錄，避免重播或雙投遞；本批只證明快照保留狀態，不證明歷史工作可直接再次上線。

備份目前同步序列化整庫、複製原圖並持有 writer lock。正式資料量的記憶體、磁碟、寫入等待及保留上限、跨服務維護鎖與持久卷演練尚未完成，不能據本機合成庫宣稱正式效能可接受。舊下載 adapters、音樂分房、完整 TypeScript worker、PWA／草稿切換、全部功能與實際運行版本組合驗收也仍待完成；未部署。
