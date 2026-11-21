# 共用路徑驗證

日期：2026-11-21。變更範圍：`web`；實際部署：`none`。未整合 main，保留 Python bot。

全部 194 個 v2 操作中，104 個含路徑參數的操作、131 個參數位置，已綁定實際 handler 與本檔 helper 使用的 19 個共用 Zod 契約。API 不再為這些路徑重複宣告本地 schema；前端送出前執行同一份驗證。生成器保留同一路徑上實際使用的每個 validator，拒絕未綁定、原始讀取、內嵌 schema、缺少欄位或未掛入路由的 helper。

網址仍使用原字串編碼。歷史版本維持既有 Number 轉型、整數與安全範圍檢查，沒有改成只接受十進位文字；bot 投遞編號維持字串與 BigInt 上限，避免精度流失。JSON Schema 描述的是 decoded 字串；Number 解析與其結果限制另記於 extensions，不能用 JSON Schema 的字串驗證取代 Zod refinement 或伺服器權限。

路徑契約透過 `@qgroup/contracts/http-paths` 匯出。初稿從共用根入口匯出時讓 bot 載入額外初始化程式，已修正為獨立入口；最終 9 個 bot 執行檔與 189 逐位元組相同。schema、outbox、設定、指令和既有網址均未更改，沒有啟動或更新正式 bot。

## 驗證

- 31 個 API 檔案對照 189 的固定提交封存，移除已搬移的路徑宣告並正規化對應解析後，身份檢查、業務處理、交易與通知呼叫的 AST 相同。驗證器也確認身份 guard 的刻意變更會被拒絕。19 個新舊 schema 的 1,900 組輸入比對，接受結果、解析值與物件驗證 issues 相同；原 scalar 轉為物件後的 issue path 不列為相同，HTTP 仍回傳既有統一 `INVALID_INPUT`。
- strict、完整建置與契約 CLI 通過。8 個相關 unit 檔案／114 個案例通過；新增 17 個案例。固定全站 inventory 為 190 檔／3,134 案例，本輪沒有完整全套通過結果。初次相關測試有兩個既有 transport fixture 使用原本就不符合伺服器規則的圖片／成分 ID，改為有效 synthetic ID 後保留原斷言並通過。
- 初稿的本機全套測試在契約匯出仍待修正時中止，保留原 log 與 owned-run interruption receipt，不列為全套通過。原 GitHub CI 未中止或重跑。
- 4 個 browser 檔案／26 個案例一次通過，包括結算、管理員 PIN、通知查閱與 PWA；逐項對照既有固定 inventory。81 個靜態資源／274 個 HTTP 檢查通過；84 個 precache 資源共 1,777,913 bytes，最大原子批次 575,466 bytes，browser 的原 precache 附件與本機 HTTP 資源一致。
- 原 296 個 request／shared schemas、127 個回應 schemas、body／query／success 綁定與身份規則相同。新增 19 個路徑 schemas 後，OpenAPI 有 442 個 components、836 個可解析的本地參照。未修改的官方 OpenAPI schema、Hyperjump 與隔離安裝的 Python jsonschema 4.23.0 驗證通過；數字轉型、遞迴 JSON、nullable 讀取與不可為 null 的保存回應保持正確。
- 最終受測來源固定為 1,450 個 pins，產物另存快照。測試後文件差異只限兩個 README 與本 checkpoint；提交封存逐項核對固定來源與 Git blob。

## 189 原 CI 完成結果

189 原 CI `44907275870`，固定提交 `e2b5f2b24136d3dac27784c88b0fd548c7876073`，三項工作與整體結論均為 success。189 檔／3,117 unit 案例與 81 檔／844 browser 案例通過；原 ZIP digest／CRC、解包 hashes、固定 inventory、precache 附件與原 OpenAPI／生成器輸入均已獨立核對。

原實際 Linux 映像、runtime manifest 與固定原 Python image 配對也已核對，來源及 harness manifests 從該提交封存重新生成並相同。55 個原 Python blobs、71 次原 worker invocation、9 個 native consumers、314 個深連結，以及 domain／recovery／handoff 模式保持通過。驗證仍使用隔離 synthetic 資料與禁止網路的投遞，不能當成已確認線上 bot 版本或完整 B01–B15 驗收。

證據：`http-path-bindings-190/`；189 原 CI 證據保存在 `http-boundary-coverage-189/`。`pathValidationBound=true`、`boundaryCoverageComplete=true`；`permissionBindingsComplete=false`、`openapiComplete=false`、`releaseEligible=false`。166 capabilities 仍為 0 fully accepted。完整 domain authorization、來源／reset／media、bot、實際版本組合與切換／回退驗收仍待完成；本輪未操作正式資料或真實 QQ。
