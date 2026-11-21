# 後台固定操作與 JSON 例外保全

日期：2026-11-21。候選變更範圍：`web`。未部署、未整合 main；保留 Python bot。

## 實作

十二個後台頁面及 profile helper 移除 40 處過渡 `api()` 呼叫，改為固定操作鍵及具型別的 params、query、body。涵蓋使用者與管理角色、備註、隱私、公告、壁紙、詞庫、備份、bot 政策與預覽、成分所有權、PIN、單份刪除與全站成分重置。讀取 helper 只帶原 account scope，寫入 helper 沿用 account scope、CSRF 及 admin-CSRF；沒有替原唯讀操作新增管理寫入憑證。

保留搜尋原字串、cache keys、游標省略語意、原成分 ID、PROFILE_NOT_FOUND 的空結果、管理授權失效處理與既有草稿。角色／備註命令、單份刪除／全體重置明確分支；刪除回執仍使用本文內的原 requestId／secret，沒有新增 Idempotency-Key。所有原本使用 header 的寫入繼續使用原持久 UUID 與 scope，沒有為重試產生新編號。沒有新增展示文案或改變頁面操作流程。

原第 176 號 Linux unit 揭露語言測試只編譯 api.ts、無法載入新共用 transport。修正測試以有界 loader 編譯 api、api-errors、http、http-path，使用真實 contracts 與同一 Zod instance，保留原簡繁提示、例外身份／message／stack 與 analytics 結果斷言。進一步修復共用 client 包裝 JSON 解析例外後的行為退化：generic client 的 HttpProtocolError 保留 cause，web adapter 重新拋出原 JSON 例外物件，頁面仍收到必要提示，analytics 仍記 parse_error，未知結果恢復語意不變。

AST 對照第 177 號提交確認 40 處移除、35 個新接入操作鍵。全站直接接入 78 個不同固定操作鍵，仍有 130 處過渡 path 呼叫；permission／response 綁定與所有呼叫方型別化尚未完成。

## 驗證

- 相關 unit 三份報告逐項去重：14 檔／222 個不同案例全部通過，88 個重複執行不重複計數。原後台 205 案，加上修正後 compiled language／transport 的 105 案；包括真實 API、搜尋、權限、刪除、備份、bot 設定、壁紙及 HTTP 路徑。strict、最終完整建置、compiled API／bot smoke 通過。
- 最终工作樹產物已在隔離資料庫驗證：83 個靜態資源、144 個壓縮表示、280 次 HTTP 檢查；86 個 precache 共 1,757,408 bytes，最大原子批次 466,937 bytes。逐項核對原 bytes、hash、sidecars、MIME、HEAD、conditional 及 precache inventory；沒有沿用 JSON 例外修正前的產物雜湊。
- 最終 API 的 178 個編譯來源、兩個 API 與三個 bot runtime 產物逐項符合第 177 號。schema、outbox、bot 設定語意及網站入口未改；沿用第 176 號相同 runtime 的隔離 Python 證據，沒有 fresh 第 178 號 Python run，也沒有正式在線版本組合或真實 QQ 驗收。
- 最終 27 檔／282 案瀏覽器 inventory 與原固定案例 ID 核對後，啟動一個新隔離 suite，JSON reporter、獨立 output directory、單 worker、無 retries。涵蓋帳號／裝置／同意／收件匣、全部相關後台、三個原提示失敗、PWA 及 pinned public Umami client 的攔截投遞。提交此文時仍在執行，不能記為通過。

第 176 號原本機 843 案程序已確認 exit 1：840 通過、三個原提示案例失敗。原 stdout 的全部 ordinal、檔案、位置及 leaf-title multiset 已核對；stdout 沒有 runtime test IDs，不能當成 JSON 證據或第 177／178 號驗證。該程序使用第 176 號提示修正前產物，失敗紀錄保留。

原 CI run `44865641172` 已終結為 failure：image、browser jobs 成功，unit job 失敗。unit 原 artifact `14692707947` 核對 ZIP digest／CRC／四個解包檔案及完整 inventory：184 檔／3,056 案，3,055 通過、一個上述 compiled language 測試失敗。browser job 成功的原 artifact `14693556213` 與 image 原結果仍需完成独立 audit，不將 run 改為成功。第 177 號原 CI `44866830040` 的 image job 成功、另兩個原 jobs 持續按原 handles 觀察；不重跑原程序來取代原結果。

證據保存在本機 `admin-http-adoption-178/` 及 `web-http-transport-176/`。166 capabilities 仍為 0 fully accepted，`releaseEligible=false`。所有前後端及 B01–B15 bot 保全目標不變；剩餘固定呼叫、完整 permission／response 綁定、真正 OpenAPI、來源／reset、media／browser、實際候選服務組合與切換演練持續進行。
