# 「我的」頁面與響應式修正發布

2026-11-28 09:55:05（Asia/Taipei）完成正式前端切換。發布範圍：`web/frontend`。

「我的」頁面改為總覽、活動草稿與設定入口；設定依帳號資料、偏好與隱私分組，保留所有設定功能、原網址與未保存修改的離頁保護。同時統一 768px 手機導覽斷點，修正 761–768px 的網站名稱及 dock 排列，並依實際保存提示高度預留詞條對話框底部空間，讓恢復草稿後的末端操作仍可使用。領域與細分均保留現有喜歡程度選單。

修改與驗證詳見[「我的」頁面整理](../unified-rebuild/me-layout-20261128.md)及[全站響應式審查](../unified-rebuild/responsive-layout-audit-20261128.md)。

## 正式版本

- 前端來源：`1908bafb8489974a091e66bdc1b0bbb1996d237d`，已先合入 main，git.dan.tw 與 GitHub main 完整 SHA 一致。
- PWA build ID：`674e5f0fb367487aa4d590e815e0849f0303ef034d14f13adf01e3ba6d950407`。
- Manifest SHA-256：`4663450c49551bc37c8d6d22953bd25a2db023209a3ca67b66354cace0f7299c`。
- 封包 SHA-256：`1ea8cf77944f5d1cd87ca3e7c4a7ef18c19f9e261ec2edb0942d3373d2ff489c`。
- 正式目錄：`/opt/qgroup-frontend/releases/1908bafb8489974a091e66bdc1b0bbb1996d237d-4663450c49551bc3`。
- 前一版前端：`029857b5b7f9b57f5341130209ff6f6e8a2e9e36`，build ID `838b7d05b63414200db74591ccadcf543d2aa3476de18fd2eaafb093f8a375ad`。
- API 來源保持 `15cac112cbbbeff8b485857d785c018f432f2b1f`，前後映像均為 `sha256:49a3c4f071d8d648d26d01273100c490fac4f20e35900e2d13900062f2340920`。
- bot 來源保持 `7b0914ffd05b4418b9065932592d9bd5c33a71c7`，前後映像均為 `sha256:2b55e3d15df8035dbe5ed6334723c275f1e52061695c4ebc67edc09b369e8e00`。
- web 容器 ID：`19aaeeb7eebea993550e11d147d496f44d2334fb8d4e336ac7cc8d5175f6f321`，啟動時間 `2026-11-27T16:28:22.265211883Z`。
- bot 容器 ID：`9d3a349fa048df963eba1a2c8de4ea154bc9c5e28df61ee8a59a4a1bd5147e46`，啟動時間 `2026-11-25T16:30:45.90367263Z`。

兩容器 ID、映像、啟動時間、健康狀態及 restart count 前後相同，均健康且 restart count 0。Runtime manifest 逐欄比較只有 frontend 區塊更新。API、bot、schema、outbox、網址契約及正式業務資料未改動；不重建映像或重啟服務。

## 驗證與切換

- 本機前端建置、型別及 HTTP 契約檢查通過；「我的」相關 67 項與響應式審查相關 42 項回歸案例分別通過。兩組覆蓋可能重疊，不合計為不同案例數。
- 全站審查完成 737 次頁面、162 次模式／內容斷點及 32 次短視窗覆蓋檢查；詳見審查紀錄。Android QQ／iOS 安全區屬桌面引擎模擬，未宣稱實機驗收。
- 發布前於 2026-11-28 09:46:49（Asia/Taipei）唯讀擷取最新一致性副本：20 個活動、114 筆報名、62 位使用者，包含詞庫、圖片與刪除紀錄。核對完整性、外鍵、圖片摘要及刪除紀錄一致性；清除正式憑證與待送工作，停用通知與外部投遞。副本、圖片、測試身份及畫面僅存忽略版控且限制權限的私人目錄。
- `frontend_release.py build` 以明確 SHA 執行 `check_release_source.py`，核准來源與實際 API 的後端輸入指紋一致；只封存核准提交，在乾淨暫存目錄建置正式檔案包一次。
- 正式檔案包搭配線上實際 API 的同一映像，在本機內部 Docker 網路、受限資源及隔離資料庫完成 6 項瀏覽器演練：390／768／769／1440px 的本人資料數字、7 個設定目的地、舊查詢網址及繼續／捨棄編輯；320px 訪客與瀏覽器簡中顯示；真實熱門詞條的恢復草稿與底部操作可見性。均通過，無頁面錯誤。演練只操作隔離資料與本機草稿，未啟動 bot。
- 演練前後活動、報名、成分選取與 outbox 摘要一致，schema 保持 15、待送工作 0；本機演練容器、代理、網路與資料 volumes 已清除。
- 上傳後核對封包、manifest 與核准來源發布工具摘要；驗證前一版完整產物仍與實際 API 相容。切換前再次核對 runtime、容器與 API，透過發布鎖一次切換 current。
- 公開前端版本、API 版本與健康、15 個頁面／worker／manifest 入口均通過唯讀 HTTP 檢查；新 shell 依賴摘要正確，舊 shell 依賴仍可讀，資源維持 immutable，shell／worker／版本維持 no-store。
- 正式公開站另完成 320／768／769／1440px 的「我的」及活動頁共 8 個瀏覽器案例，確認版本、導覽斷點、無水平溢出及無腳本錯誤。正式驗收只允許讀取請求。

發布前後 runtime、封包、切換及發布工具保留於 server2 `/opt/qgroup-releases/me-layout-20261128-1908baf/`。發布工具 SHA-256 為 `62654266c8befde0c7728d6028b7137762bdcaff0cd263375bc5963bd61dba1b`。

## 回退

回退目標為 `029857b5b7f9b57f5341130209ff6f6e8a2e9e36-edd5c1cfc53d3a3d`，manifest SHA-256 為 `edd5c1cfc53d3a3dbffcb98864af8868ea4a4a695b501318a18036edd21eb8bc`。完整舊產物已核對與目前 API 相容。需要時依[前端獨立發布流程](../frontend-release.md) activate 已保存目錄，核對版本組合；不重建映像、不重啟服務、不還原業務資料。
