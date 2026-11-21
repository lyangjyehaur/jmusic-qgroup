# 全部 v2 操作的身份邊界

日期：2026-11-21。变更範圍：`none`（開發契約與生成器）；實際部署：`none`。未整合 main，保留 Python bot。

人工身份邊界 review 由 36 個增至全部 194 個 v2 操作，涉及 47 個 handler 檔案與 49 個固定來源檔。原 36 個描述與原來源 hashes 保持相同；新增 158 個描述逐項核對 handler 與 local helper 的 security／administrator 入口，不使用探索性 scanner 的函式名稱集合推論授權。生成器除了拒絕來源漂移、缺少或移動的操作，亦拒絕新增但未 review 的操作。

`boundaryCoverageComplete=true` 代表所有 v2 操作都有身份邊界描述；所有操作的 `domainAuthorizationComplete=false`，整體 `permissionBindingsComplete=false`、`openapiComplete=false` 與 `releaseEligible=false` 仍保留。此處未把活動角色、target ownership、版本、狀態、交易／receipt、舊入口或 bot 的完整功能驗收列為完成。

## 已保留的差異

- 財務、結算與收付款圖片的 10 個讀取入口增加 `optional-scoped-device`：有效 member／visitor session 存在，或供應非空 scope 時都必須驗證目前 scope。有效 cookie 缺少 scope 會拒絕；沒有有效 session 也沒有非空 scope 才走匿名投影。活動頁與部分名冊／歷史／邀請 preview 的 `optional-scoped-member` 則在缺少 scope 時忽略 cookie，維持匿名投影。
- 全站管理員 bot delivery 清單使用帳號管理員或救援憑證兩種權限；活動／投票通知的查閱與重試要求 member，並另有 owner／settlement scope、原通知與 review token 限制。救援管理員可以是 visitor，不因此取得 member 或重送權限。
- 指定 recipient 的管理交接 preview 仍要求相符 member；沒有 scope 即使攜帶該 member cookie 也收到匿名投影並被 recipient 檢查拒絕。不能把可匿名的未限定 preview 當成所有 token 都能匿名使用。
- member 的成分／設備／隱私、device 的領取與連結 preview、管理員的完整雙重 CSRF，以及 proof-only 註銷收據保持原邊界。成分查詢、bot policy preview、PIN result 與管理員刪除收據等 POST 即使只是檢查結果，仍保留原 write security；沒有因操作名稱而降低驗證。

## 驗證

- strict、完整建置與契約 CLI 檢查通過。16 個相關 unit 檔案／195 個案例全部通過，與固定 inventory 一致；新增 4 個案例涵蓋未 review 的新增操作、全部 10 個財務讀取入口的 cookie／scope 差異、救援管理員與 bot delivery 權限分離，以及指定 recipient preview。全站 inventory 現為 189 檔／3,117 案例，本輪未執行全套 unit。
- 初次 195 個案例有 192 個通過與 3 個 5 秒逾時，没有 assertion failure。保留原 report／log；测试中的唯讀 OpenAPI 描述改為共用一份，不重複生成同一文件，未改動斷言。以單一 worker 與 CI 使用的 30 秒限時重新執行全部相關案例，195 個通過，未改動正式 guard、資料或測試 fixture。
- 獨立 Python 稽核確認原 36 個描述、全部原 body／query／response 綁定、296 個 request／shared schemas 及 127 個 response schemas 相同；194 個 review、49 個來源 pins 與 144 個生成器輸入 hashes 一致。官方未修改的 OpenAPI schema 與獨立 jsonschema 4.23.0 驗證通過，423 個 component schemas、591 個本地參照均可解析，遞迴 JSON extensions、nullable 讀取與不可為 null 的保存回應仍正確。
- 全部 243 個 runtime 檔案與 188 逐位元組相同，包括 3 個 API、9 個 bot、全部前端與 PWA metadata。本輪未重跑 browser 或靜態 HTTP，也沒有以相同產物比較取代新的正式映像驗收。
- 最終受測來源固定為 1,447 個 pins；提交封存另逐項核對 exact commit，测试後文件差異只限兩個 README 與本 checkpoint。

## 原 CI 證據完成結果

187 的原 CI `44896999565`（`6c57a11979b8326dd14dfa59b2e489b242e4665e`）已完成：188 檔／3,102 unit 案例與 81 檔／844 browser 案例通過，原 ZIP digest／CRC、解包 hashes、固定 inventory、原 precache attachment 與生成器輸入／schema 目錄已核對。image job 的模組漏帶失敗仍保留，整體結論是 failure，未取消或重跑。

188 的原 CI `44900793117`（`fe01964f8a342fcf777ede4b2425a07e42525b69`）三項工作與整體結論均為 success。189 檔／3,113 unit 案例、81 檔／844 browser 案例全部通過；原 ZIP、固定 inventory、84 個／1,772,091 bytes precache 附件、原 OpenAPI 與操作目錄均已獨立核對。image 與 runtime manifest，以及實際 Linux web／固定原 Python image 的配對已核對，包含 exact source 重建的 manifests、55 個原 Python blobs、71 次 worker invocation、9 個 native consumers、314 個深連結及 domains／recovery／handoff 模式。第一次本機 image 稽核缺少三個 native runtime pins 的收據，補上獨立重算的固定 hashes 後通過；原 image 沒有因此重跑。

該配對使用隔離 synthetic 資料與禁止網路的投遞。實際線上 bot 版本、完整 B01–B15 與切換／回退組合仍未驗收，不能把 CI 配對記為正式環境相容性已確認。

證據：`http-boundary-coverage-189/`；187／188 原 CI 稽核分別保存在 `http-openapi-generation-187/` 與 `http-access-boundaries-188/`。166 capabilities 仍為 0 fully accepted，`releaseEligible=false`。精確路徑、完整 domain authorization、來源／reset／media、bot、切換與回退驗收仍待完成；未操作正式資料、真實 QQ 或正式服務。
