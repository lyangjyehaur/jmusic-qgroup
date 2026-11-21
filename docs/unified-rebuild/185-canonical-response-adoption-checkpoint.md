# 前端採用固定 HTTP 回應契約

日期：2026-11-21。候選變更範圍：`web`；實際部署：`none`。未整合 main，保留既有 Python bot。

62 個前端呼叫檔案的 237 個實際呼叫（243 個固定操作引用）改用 `requestContract`，回應型別及驗證由共用操作表推導。保存成分後的重讀使用 `requestNarrowed`：先驗證固定 nullable GET 契約，再保留原本必須存在的 profile 檢查。相容方法仍保留，兩個圖片／附件原始回應呼叫維持原協議。

獨立 AST 核對證明全部 62 檔除了 HTTP 呼叫與不再使用的 imports 之外保持相同；237 個呼叫的操作表達式及 input 雜湊均與原版本一致。原 UUID、requestScope、CSRF、body、草稿、取消及未知結果恢復邊界保留。adapter 繼續在原請求觀測範圍內回報例外，新增 narrowing 不繞過 canonical schema，不自動重送。

## 驗證

- strict、完整建置及 compiled smoke 通過。7 個相關單元檔案／116 個案例全部通過，固定 inventory 已核對。新增 3 個案例驗證 nullable narrowing、canonical 先拒絕 malformed wire、UI 收到原 parse error 且只觀測一次。初次新 fixture 缺少必要的 `updatedAt`，82 個案例中 1 個失敗；補齊 fixture 後重新驗證，保留初始 JSON／log，未弱化斷言。全站 inventory 現為 186 檔／3,080 案例；本輪未另行宣稱單次全套 unit 已通過。
- 81 檔／844 個原 browser 案例全部一次通過，原 IDs、標題與位置逐項匹配，無 retries、skips 或 flaky。三個原 precache 情境及 attachment 的 keys、bytes、hashes 已核對；受測來源 pins 保持相同，243 個 runtime 檔案與保留副本逐位元組一致。
- 81 個靜態資源、140 個壓縮表示及 274 次 HTTP 檢查通過；84 個 precache 共 1,770,690 bytes，最大原子批次 575,367 bytes。
- 全部 12 個非 web runtime 檔案（3 個 API、9 個 bot）與第 184 號受測產物逐位元組相同；共 243 個 runtime 檔案，其中 231 個 web 檔案。schema、outbox、設定、bot 深連結及 API／bot 實作未修改。這支持本輪候選範圍為 `web`，實際線上未更新 bot 的版本組合仍須驗收。

證據目錄：`canonical-response-adoption-185/`，保留原 fixture 失敗、最終單元結果、固定 inventory、原 AST／input／操作核對、來源 pins、完整 browser 報告、靜態與編譯產物收據。

第 184 號原 CI `44884268638` 已全部成功。原 unit 186 檔／3,077 案例及 browser 81 檔／844 案例全部通過；原 ZIP digest／CRC／解包雜湊、固定 inventory 與 precache attachment 已核對。實際 Linux web／固定原 Python image pair、55 個原 blobs、71 次 worker、9 次 native consumer、314 個深連結、原 runtime manifest 與重新生成的 exact-source harness 亦已獨立核對。第 184 號本機全套原 run 的 3 項失敗與後續 30 項 passing coverage 保留，不改寫為單次全套成功。

## 尚待完成

166 capabilities 仍為 0 fully accepted，`releaseEligible=false`。下一步綁定後台下載的完整資料 schema，再補權限綁定與 OpenAPI；完整來源／reset、media、實際版本組合、B01–B15 及切換／回退驗收持續進行。以上隔離驗證不等於真實 QQ 或正式切換驗收，不部署。
