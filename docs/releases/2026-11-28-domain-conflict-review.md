# 音樂成分衝突核對補上領域程度

2026-11-28 10:26:30（台北）完成正式前端切換，10:27:07 完成公開 HTTP 核對。發布範圍：`web/frontend`。

保存成分遇到版本衝突後，「讀取最新版本」的已保存清單原本只顯示細分程度。此次讓領域、細分及已刪除詞條的備援名稱都顯示程度，使用選單共用的四檔標籤。本機草稿、最新資料及重試保存語意保持相同；API 原本保存所有詞條的 level，此次未修改 API、schema、outbox、設定或 bot 入口。

## 正式版本及組合

- 前端來源：`bb2c7ef032e312990ea2ffc06c18f7ee95d8eb47`，先合入並同步 git.dan.tw／GitHub main。
- PWA build ID：`1361c042e3fd6283a0d72e723b5ef63b07734f65f6471bdbc0925adec5511da7`。
- Manifest SHA-256：`bc5d2e8381d7ec77bd71838c79cfb17611060d22cf90cce3afaab7f1c74b1f63`。
- 封包 SHA-256：`77263bae6f848480fb48f12f9c4f1f68968ebe62a4ec216ae9108a982ef96659`。
- 正式目錄：`/opt/qgroup-frontend/releases/bb2c7ef032e312990ea2ffc06c18f7ee95d8eb47-bc5d2e8381d7ec77`。
- 前一版前端：`1908bafb8489974a091e66bdc1b0bbb1996d237d`，build ID `674e5f0fb367487aa4d590e815e0849f0303ef034d14f13adf01e3ba6d950407`。
- API 前後來源：`15cac112cbbbeff8b485857d785c018f432f2b1f`；前後映像 `sha256:49a3c4f071d8d648d26d01273100c490fac4f20e35900e2d13900062f2340920`。
- bot 前後來源：`7b0914ffd05b4418b9065932592d9bd5c33a71c7`；前後映像 `sha256:2b55e3d15df8035dbe5ed6334723c275f1e52061695c4ebc67edc09b369e8e00`。
- web 容器：`19aaeeb7eebea993550e11d147d496f44d2334fb8d4e336ac7cc8d5175f6f321`，啟動時間 `2026-11-27T16:28:22.265211883Z`。
- bot 容器：`9d3a349fa048df963eba1a2c8de4ea154bc9c5e28df61ee8a59a4a1bd5147e46`，啟動時間 `2026-11-25T16:30:45.90367263Z`。

兩容器 ID、映像、啟動時間及 restart count 前後相同，均健康、restart count 0。Runtime manifest 逐欄比較僅 frontend 區塊改動。schema 保持 15，沒有正式資料遷移或測試寫入。前端版本不冒用 API SHA。

## 驗證及保全

- `npm run build:frontend` 通過，包含 HTTP 契約及 TypeScript 檢查。
- 成分保存列、領域熟悉度及程度選單共 35 項瀏覽器測試通過；衝突案例覆蓋領域四檔遠端程度與 390／1440px，核對最新資料、保留本機程度及安全重試。
- 2026-11-28 10:13:25（台北）唯讀擷取正式 SQLite 一致性副本，保留刪除紀錄及圖片；範圍為 20 場活動、114 位報名者、62 個帳號。副本清除正式登入憑證及待送工作、停用通知與外部投遞，私人檔案不入版控。
- 完整 SHA 通過 `check_release_source.py`，只封存核准提交，在乾淨暫存目錄建置一次。實際 API 的後端輸入指紋相符。
- 正式前端產物搭配線上實際 API 映像，在本機 Docker 內部網路與受限資源下，以既有成分完成 390／1440px 兩項驗收：遠端衝突、最新領域及細分程度、本機草稿保留、保存、重載、還原及其他選擇不變。僅本機身份操作隔離副本，沒有啟動 bot。
- 傳輸後核對封包、manifest 及發布工具摘要，使用前端發布鎖切換 current。公開版本、健康、音樂／同好／活動入口及 worker 正常；21 個 shell 依賴摘要正確、immutable，前一版 21 個依賴仍可讀，shell／worker／版本保持 no-store。
- 本機演練容器、代理、網路及資料 volumes 已清除。此驗收沒有新增真實 QQ 投遞測試。

發布前後 runtime、封包、發布工具與切換紀錄保留於 server2 `/opt/qgroup-releases/domain-conflict-20261128/`。發布工具 SHA-256：`62654266c8befde0c7728d6028b7137762bdcaff0cd263375bc5963bd61dba1b`。

## 回退

回退目標為已保存的前一版 `1908bafb8489974a091e66bdc1b0bbb1996d237d-4663450c49551bc3`，manifest SHA-256 `4663450c49551bc37c8d6d22953bd25a2db023209a3ca67b66354cace0f7299c`。舊產物已核對與目前 API 相容；依[前端獨立發布流程](../frontend-release.md)切換並核對版本組合，不重建映像、不重啟服務、不還原業務資料。

歷史 M04 驗收曾錯寫「領域無程度編輯選單」；本次修正現行驗收條款及證據引用。舊驗收通過紀錄不能取代新版 UI 功能逐項審查。
