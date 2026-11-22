# 原建立活動請求與目前 bot 版本配合

2026-11-22。變更範圍 `web`；部署 `none`。在 `codex/unified-rebuild` 隔離實作，沒有合併 main 或正式切換。後續工作按[本機交付收斂清單](completion-status.md)進行。

## 本次行為

`/me/local-history` 支援原 `POST /api/events`：先檢查精確原請求結果，缺少回執時核對安排、建立方式、可見性、本人報名與群通知，再使用原方法／path／body／key 執行。保留 JS body fingerprint、Python sorted JSON signature、原 16-hex intent／任意原 key／無 intent 三種情況。原請求的 inactive reason 仍進入簽名，不轉成另一個業務欄位。

- 相符原回執返回 `committed`；以目前權限解析 draft／arrangements／view 入口。所有權轉交後仍可查看的活動可保存核對結果，已刪或無權查看則拒絕。
- 同一 intent 已有原／新版活動時返回 `existing`，不偽造原回執、不再建立。前端保存 `request-existing`，重新載入不宣稱原操作已提交。
- 缺少上述結果時只讀準備，沒有 trial event、invite ID、名冊、條件、audit 或 outbox 寫入。確認時重新檢查原值、稱呼、群政策與 review token。
- 草稿不发布安排、不建立本人報名或群通知；保留發起者發布時是否參加。直接發布依原規則建立條件，選擇參加時自動報名並接受第一版安排；未參加時允許報名截止已過，開始仍須在未來。邀請可見活動不能同步到公開群。
- 原 Python whitespace／Unicode 長度與 null timezone 保留，BOM 不被 JS trim 刪掉；未設定時區以 UTC 核對。未知／不支援欄位保留原紀錄並阻擋重送。

共用 `prepareActivityCreation`／`executeActivityCreation` 提供原命令、原生草稿及投票定案的同一建立流程。順序維持 access → 初始安排（已發布）→ created audit → 可選本人報名及 signup audit → 可選 bot hook。活動、名冊、consent、audit、原 201 marker `{id,starts_at}` 與獨立 canonical alias 在同一交易；required 寫入失敗整筆回滾，optional bot enqueue failure 不回滾已確認業務。

前端保留 scope／fingerprint／裝置世代／來源 CAS／登出／離頁／mapping abort 保護。恢復原請求不覆寫已帶入表單的後續編輯；活動原稿在 authoritative alias lookup 確認已建立後鎖定重建與欄位，原稿保留。所有新增文字均用於資料核對、權限、狀態或確認。

修正原活動／投票建立、投票管理與逐人結算恢復入口的 bot 預設值：與原生入口一樣，先沿用服務的 botEnabledDefault，再由明確的 activityBot 設定覆蓋。後台未保存 enabled 欄位時不再錯誤關閉通知；明確關閉仍優先。新增隔離案例涵蓋四種預設／覆蓋組合，核對原活動與投票的預覽、待送通知及原投票管理結果。修正前的測試失敗已保留。

## 目前線上基準與 bot

依使用者指示，只讀取得當前資料量和版本；原始姓名、身份、憑證、群設定與待送內容沒有納入 Git。45 個看板帳號、13 場活動、77 筆參加者、4 個時間投票；成分有 66 位會員、152 個詞條、681 筆選擇、單人最多 20 項。詳見收斂清單。

線上 bot 的映像 `sha256:e9d93c4441e2a34989722d7a5a86f87c8fa99cbc638b37cfe75a712fe6aa6720` 與來源 `07defc429d619a7558ab7218372886f531813ae3` 已取得，52 個公開 qgroup_core／qgroup_bot blobs 逐檔相符。它與較早測試基線 `8da877857f163853c449474e168534e2e493121b` 有五個既有公開 core 檔案不同；保留兩種固定基線，不能把較新來源直接稱為線上 bot。

新增 compiled activity pair 使用實際核對來源：8 個草稿／發布 × 公開／邀請 × 本人参加情境，2 筆本人報名、4 版初始安排、8 個原回執、4 個獨立 alias、8 個舊深連結；2 則公開發布通知由原 Python worker mock-confirmed，重播寫入 0。完整 retained pair 同樣使用目前來源，532 個 HTTP、71 次原 worker、9 次原生消費者、314 個深連結及 2 次限流延後，正常關閉。這些是隔離模擬，沒有真群投遞。

