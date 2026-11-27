# 2026-11-28 活動版面、共用外觀與頁尾發布

發布範圍：`web`（`frontend` + `api`）。正式切換於台北時間 2026-11-28 00:28 完成，入口仍為 https://kanban.danndann.cn。只重新建立 web 容器，bot 保持原映像、容器、設定與啟動時間。

## 已發布內容

- 活動卡片整張可點擊，顯示成團門檻、報名人數、預定起訖及持續時間；跨日顯示「次日」，超過一個日曆日則顯示結束日期。長活動標題在手機分行，操作列留在標題下。
- 四種主題色統一背景、表面、輸入框與浮層；共用分頁採 Yahha UI `default`，短線水平且各音樂頁面的分隔線一致。
- 領域不顯示歌手／企劃等細分類別；保留最新 main 已發布的領域熟悉度編輯、展示、比較與分享。Android QQ／QQ Browser 不再重複加上頂部安全區，底部安全區保留；切頁動畫尊重減少動態設定。
- 使用說明、隱私政策與聯絡頁共用版面，移除章節跳轉控件及重複入口。原有隱私內容、權利與必要提示保留。
- 手機頁尾置中，以 Yahha Link 提供資訊入口、飯糰與 QQ 群連結；署名為「活動看板構思：飯糰、成分查詢構思：紅雨」及「由 飯糰 製作&運營於 霧都日音約K 群」，備案號置於最後。群連結為使用者提供的 https://qm.qq.com/q/fYn352Qdt6。
- 管理員可修改網站名稱。名稱存於既有 `music_documents` 的 `site_appearance` 文件；未改 schema、報名／結算規則、outbox 或 bot 群設定。因此本次需發布 API，後續純前端修改仍可只切換靜態包。

## 來源與版本

發布提交先整合 main，雙推 origin 與 GitHub 並核對 SHA；`origin` 抓取／發布來源仍為 git.dan.tw 對應倉庫。`check_release_source.py` 通過後，從明確提交 archive 到乾淨暫存目錄，在本機建置 amd64 映像與独立前端。正式主機沒有建置、執行全套測試或接收工作目錄檔案。

- 正式來源：`15cac112cbbbeff8b485857d785c018f432f2b1f`，tree `82b5e33c0b446c80bba02795957f5fe9294d4ee3`。
- 發布目錄：`/opt/qgroup-releases/layout-20261128-15cac11`；保存來源封存、檔案摘要、驗收及回退資料。執行工具來源為同一正式提交。
- Compose 路徑及私有環境檔保持原狀，僅 `QGROUP_WEB_IMAGE` 改為下列固定 ID。

| 服務 | 發布前 | 發布後 |
| --- | --- | --- |
| API commit | `ad2d8fca10f1750e849faba2d9499d8e20f7d79c` | `15cac112cbbbeff8b485857d785c018f432f2b1f` |
| API image ID | `sha256:00badfae8a607b148b3c0c396a80a396f42c5041938d8303849489f007d460e3` | `sha256:49a3c4f071d8d648d26d01273100c490fac4f20e35900e2d13900062f2340920` |
| API container | `1ea7dc3eace2853aa94cc0d7f05e17b76f387a599346ac81aa08568d9d05ec2a` | `19aaeeb7eebea993550e11d147d496f44d2334fb8d4e336ac7cc8d5175f6f321` |
| bot commit | `7b0914ffd05b4418b9065932592d9bd5c33a71c7` | 相同 |
| bot image ID | `sha256:2b55e3d15df8035dbe5ed6334723c275f1e52061695c4ebc67edc09b369e8e00` | 相同 |
| bot container | `9d3a349fa048df963eba1a2c8de4ea154bc9c5e28df61ee8a59a4a1bd5147e46` | 相同 |

API 新容器啟動於 `2026-11-27T16:28:22.265211883Z`；bot 啟動時間仍為 `2026-11-25T16:30:45.90367263Z`。兩者均 healthy、restartCount 0。

前端獨立版本：

