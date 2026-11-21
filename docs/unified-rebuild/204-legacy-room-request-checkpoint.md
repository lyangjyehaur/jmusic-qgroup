# 舊包間請求核對與恢復

日期：2026-11-22（Asia/Taipei）。變更範圍：`web`；實際部署：`none`。沿用原包間操作編號、內容與資料語意，新增統一網站恢復入口；沒有修改 Python bot、TypeScript bot 業務、schema、outbox 或既有深連結。

## 實作

`/me/local-history` 現在支援原 `PUT /api/events/:id/rooms` 請求。檢查只讀取目前活動與原回執；沒有回執時，展示目前安排、原請求將保存的安排、原人員／付款人編號、未分配人員與原因。使用者明確確認後，才沿原 `requestKey`、原 JSON 簽名及 `base_revision` 重試。原 scope、來源 fingerprint、所有 pending／done 快照與原內容保留；精確核對的快照才一起標記完成，未知請求仍阻擋相關新版編輯。

原包間協議沒有預覽憑證。新 `recovery_token` 僅綁定這次核對的帳號、原編號／完整內容及目前名冊與安排，不假裝原請求已有預覽證據，也不更換原 revision、房 ID、人員或付款人。核對後名稱、安排或權限變動即拒絕；過期原版本不自動改為最新版。原 editor 複製的 `payer_name`／`payer_label` 留在簽名內，但保存時只採目前正式名冊的姓名與標籤；未知欄位與結算專用欄位均拒絕。

新舊網站入口共用 `room-plan-command.ts`：發起者權限、原版本、活動／帳單限制、圈子分房來源檢查、Unicode 重名、有效付款人與人員、依正式名冊排序、款項引用的房 ID 保全、append-only 版本與 audit 均保持。安排沒有變更時不新增版本或 audit，只保存原回執。業務與原回執在同一 immediate transaction 完成；回執失敗會全部回滾。

已有相符原回執時，只核對目前存取權及發起者權限並保存本機完成紀錄，不再次分房，也不回傳凍結的私人活動內容。新回執使用原 reader 可按目前權限刷新活動的 `{id,starts_at}` marker。回應遺失或 IndexedDB 映射 abort 後，重新查原編號即可確認，不能換編號再寫。

前端在核對、hash 完成、送出與映射保存前後檢查 session／scope、裝置世代、原快照與頁面有效性。切帳號、登出、來源修改、世代變動與離頁均不能被當成恢復成功。

## 驗證

10 個 unit 檔案／92 個案例通過。其中新包間 adapter 14 個：原 Python 保存差分、名冊順序、原簽名／顯示欄位、no-op、真正 native UUID 回執衝突、並行去重、錯誤／私人回執、原版本與核對 token、權限與身份、取消／封存／草稿／既有帳單限制、Unicode 重名、退出／重複／外來人員、有款項房 ID、append-only 及回執失敗回滾。既有包間、結算、原款項恢復、音樂分房、HTTP 契約與計算資源案例亦通過。

7 個 browser 檔案／95 個案例通過，0 重試／跳過；既有 80 個案例的 ID、名稱與行列位置和第 200 號固定 CI 完全一致。新 15 個涵蓋兩種原包間 body、原編號與內容、核對不寫入、完成回執、回應遺失、映射 abort、fingerprint／來源／帳號／世代限制、原版衝突、編輯解除阻擋、未知請求保留、多份狀態快照、登出及 hash 期間離頁。360px 核對畫面人工檢視及無水平溢出檢查通過。

strict TypeScript、建置、`check:ui`、built smoke 通過。197 個請求與成功回應契約、319 個 schemas、153 個契約 inputs 與 71 個權限來源 pins 完整核對；兩個新操作仍標示 domain authorization 未完整驗收，發布 gates 不提升。13 份 compiled runtime 可獨立逐 byte 重現，API／音樂 worker inputs 193 個，擴充的 native runtime input union 135 個。新增共用 schema 匯出會改變包含 contracts 的生成 bundle；不能沿用前輪「其他後端 bundle 完全相同」的結論。

最終 compiled API 與固定原 Python bot `8da877857f163853c449474e168534e2e493121b` 的隔離組合通過：55 個確切原 blobs、71 次原 worker、9 次 compiled native consumer、314 深連結、532 HTTP 與 2 次限流延後，包含原操作去重、重試／不確定／模擬狀態及順序交接。沒有真實 QQ、正式資料或正式版本組合操作；這不是線上 bot 版本或全部 B01–B15 的驗收。

宣告 inventory 為 206 個 unit 檔案／3,795 個案例、84 個 browser 檔案／882 個案例；包含 CI 的既有公共 Umami client 條件案例，沒有移除原案例。這輪僅執行上述相關回歸，沒有宣稱此來源完整回歸已通過。

## 原 CI 與修正紀錄

第 202 號固定來源 `b65e9b92e136d7735ac69b0dbcdd761067697f3d` 的原 run `44953053188` 已完成：browser、image success；unit 3,770 passed／1 failed／0 skip，原失敗在 `music-compute-http.test.ts` 的 rooms saturation 第二個請求，耗時約 5 秒並回傳 503。保留原報告，不取消或重跑該 run。

該測試攔住 native Worker 的 message／exit 事件；thread 真正退出時，Node 可清除原接收函式，稍後重放 `emit` 無法交付原結果。修正僅改測試：保存真實事件當時的 raw listeners，刻意等到兩個 thread 退出且接收函式已清除，再交付原事件。人為暫停時僅凍結測試 timer 排程；既有 5 秒 deadline 的 clock-driven 驗證保留，正式 runtime、名額與逾時均未修改。修正後兩份計算資源 spec／9 個案例通過，未增加測試時限。原 CI 沒有保存第二個回應的完整 body，因此不把後續重現當成該次錯誤碼的完整證明。

前兩個測試修正嘗試錯把已回應與退出時序相連，造成 2 個及 1 個 30 秒 timeout；原失敗報告保留。新 adapter 初次 unit 的款項保全 fixture 缺少既有必要欄位，首次 browser 又使用已發布帳單的活動；均修正隔離 fixture，沒有放寬正式欄位或帳單限制。

證據目錄：`/Users/danersaka/.codex/rebuild-verification/legacy-rooms-204/`，含獨立核對程式、原失敗與最終報告、宣告 inventory、契約來源與 runtime pins、合成手機圖及舊 bot 組合紀錄。

166 個既有能力及 U01–U03 均保留，0 fully accepted，發布及權限完整性 gates 維持 false。其他原命令 adapters、完整來源與資料對帳、正式規模／多副本、QQ WebView、切換後實際 bot 版本組合及 P6／P7 驗收仍未完成，不部署。
