# 共用 HTTP 成功回應契約

日期：2026-11-21。候選變更範圍：`both`，因為本輪修改所有 v2 成功回應的 API 邊界，仍須確認實際網站／bot 版本組合。實際部署：`none`；未整合 main，保留 Python bot。

全部 194 個 v2 操作綁定成功回應：187 個結構化 JSON、6 個圖片、1 個 JSON 下載。126 個回應 schema 另列於契約目錄，既有 296 個根 schema 及請求生成檔維持原樣。完整專案檢查要求回應鍵、生成請求鍵與實際路由一致；局部語法解析仍可驗證 lexical helper 與迴圈來源。

API 在實際送出的成功回應檢查 JSON／schema、MIME、圖片非空位元組及下載附件／JSON 語法，保留原序列化內容、空白、使用者擴充欄位與圖片位元組。回應錯誤回報 500，不回報 400，不輸出原 payload 或 Zod issues；不撤銷已完成交易、不改寫回執、不自動重送。錯誤回應、HEAD、合作方及 OAuth 協議保留原邊界。

共用 client 新增 `requestContract`，由固定操作推導結果型別並驗證回應，未知／非結構化操作在傳送前拒絕。網站 adapter 保留每次請求獨立的 analytics、原例外、身份撤權、取消訊號與未知結果處理。nullable 成分讀取與成功保存的非 nullable 型別分開；本輪尚未搬移頁面的顯式回應 schema。

## 驗證與失敗保留

- strict、契約檢查、完整建置與 compiled smoke 通過。修正局部來源檢查後重新建置，243 個 runtime 檔案含 231 個 web 檔案與原受測副本逐位元組相同；194 個操作與 schema 目錄語意相同，139 個目錄來源 pins 已核對。
- 完整單元 run 涵蓋固定 186 檔／3,077 個案例，3,074 通過、3 失敗，保留原 JSON／log。一項是全站完整性檢查誤套到局部 query fixture，已把完整性要求移到完整專案 checker；相關兩檔／8 案例通過。另兩項為原資料對帳：一項觸及 30 秒測試上限，另一項 Python relation 未完成；兩檔／22 案例獨立執行全部通過，原 linked 情境約 10.5 秒。未修改 migration runtime、時限、斷言或固定 inventory。修正及隔離 followup 共 30 個案例與原 inventory 逐項匹配，全部原案例及新增 21 個案例有覆蓋；不能稱為修正後單一全套 run 已通過。
- 81 檔／844 個原 browser 案例全部一次通過；IDs、標題、位置與固定 inventory 相同，無 retries、skips 或 flaky。涵蓋全部既有網站流程、原請求／UUID、草稿與撤權、結算／收款碼原圖、後台匯出、bot 管理與 PWA。
- 81 個靜態資源、140 個壓縮表示、274 次 HTTP 檢查通過；84 個 precache 共 1,770,672 bytes，最大原子批次 575,394 bytes。原三個快取情境及 attachment 的 keys、bytes、hashes 已核對。
- 新版 API 有 182 個編譯來源、兩個 bundle；三個固定 native bot 產物與第 183 號相同。fresh 保留 Python 驗證核對固定 55 個原 blobs、71 次原 worker、9 次 native consumer、314 個深連結，以及模式／政策／通知／回呼／重試／未知投遞／交接計數。使用自有隔離資料庫及 network denied，不對真 QQ 或正式資料操作。

本機證據目錄：`http-response-bindings-184/`，包括初始失敗、修正 followup、固定 inventory、受測及修正來源 pins、原 browser 報告、靜態／快取、Python 與編譯產物獨立核對收據。

## 原 CI 與下一步

第 181／182／183 號原 run `44874474669`／`44876890159`／`44878300114` 均完成 success。各原 unit 184 檔／3,056 案例及 browser 81 檔／844 案例逐項通過；原 ZIP digest／CRC／解包雜湊、快取 attachment、固定 Python image pair、重新生成的來源／harness manifest 與原 Compose／runtime 身份已核對。這些是各原提交的結果，不代表本輪候選已取得 fresh image pair，也不取代實際在線版本組合。

下一步將頁面改用推導回應型別，再補權限綁定、完整下載資料 schema 與真正 OpenAPI。隔離副本已準備 62 檔／237 個實際呼叫（243 個操作引用）的搬移並通過 strict，原操作表達式及 input hashes 相同；保存後成分重讀的 nonnullable 檢查另保留，尚未套入本提交。

166 capabilities 仍為 0 fully accepted，`releaseEligible=false`。完整來源／reset、media、實際版本組合、B01–B15 及切換／回退驗收未完成；不部署。
