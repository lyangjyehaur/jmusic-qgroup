# 活動讀取的固定操作與整合回歸

日期：2026-11-21。候選變更範圍：`web`。未部署、未整合 main；保留 Python bot。

活動列表／我的活動、活動詳情、名冊與報名者成分彈窗、活動歷史、包間概覽／歷史／原版本四檔，移除八處過渡 path 呼叫，直接使用九個固定操作鍵。公開列表不帶 account scope；其餘讀取保持原 scope、cache keys、enabled 條件、游標省略語意與刷新動作。原 attendee ID 直接傳入固定 attendeeId params，歷史版本由原數字轉為字串再編碼；不改動頁面連結、身份、使用者內容或新增文案。

第一份 strict 檢查攔下錯誤的 `:personId` 操作名稱；依實際契約修正為 `:attendeeId`，保留原失敗 log，修正後 strict 通過。AST 對照第 180 號確認八處移除；全站直接使用 131 個不同固定操作鍵，仍有 69 處過渡 path 呼叫。所有呼叫方、permission／response 綁定及真正 OpenAPI 尚未完成。

## 驗證

- 六檔／111 案相關 unit 全部通過，逐項符合固定 inventory：活動名冊與成分可見性、歷史、包間原版本，以及共用 HTTP。沒有為本輪呼叫搬移新增鏡像測試。
- strict、隔離網頁建置與靜態驗證通過：82 個靜態資源、142 個壓縮表示、277 次 HTTP 檢查；85 個 precache 共 1,757,354 bytes，最大原子批次 621,625 bytes。逐項核對原 bytes、hash、sidecars、MIME、HEAD、conditional 與 precache。
- 因最終分包清單與批次 bytes 改變，除活動與跨領域相關 52 案外，加入原三個 precache 安裝／持有最後批次／失敗恢復案例。八檔／55 案全部一次通過，原 IDs／標題／位置已核對，無 retries／skips；瀏覽器 cache attachment 的 85 個原資源 hashes、keys 與 bytes 等於本輪最終 build。
- API 的 178 個編譯來源、兩個 API 及三個 bot runtime 產物逐項等於第 180 號。schema、outbox、bot 設定及入口未變，沒有 fresh 第 181 號 Python run、正式在線版本組合或真實 QQ 驗收。

第 179 號最終 16 檔／167 案及第 180 號八檔／82 案 browser 已完成，全部一次通過，固定 inventory 已核對。覆蓋成分／聯絡 QQ／同好／claim／找搭子／隱私及全部六個共用草稿 send 呼叫方；遺失回應、原 UUID／本文重試、跨關閉分頁、舊紀錄保全、結算／包間／投票等原動線通過。第 178 號 282 案成功與原 precache／Umami 證據保持有效。

第 178–181 號相關 unit 去重為 32 檔／386 案，browser 去重為 54 檔／552 案，全部在各自的最終產物通過；跨 checkpoint 的合計不能寫成單一完整候選 run。第 178–180 號乾淨來源封存的 1,423／1,424／1,425 個 Git blobs 與 tree 已逐項核對；第 180 號及其祖先已雙邊同步並核對完整 SHA。

## 原 CI 與 bot 證據

第 177 號 image 原 artifact 的版本、inspect、Compose、manifest 與 bot 配對已完成獨立核對，原 run `44866830040` 的 unit 失敗仍保留。第 178 號 image 原 artifact `14694795454` 的 ZIP digest／CRC／13 個解包檔案 hashes 已核對；重新生成的固定 Python manifest、bot harness 與原 artifact 一致。核對 55 個原 Python blobs、71 次 original worker、九次 native consumer、314 個深連結及原模式／回呼／恢復／交接計數；network denied、使用合成資料，不能代表實際在線版本組合或 B01–B15 全部接受。

第 178 號原 CI `44871389869` 與第 180 號原 CI `44872622986` 的 image job 成功，unit／browser 原 jobs 最近仍在執行。保留原 run、handles 與結果，未取消或重跑；原第 176／177 號 run 均保持 failure，不因修正通過而重寫原結果。

證據保存在本機 `activity-read-http-adoption-181/` 及第 178–180 號各自目錄。166 capabilities 仍為 0 fully accepted，`releaseEligible=false`。完整前後端及 B01–B15 bot 保全目標不變；剩餘 69 處固定呼叫、完整 permission／response 綁定、真正 OpenAPI、來源／reset、media／browser、候選版本組合與切換演練繼續進行。
