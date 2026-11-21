# 管理員匯出資料契約

日期：2026-11-21。候選變更範圍：`web`；實際部署：`none`。未整合 main，保留 Python bot。

`GET /api/v2/admin/music-export` 綁定 `HttpMusicExport`，API 除了原 JSON 語法、MIME 與 attachment 檢查，亦驗證 entries、members、settings、shouts、shoutHistory、trend 六個必要區段及索引一致性。回應缺陷仍回報不含資料的 500；驗證不替換原序列化內容，不改寫匯出資料、不重送交易。

現行與歷史匯出的選項字串、可選 ID、數字／字串／boolean／null 等級、可選及 nullable 時間與 JSON 使用者擴充欄位保持原樣。管理員原本可匯出的 pinHash、boardUserId、contactQQ 保留原行為；settings 維持空物件。最新身份、清空聯絡方式及刪除／RESET 的投影繼續由原 exporter 執行，未改動資料庫、備份、身份或刪除紀錄。

契約生成器把下載 schema 列入回應目錄及操作參照：共 194 個操作、296 個根 schema、126 個既有 JSON 回應 schema 與 1 個新下載 schema。獨立比較證明其餘 193 個操作與既有 schema 全部相同。`structuredDownloadSchemaBound=true`；權限綁定及 OpenAPI 仍未完成。

## 驗證

- strict、完整建置及 compiled smoke 通過。初次新 fixture 的異質選項陣列推導出可選 undefined，與 JSON 型別不相容；改用明確 `Json[]`，保留原編譯診斷，未改變測試資料或放寬匯出契約。
- 7 個相關 unit 檔案／121 個案例全部通過，與固定 inventory 一致；新增 14 個案例驗證兩個實際 exporter、使用者擴充欄位、歷史 scalar，以及缺少區段、索引／型別錯誤與不應匯出的 settings hash。既有現行／歷史備份、最新刪除投影、PIN／聯絡方式、原始檔保全與 bot rows 驗證通過。全站 inventory 現為 187 檔／3,094 案例；本輪執行相關測試，未宣稱單次全套 unit 已通過。
- 後台備份、PWA precache 及統一網站三個原 browser 檔案／14 個案例全部一次通過；原 IDs、標題、位置與固定 inventory 一致，無 retries、skips 或 flaky。涵蓋下載、歷史備份、成分保存、身份與草稿、完整快取及失敗後重試。本輪未重跑全站 browser；上一輪 185 的 81 檔／844 個案例已全部一次通過。
- 81 個靜態資源、140 個壓縮表示與 274 次 HTTP 檢查通過。84 個 precache 共 1,772,091 bytes，最大原子批次 575,463 bytes；browser attachment 的 keys、bytes、hashes 與原靜態資源逐項匹配。受測來源 pins 保持相同。
- 183 個 API 編譯來源及兩個 bundle 已獨立重建核對；三個固定 native bot bundles 未改變。全部 9 個 bot runtime 檔案及 API 資料庫／分房 worker 與 185 逐位元組一致，只有 API start bundle 增加匯出驗證。資料、設定、outbox、bot 網頁入口及原 exporter 原始碼均未修改。

證據目錄：`structured-export-binding-186/`，包括新 fixture 的初始 strict 診斷、passing unit／browser、固定 inventory、契約目錄、140 個契約來源 pins、原靜態／precache attachment 及 runtime 比較收據。

166 capabilities 仍為 0 fully accepted，`releaseEligible=false`。本輪的 `web` 範圍判定不取代實際線上 bot 版本組合驗收；權限綁定、完整來源／reset、media、B01–B15、切換與回退驗收仍待完成。未對正式資料、真實 QQ 或正式服務操作，不部署。