當前匿名選擇分布的 API 本機量測：搜尋 median 5.52 ms、同好 8.08 ms、圈子 275.93 ms、40 人分房 272.95 ms；5 次循序請求／項，末端 RSS 184.9 MiB、DB 寫入 0。沒有聲稱正式機資源、尖峰併發或完整資料遷移已驗收。

## 驗證記錄

證據目錄：`/Users/danersaka/.codex/rebuild-verification/legacy-activity-create-208/`。

- 新 adapter 34 個整合 unit，覆蓋原規則、固定 Python 全列／audit 差分、回執與 alias、權限、政策／稱呼變更、並發、required／optional failure 及上述通知預設值。較早 11 檔／200 案例通過；最終修正後連同逐人結算恢復，12 檔／217 個不同案例全部通過。
- 新 browser 有 18 個案例；既有瀏覽器的全部 931 個 ID／名稱／行列 tuple 保留。完整宣告為 88 檔／949 個案例；新增預設值案例後，完整 unit 預期為 210 檔／3,889 個展開案例。
- 完整本機 unit 已執行當時全部 210 檔／3,888 案例：3,882 直接通過，5 個 fixture 準備碰到預設 5 秒上限，1 個既有 HTTP path 測試仍寫死 201 operations。修正此 inventory scalar，使用 CI 同樣的 30 秒上限重跑 4 檔／150 案例全部通過；與最終 217 案例回歸合併後，完整 3,889 個不同案例都有通過證據。原完整失敗報告保留，不稱該單次 run 全部通過。
- 第一次 adoption fixture 填入了原 TSX 表單不存在的 join_owner，修正 fixture；下一輪揭露原稿 alias 查回沒有鎖定重建，補上前端狀態。隨後一次 browser 在新建置完成前啟動，trace 證實載入舊 hashed asset，已保存該失敗並在完整新建置後重跑。沒有自動 retry 或刪除失敗證據。
- Strict、建置、原 UI check、built smoke、13 個 runtime bundles 獨立 byte reproduction、205 個 HTTP operations／95 bodies／333 named schemas／91 boundary source pins／166 contract inputs 已通過；API input union 206、native union 140。
- 固定較新 Python 投票 pair 回歸仍通過；目前 bot source pair 亦通過。沒有變更 qgroup_core、qgroup_bot、資料庫 schema 或正式服務。
- CI 206 的 image／browser 通過，unit 3,832 通過／1 失敗：淺層 checkout 缺少原 Python differential 所需 Git tree。已為 unit job 明確 fetch 兩個 immutable 公開來源，並在獨立淺層倉庫驗證 fetch／archive／所有 blobs；不取消或重啟舊 CI。
- CI 207 已結束：image 通過，unit 3,852 通過／3 失敗（同一缺少 Git tree 影響兩個差分案例、HTTP inventory scalar 過時），browser 930 通過／1 失敗。瀏覽器失敗原因為截圖寫入固定 Mac 路徑，在 Linux 不存在；已改為專案內 test-results 路徑，保留原失敗記錄。上述修正納入本批來源，舊 CI 沒有取消或重啟。
- 完整 browser 實際執行 949 案例：948 通過／1 失敗，沒有 skip／retry。失敗為 music-matches 的截圖與 trace 寫入 ENOSPC；保留完整報告與仍可讀的 3-file trace。只清理先前隔離建置中三份可由 lockfile 重建的 node_modules，來源與歷史報告保留；沒有清除工作專案依賴。
- 上述完整 browser 完成後才修正通知預設值並重新建置。獨立比對 206 個 API inputs，只改變 app.ts；13 個 runtime bundles 只改變 api/start.mjs。原 bundle 與原 app.ts 留在私人驗證目錄，最終 bundle 重新完成 byte reproduction。前端程式沒有因通知預設值而改動。

較早新建置的相關 browser 回歸 5 檔／61 案例通過；與先前通過的未受影響案例合併，共 7 檔／108 個不同案例。最終修正後，原活動／投票／逐人結算恢復、原稿／建立識別及上述 music-matches 整檔的 9 檔／119 案例全部通過，沒有 skip／retry；與完整 run 的未受影響案例合併，949 個不同案例都有通過證據。結果及來源封存以同目錄的獨立 receipt 為準，不把修正前的完整 run 稱為最終來源單次全套通過。166 個既有功能與 U01–U03 完整接受數仍維持 0，release／permission completeness gates 為 false。這是本機實作進度，不是正式切換資格。
