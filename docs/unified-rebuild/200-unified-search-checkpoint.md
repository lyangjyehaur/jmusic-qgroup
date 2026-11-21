# 全站搜尋與共用成分工作區

日期：2026-11-22（Asia/Taipei）。變更範圍：`web`；實際部署：`none`。新唯讀 API 與 React／TSX 搜尋入口，不改 schema、outbox、設定、現有 bot 指令或網址。未整合 main，保留 Python bot；實際線上版本組合仍是發布前門檻。

## 單一搜尋動線

共用導覽進入 `/search`，依活動、音樂詞條、同好分組。全部結果每組最多 10 筆，分類頁可繼續翻頁；搜尋條件放在 URL，返回詳情或瀏覽器 Back 恢復原查詢、分類及頁碼。詞條、同好、成分比較與活動詳情使用經驗證的本機搜尋返回路徑，不接受外部或含歧義的目的地。

搜尋與音樂列表、詞條、趨勢、成分編輯和分享共用同一個選擇控制器。搜尋→詞條→選取→返回搜尋→詞條→成分編輯不會丟失未保存選擇或要求額外離開確認；離開工作區的草稿保全仍使用既有機制，不自動保存成分。初版瀏覽器案例抓到返回搜尋會觸發工作區離開提示，已修正路由範圍，原失敗 trace 保留。

界面只保留頁名、欄位、分類、結果與必要提示。未登入者和沒有保存成分的會員分別看到登入／建立成分入口，不把資格不足顯示成空同好結果；來源失敗顯示錯誤及重試，不替換成成功空列表。五種寬度的實際截圖已檢查，長名稱可換行；分類與搜尋入口有至少 44px 點擊範圍。

## 權限、資料與契約

`GET /api/v2/search` 要求目前裝置 scope，每次依現有活動詳情權限檢查公開、私人與草稿資料及結果總數。管理身份不提供活動邀請或草稿職責例外。同好姓名只在目前保存成分資格確認後讀取，沿用目前成分稱呼與活躍身份投影；解除帳號關聯不移除成分，隱私刪除則排除該成分。

詞條沿用拼音、首字母、假名、全半形及別名規則。同好一般搜尋不比對聯絡 QQ、身份值、私人留言或性別；既有具資格的聯絡查詢入口保留。回應只含活動摘要、詞條名稱／分類及同好 ID／稱呼。讀取在單一交易快照執行，全表快照驗證無寫入，bot 投遞與設定狀態保留。

新增 `SearchQuery`／`SearchResults` 與固定 HTTP 回應綁定，拒絕重複、未知、空白或超界條件。195 個操作、85 個 body、48 個 query、188 個 JSON／6 個 image／1 個 download，317 個命名 schema、445 個 OpenAPI component。147 個來源 inputs 與 60 個權限 pins 已核對，原 194 個操作的請求／回應及權限邊界語意保持相同。`permissionBindingsComplete`、`openapiComplete` 與 `releaseEligible` 仍為 false。

## 隔離驗證

- 8 個 unit 檔案／84 個案例通過，其中新增 28 個 API 案例及 1 個返回路徑案例；另 1 個 HTTP 路由回歸檔案／29 個案例通過，兩次執行合計 9 檔／113 個案例。涵蓋 10 種身份、撤權、私人欄位排除、23 筆真實分頁資料、拼音／假名／別名、非法輸入、實際損壞來源及全表保全。完整宣告 inventory 為 200 檔／3,746 個案例，未把宣告數量當成通過結果。
- 6 個 browser 檔案／49 個案例通過，0 重試／跳過；13 個新搜尋案例與 36 個原工作區、詞條、載入及 PWA 案例。原案例 ID／位置與固定 inventory 一致。新的完整 browser inventory 為 82 檔／857 個案例，本輪沒有宣稱全套 browser 通過。
- strict TypeScript、重構建置與建置後 smoke 通過；固定 runtime 4 個 bundle 重現一致，API／native 來源分別為 186／108 個 inputs。新的 PWA precache 為 85 個資源／1,786,204 bytes，所有 bytes／hash 核對，既有更新與離線隔離回歸通過。
- 新 API 與原 Python bot 提交 `8da877857f163853c449474e168534e2e493121b` 的隔離組合通過。獨立 oracle 核對 55 個原 Python blobs、71 次原 worker、9 次 native consumer、314 個深連結、532 次 HTTP（含 2 次限流延後），以及通知、投遞重試、未知結果、模擬保全與順序交接。來源 harness 與 API／native bundle pins 一致；沒有真實 QQ transport，也不是實際線上 image 組合或完整 B01–B15 驗收。

