# 圈子計算隔離與結果資格重驗

日期：2026-11-22（Asia/Taipei）。變更範圍：`web`；實際部署：`none`。網站圈子計算移至 TypeScript worker，保留原演算法、回應、schema、outbox、設定及 bot 入口。原 Python bot 保留，未修改正式服務或真實待送工作。

## 計算與取消

`GET /api/v2/music/circles` 先在交易中確認目前 scope、會員與成分資格，只讀取既有圈子所需的姓名、選擇及詞條投影。worker 不接收 DB handle、憑證或傳輸 client，啟動環境為空、啟動參數獨立；worker 拒絕意外繼承環境的啟動。私人留言、聯絡 QQ、性別及帳號識別不進入計算。

每個 API 程序最多同時兩個圈子 worker，不累積等待佇列；每個 thread 的 V8 old generation 上限 128 MiB、young generation 16 MiB、stack 2 MiB，單次五秒期限。完成、失敗、逾時或取消後先終止 thread，再釋放名額；關閉服務會停止所有在途工作。HTTP 客戶端斷線取消計算，不傳回晚結果。忙碌、失敗、逾時與停止使用必要的簡繁提示，沒有新增展示文案。

這是 thread heap 與單程序的圈子並行限制，並不是總 RSS、全站 CPU 或多副本配額。既有分房另有自己的 worker 限制；正式規模的 DB 讀取、投影複製、整個程序及圈子／分房同時執行仍須量測。

## 結果與權限

計算完成後，主程序重新確認目前裝置、帳號、成分資格與本人 profile ID，並在新交易中重新建立來源 hash。姓名、詞條、選擇、成分刪除或所有權變更，會拒絕原計算結果並要求重新分析；worker 結果不能提供存取權。hash 只包含計算投影及門檻，沒有複製私人資料。

原 `musicCircles` domain 程式完全保留。連結門檻、間接連結、相同姓名的穩定 ID、圈子順序、全部獨立成員及詞條合計與原回應一致，不截斷參與者或改變評分。全部 195 個操作的請求與成功回應契約保持相同，圈子之外的權限邊界語意也保持相同。149 個契約來源 inputs、64 個權限來源 pins 核對完成；權限綁定與發布資格仍為 false。

## 驗證

- 7 個 unit 檔案／52 個案例通過，其中新增 16 個案例。涵蓋真正 worker 的兩個名額、溢出、取消後才釋放名額、逾時與晚結果、停止、驗證失敗、空環境正反控制及完整 1,000 人結果；API 涵蓋選擇／姓名／詞條／刪除、成分資格、裝置撤權與帳號切換，以及實際 HTTP 斷線與健康查詢。原圈子多門檻／Python 差分及全表／bot 投遞保全回歸通過。
- 2 個 browser 檔案／13 個原案例通過，0 重試／跳過，涵蓋資格、全部圈子、同名與獨立成員、門檻／比較／共用草稿、晚讀取、錯誤重試、跨分頁更新與手機換行。兩個初始失敗源於測試結束時 `route.fetch` 仍在途，原 trace 保留；只新增 `unrouteAll({ behavior: 'wait' })` 清理，沒有忽略錯誤、刪除斷言或改動原案例 ID／位置。
- strict TypeScript、建置與建置後 smoke 通過，實際 bundle 的圈子 worker 保留完整圈子及獨立成員結果。五個 runtime bundle 重現一致，API／圈子 worker 的來源共 188 個 inputs，native consumer 108 個。網站靜態資源與前輪 200 相同。
- 同一固定 seed 的合成 1,000 人／2,000 詞條／最多 20 選擇樣本，原同步計算約 1,649 ms；最終 compiled worker 約 1,666 ms，主程序 10 ms heartbeat 取得 141 次回呼，最大間隔 15 ms。完整結果逐項等於原 domain：80 個圈子、779 個獨立成員。這是直接 worker 樣本，不能當作正式 API、來源 DB 或容量驗收。

最終 API 與固定原 Python bot 提交 `8da877857f163853c449474e168534e2e493121b` 的隔離組合通過，獨立 oracle 核對 55 個 Python blobs、71 次原 worker、9 次 native consumer、314 個深連結及 532 次 HTTP（含 2 次限流延後），以及提醒／quiet／pacing、重試、不確定投遞、模擬與順序交接；runtime 與 harness pins 相符，沒有真實 QQ transport。證據存於 `circle-isolation-201/`，仍不代表線上實際版本或完整 B01–B15。完整宣告 unit inventory 為 202 檔／3,762 個案例；本輪只宣稱上述 52 個 targeted 案例，前輪 200 的 3,746 個完整 unit 通過紀錄保留。

M22 與 U03 補入本輪證據，仍為 `in_progress`。166 個能力及 U01–U03 全部保留，0 fully accepted，發布資格 false。正式規模／併發與程序總資源、完整來源對帳、QQ WebView、實際 bot 版本組合及 P6 成套驗收仍待完成，不部署。
