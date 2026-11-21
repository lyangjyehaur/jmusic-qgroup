# 成分、同好與隱私的固定操作

日期：2026-11-21。候選變更範圍：`web`。未部署、未整合 main；保留 Python bot。

## 實作

十二個頁面移除 32 處過渡 `api()` 呼叫：成分資料、聯絡 QQ、同好查詢／比較／推薦、圈子、分享、趨勢、詞條選用者、找搭子、原成分找回、會員隱私刪除與壁紙清單。新增 scopedHttp helper 只攜帶原 account scope；寫入繼續沿用 authHttp 的原 scope／CSRF。

保留原 cache keys、排序、門檻、offset／limit、刷新頻率、signal、未完成表單與草稿操作。同好 ID 及詞條 ID 直接傳入具型別的 params，由共用 transport 編碼；查詢保留使用者原字串。找搭子清單／歷史、找回完成／取消使用明確固定操作分支。聯絡 QQ、成分欄位與找搭子發布沿用原持久 UUID，沒有改變未知結果重試。找回 PIN 仍不儲存在瀏覽器，QQ 授權目的與回程不變；claim requestId 與刪除 requestId／secret 保持本文或 query 的原位置，沒有新增 idempotency header。公開刪除回執仍可在登入撤銷後查詢，不帶 account scope 或 CSRF。

不新增介面文案或改變頁面動線。AST 與第 178 號來源對照確認 32 處移除；本輪新接入 29 個操作鍵，其中三個已在其他流程接入。全站直接使用 104 個不同固定操作鍵，剩 98 處過渡 path 呼叫；permission／response 綁定及共用 reviewed-draft 的固定操作尚未完成。

## 驗證

- 16 檔／211 案全部通過，逐項符合固定 inventory，沒有跳過或減少原斷言。涵蓋真實 API 的成分／QQ／圈子／匹配／分享／趨勢／詞條／找搭子／claim／隱私／壁紙，以及 compiled language 和共用 HTTP 的例外與路徑驗證。
- strict、隔離網頁建置、靜態 HTTP／壓縮／precache 驗證通過：83 個靜態資源、144 個壓縮表示、280 次 HTTP 檢查；86 個 precache 共 1,756,903 bytes，最大原子批次 466,960 bytes。原 bytes、hash、MIME、HEAD、conditional 及完整 precache 逐項核對。
- API 的 178 個编譯來源、兩個 API 與三個 bot runtime 產物逐項等於第 178 號；沿用相同 runtime 的第 176 號 Python 隔離證據，沒有 fresh 第 179 號 Python run。schema、outbox、bot 設定與入口未變，沒有正式在線組合或真實 QQ 驗收。
- 已準備本輪 16 檔／167 案瀏覽器 inventory。第 178 號 282 案仍使用原 final build 執行；本輪建置放在獨立目錄，待該程序終結才切換本機測試產物並執行新 suite。提交此文時本輪 browser 未執行，不能記為通過。

## 原 CI 證據補核對

第 176 號原 run `44865641172` 保持 failure；unit 的一個 compiled language 失敗已在第 178 號修復，原失敗不重寫。browser artifact `14693556213` 的 ZIP digest `cd9030a59eee62048846e5c2c930c89cbc1db5d8431f6bf1be7d24d015baf978`、CRC 及 97 個解包檔案 hashes 已核對；81 檔／844 案全部原 IDs／標題／位置符合固定 inventory，全部一次通過，沒有 retries／skips。原 precache attachment 的 85 個資源、1,754,834 bytes、cache keys 及原 hashes 等於第 176 號最終靜態證據；pinned public Umami 的攔截 transport 案亦通過。

第 176 號 image artifact 的原版本、inspect、Compose 與 source manifests 已核對。乾淨 checkout 封存完整第 176 號 SHA，重新生成固定 Python source manifest 與 bot harness 後，逐項等於原 artifact；核對 55 個原 Python blobs、71 次 original worker、九次 native consumer、314 個深連結及 plain／rich／dry-run 的原計數、回呼、恢復與交接 oracle。驗證範圍仍是隔離映像與合成資料，network denied、無真實 QQ，不能代表 B01–B15 已完整接受或實際在線服務組合。

證據保存在本機 `music-http-adoption-179/`、`admin-http-adoption-178/` 與 `web-http-transport-176/`。166 capabilities 仍為 0 fully accepted，`releaseEligible=false`；完整前後端與 bot 保全目標不變。剩餘固定呼叫、permission／response 綁定、真正 OpenAPI、來源／reset、media／browser、候選服務組合與切換演練持續進行。