證據保存在本機 `unified-search-200/`，包含固定 inventory、獨立 unit／browser／契約／Python oracle、初始失敗報告、原 trace 及五種寬度 PNG。新增[整合需求台帳](integration-status.json)分別追蹤 U01 全站搜尋、U02 正式採用分房、U03 圈子 UI，發布資格檢查同時核對這三項與原 166 個能力，沒有以新入口替代舊功能驗收。

首次完整 unit 使用 Vitest 預設並行／5 秒設定，結果 3,597 通過、138 失敗、11 跳過；133 個失敗為逾時，其餘包含原 fixture 來源核對失敗及新增操作後漏改的 194 總數預期。已修正總數為 195，29 個路由案例通過，原案例名稱與覆蓋保留。依既有 CI 的 `--maxWorkers=1 --testTimeout=30000` 完整重驗後，200 檔／3,746 個案例全部通過，0 失敗／跳過，結果與獨立固定 inventory 逐項一致。首次失敗報告保留，沒有移除任何案例或修改業務斷言。

## 198／199 原完整 CI 核對

原 198 提交 `fa4795a6fdc9a8fb82dd41ec75eaaabc61e77734`／CI `44932165086`，以及原 199 提交 `7efca077375ecff185cb3585890944ef5055437c`／CI `44935056257`，三個工作與所有步驟皆 success。原 unit 分別為 197 檔／3,639 個案例與 198 檔／3,717 個案例；各自的 81 檔／844 個 browser 案例一次通過，0 重試／跳過。原 ZIP 的 API digest、大小、CRC 與解包 hashes 核對完成；固定 inventory、145 個契約來源 inputs／54 個權限 pins，以及原 84 個 PWA 資源／1,777,913 bytes 相符。

原 198 image 組合為 web `sha256:fe646aeb3abf8ef432aafbced0c22bd420b2cbe40f67154dd7aadebc57ed25b2`、Python `sha256:cfcc8105a737d5c6ac14346bc8ee0a6573ef0def9f211dd16e492177ea2bfe7c`；原 199 為 web `sha256:a10b9de6779509f90c48f7f89b853f7cbcca35f5e7a46dd7f02dc0a2f279e212`、Python `sha256:91981425b006c3ca561af55126913c037795e59a64a73d0274161c582ae036fe`。兩輪 browser／image 的原 Python blobs、隔離投遞、重試、未知結果、模擬及順序交接均經獨立 oracle 核對；199 image 為 531 次 HTTP／1 次限流延後，其餘三份組合報告各 532 次／2 次延後。

從兩個明確提交的七個 public harness／配置 blobs 重建最小 context，重新生成 Python image source manifest 與 bot harness；184 個 API／107 個 native inputs 逐一確認與已獨立重現的 196 bundles 相同，依賴鎖定與建置設定亦相同，並核對原 bundle digests。沒有重建 image、取消或重跑原 CI。證據分別保存在 `room-permissions-198/` 與 `shout-permissions-199/`。這些原隔離組合仍不是線上 bot 的實際版本或完整 B01–B15 驗收。

U01–U03 保持實作中；166 項既有能力仍為 0 fully accepted，發布資格為 false。完整候選版本驗收、正式規模與併發資源、完整來源對帳、QQ WebView、實際 bot 版本組合及 B01–B15 仍待完成。依使用者要求，繼續實作與驗收，不部署。
