# 前端固定操作呼叫完成與恢復驗證

日期：2026-11-21。候選變更範圍：`web`。實際部署：`none`；未整合 main，保留 Python bot。

活動草稿／安排、帳本、建立識別查詢、舊稿與舊款項恢復、分房試算、收款碼及結算原圖 11 檔，移除最後 35 處過渡 `api(path)` 呼叫。AST 對照第 182 號確認剩餘呼叫為 0，前端目前使用 184 個不同固定操作鍵。這只完成呼叫方遷移；完整 permission／response 綁定與真正 OpenAPI 尚未完成。

活動建立、草稿保存、安排保存、發布與移除分別沿用各自原本文與 UUID；原結果查詢仍區分草稿與管理回執，後續版本讀取與目的草稿保全流程維持原有順序。帳本分頁保留 entries／reports 的獨立游標；預覽不新增操作編號。收款碼建立與封存分別使用原 pending 內容；歷史原圖版本與原活動 ID 交由固定契約編碼。

舊稿、款項與原請求恢復查詢保留原內容、原編號、重新驗證身份、世代核對與明確確認，不新增自動重送。分房來源與試算維持原 eventId 省略語意、取消訊號與 generation 核對。第一份 strict 檢查攔下原解碼型別中 nullable intent；已確認 `decodeAuthoring` 在 creation 分支必須驗證原 intent，呼叫以該既有不變條件收窄型別，沒有產生另一個識別。保留原 strict 失敗 log，修正後通過。

## 驗證

- 18 檔／203 個原 unit 案例全部通過，逐項符合固定 inventory：草稿與發布、安排、帳本與計算、收款碼、分房、建立識別、原請求與舊稿轉換、結算及 HTTP 契約。不為呼叫搬移新增鏡像測試。
- 18 檔／217 個原 browser 案例全部一次通過，固定 IDs、標題、位置已核對，無 retries、skips 或 flaky。涵蓋建立後遺失回應、原 UUID／本文恢復、原建立識別、活動／投票舊稿、款項 record／report／accept／reject／withdraw／reverse／close／reopen 恢復、帳本草稿、原結算稿保全、收款碼與原圖、分房試算、跨分頁、登出與共用動線。
- strict、完整建置與 compiled smoke 通過。231 個 web 產物逐項與測試使用的隔離副本 byte 相同。81 個靜態資源、140 個壓縮表示、274 次 HTTP 檢查通過；84 個 precache 共 1,756,359 bytes，最大原子批次 575,377 bytes。原三個快取安装／持有最後批次／失敗恢復案例及 browser attachment 的原 keys、bytes、hashes 已逐項核對。
- API 的 178 個編譯來源及兩個 bundle、三個已鎖定 bot runtime 產物與第 182 號相同；schema、outbox、bot 設定及網頁入口未變。compiled smoke 的合成 native bot 驗證通過；沒有本輪 fresh Python image pair 或正式在線版本組合驗收。

證據保存在本機 `remaining-http-adoption-183/`，包括原始與受測來源 pins、AST inventory、unit／browser JSON、完整建置、失敗與修正 strict logs、靜態／precache／runtime 獨立核對收據。

第 182 號的八個活動操作頁另有 11 檔／154 個 unit 與 16 檔／156 個 browser 全部通過，來源 `1a047513e8c8e207049051953f249f0e777f044b` 的 1,427 個 Git blobs 已核對並雙邊同步。兩輪結果在各自受測產物執行，不能合稱單一完整候選 run。

## 原 CI 與 bot 配對

第 180 號原 run `44872622986` 已完成 success，三個 job 均成功。unit artifact `14695723094`、browser artifact `14696385768`、image artifact `14695340006` 的 ZIP digest、CRC、解包 hashes 已核對。原 184 檔／3,056 個 unit 與 81 檔／844 個 browser 逐項符合固定 inventory，browser 全部一次通過；原 86 個 precache 共 1,757,747 bytes 的 keys、bytes、hashes 與該版本清單相同。

第 180 號 exact archive 重新生成的 Python manifest 與 bot harness 等於原 artifact；固定 55 個 Python blobs、71 次原 worker、九次 native consumer、314 個深連結、模式／回呼／恢復／交接計數及原 inspect、Compose、runtime manifest 已獨立核對。使用合成資料與 network denied；不代表真實 QQ、實際在線版本組合、來源發布核准或 B01–B15 全部接受。第 178 號原成功及第 176／177 號原失敗保持各自結果；第 181 號原 run `44874474669` 最近仍在執行，未取消或重跑。

166 capabilities 仍為 0 fully accepted，`releaseEligible=false`。完整前後端與 bot 全功能保全目標保持不變；下一步完成 permission／response 契約、真正 OpenAPI、來源／reset、media／browser、候選版本組合與切換演練，正式切換前仍須逐項完成驗收。
