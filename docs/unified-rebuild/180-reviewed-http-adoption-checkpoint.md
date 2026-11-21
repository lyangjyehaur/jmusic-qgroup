# 共用草稿的固定提交操作

日期：2026-11-21。候選變更範圍：`web`。未部署、未整合 main；保留 Python bot。

## 實作

共用 useReviewedDraft 改為接受具型別的 send callback，各頁面指定固定 HTTP 操作、原本文、原持久 requestId、account scope 與回應 schema。六個呼叫方涵蓋詞條建立／更新／刪除、預分包間、逐人結算，以及時間投票建立／投票／管理；共用 hook 繼續保全草稿與未知結果，不再自己拼接路徑。原 result 仍交給 latest／after 作原有核對，完整固定 response 綁定尚未完成。

同时移除這四個頁面的讀取與預覽 path 呼叫，包括結算與歷史版本／游標、核對名冊、付款碼清單、分房採用來源、詞庫／我的詞條及投票管理讀取。使用固定 params 與 query，保留原 cache keys、會員 scope、刷新與公開／管理選擇。結算預覽仍帶原 CSRF，沒有製造 UUID；提交繼續用原草稿 UUID。舊紀錄保全、beforeSubmit 閘門、結算編輯的 preserveBeforeSubmit、預覽 token、確認與帳號失效處理皆保留；傳輸驗證不代替這些业务核對。

不新增介面文案。五檔與第 179 號 AST 對照：移除 21 處 path 呼叫，新增 19 個操作鍵，其中一個已在其他流程接入。全站使用 122 個不同固定操作鍵，剩 77 處過渡 path 呼叫；所有呼叫方、permission／response 綁定與真正 OpenAPI 仍待完成。

## 驗證

- 相關九檔／154 案 unit 全部通過，逐項符合原固定 inventory，涵蓋真實結算／投票／詞條／分房、舊結算与分房草稿及共用 HTTP。沒有為呼叫搬移新增鏡像測試或減少既有斷言。
- strict、隔離網頁建置及靜態驗證通過：83 個靜態資源、144 個壓縮表示、280 次 HTTP 檢查；86 個 precache 共 1,757,747 bytes，最大原子批次 466,960 bytes。原始 bytes、hash、sidecars、MIME、HEAD、conditional 與完整 precache 已核對。
- API 的 178 個編譯來源、兩個 API 與三個 bot runtime 產物逐項等於第 179 號；沒有 schema、outbox、bot 政策或入口變更，沿用相同 runtime 的第 176 號隔離 Python 證據，沒有 fresh 第 180 號 Python run 或正式在線版本組合。
- 本輪八檔／82 案 browser list 與原固定 IDs 核對完成，涵蓋全部六個 send 呼叫方、跨關閉分頁／未知結果／舊紀錄保全。第 179 號 167 案仍在執行，使用獨立的原第 179 號 final build；本輪产物放在另一目錄，該程序終結後才執行這批 browser。提交此文時本輪 browser 未執行，不能記為通過。

第 178 號的最終 27 檔／282 案已確認 exit 0；全部 IDs、標題、位置、一次通過與無 retries／skips 均核對。三個原提示失敗案例已通過；precache attachment 的 86 個原資源 hashes／cache keys／1,757,408 bytes 與該版 final build 相符，pinned public Umami 攔截 transport 通過。第 178、179 號乾淨來源封存分別核對 1,423／1,424 個 Git blobs 與完整提交 tree，沒有使用未提交檔案來替換來源。

第 177 號原 CI `44866830040` 已終结為 failure：image／browser 成功，unit 失敗。三個原 artifacts 的 ZIP digest／CRC／解包 hashes 已核對；unit 原 184 檔／3,056 案，3,055 通過、一個同樣的 compiled language 載入失敗，已在第 178 號修復。browser 原 81 檔／844 案全部一次通過，固定 IDs／標題／位置与原 cache attachment 均核對；没有把整 run 改為 success。原 image manifests／bot pair 尚需独立补核對。

證據保存在本機 `reviewed-http-adoption-180/`、`music-http-adoption-179/`、`admin-http-adoption-178/` 與 `account-http-adoption-177/`。166 capabilities 仍為 0 fully accepted，`releaseEligible=false`；所有前後端與 B01–B15 bot 功能保全目標不變，完整候選組合、media／browser、來源／reset 與切換演練持續進行。