- 發布前：`000bcbee4a9935442756276e2e008c3bc72d569e`，manifest SHA256 `7582e14b81d25ced5ba3cf096fb13d86f8a1d4373dafc47367439d4c2d4229af`，build ID `9f227c118223c587d4b2aa6a607aa1bfc55adeee691897ce0f8ead418c29ec49`。
- 發布後及相容 API：`15cac112cbbbeff8b485857d785c018f432f2b1f`。
- manifest SHA256：`fcb90e0e4446d0176232917800be9f7ea14798d23de8b366d1e6f5c2c442131f`。
- PWA build ID：`05a7f868beefc614d387b3f652bd32be37c1741ee0fc1d637612db12f62c43c4`。
- 目錄：`/opt/qgroup-frontend/releases/15cac112cbbbeff8b485857d785c018f432f2b1f-fcb90e0e4446d017`。
- 原子切換 `current`，保留舊 hash 資源；沒有清除使用者草稿或強制啟用等待中的 Service Worker。

## 資料、相容性與驗收

- 正式副本擷取於台北時間 2026-11-28 00:00:45，涵蓋 20 個活動、113 筆報名、62 個使用者，以及圖片和刪除紀錄；一致性、外鍵、刪除標記及逐檔摘要核對通過。登入／授權憑證與待送工作已清除，群通知停用，測試身份只作用於本機副本，外部投遞隔離。
- 建置與型別檢查通過；外觀與詞條熟悉度瀏覽器回歸 29 項、網站名稱 API 與活動摘要單元檢查 17 項通過。兩項舊主題測試的已移除入口 selector 已在後續文件分支對齊現有頁尾及詞條按鈕，重新驗證通過；未修改發布執行產物。
- 實際候選映像與前端包使用正式副本驗收 13 項，涵蓋 320–1440px、長標題、活動卡片與鍵盤／中鍵、四主題的明暗與密度、網站名稱併發／重放、跨日與跨年時間、頁尾連結、分頁、領域分類、Android QQ 安全區、資訊頁與切頁草稿。自動測試代理按測試區分客戶端地址，保留原有正式限流；未降低執行產物的限流設定。
- 驗收後活動、報名、使用者、投票、成分、詞條、圖片參照與刪除標記逐列摘要相同，待送工作為零；資料庫完整性及外鍵通過。
- 混合版本使用實際線上 bot 映像 `sha256:2b55e3d15df8035dbe5ed6334723c275f1e52061695c4ebc67edc09b369e8e00` 掛載候選 API 的資料庫產物，原生 HTTP／WebSocket、ACK／Resume、指令／縮寫、公用查詢、通知與不確定／模擬投遞狀態及退出檢查通過；另以候選 API 配合現有 bot 公用回覆核對活動直接發布、重放、一次 outbox、活動期間報名及截止提示。
- 舊 API 與候選 API 的資料庫產物僅差異於未使用的外觀契約區塊；移除由編譯器標記的該區塊後，其餘位元組相同。資料庫套件、schema、outbox 格式與 bot 程式碼未改；未以「整份 bot 產物完全相同」代替實際混合版本驗證。
- 正式 schema 前後均為 rebuild 15／legacy 20，沒有資料遷移。正式資料庫沿用原路径，沒有匯入或覆蓋測試副本。
- 上線後唯讀 HTTP 驗證 12 個主要／深連結入口及 86 個 hash 資源通過，逐檔 SHA256、immutable／no-store、前端 build ID 與 API SHA 一致；活動統計 11 場／78 人次／36 位參與者，詞條 156 個。兩容器健康、bot 身份與啟動時間不變，備份 timer active。
- 本次沒有再次發送真實 QQ 驗收訊息，也沒有申請加群；模擬平台檢查沒有記為真實 QQ 投遞。

## 備份與回退

切換前保存完整成套備份成功憑據 `/var/backups/qgroup-unified/kanban-20261127-162815-457772.complete.json`（SHA256 `78038f943dda070403a586198b8482b175389eb7a82055aae7bf1c387c26a541`）；切換後再執行備份成功，timer 保持 active。此前 API 映像已保存到發布目錄，原環境檔、runtime manifest、前端 receipt 與 `current` 指標亦完整保存。

回退版本組合為上述舊 API image ID ＋前端 `000bcbee4a9935442756276e2e008c3bc72d569e` ＋現有 bot。此組合的資料庫語意相容，沒有 schema 遷移；網站名稱文件可由舊 API 忽略。兩個前端的 API 指紋不同，不能宣稱可以將舊前端單獨切回新版 API。必要時只停 web，恢复原 API 引用和已保存前端指標，重建 web、核對版本／健康與 bot 不變，更新 runtime manifest。**不覆蓋業務資料庫、WAL 或刪除權威**，保留發布後寫入。
