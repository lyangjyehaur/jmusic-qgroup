# 音樂頁領域勾選程度修正

2026-11-28 00:54:52（台北）完成正式前端切換，00:55:17 完成公開 HTTP 核對。發布範圍：`web/frontend`。

修正音樂頁勾選領域沒有開啟熟悉度選單的遺漏。領域與細分現在共用四檔選單，涵蓋詞庫、快速加入、詞條詳情及同好推薦快捷按鈕；再點已選領域調整程度，詞庫按鈕顯示目前程度，移除使用選單底部或已選清單。關閉新增詞條的選單仍保留常聽預設，保存後才同步。API 原本支援所有詞條的 `level`，此次未修改 API、schema、匹配、設定、outbox 或 bot 入口。[修改及驗證紀錄](../unified-rebuild/domain-familiarity-restoration.md)。

## 正式版本

- 前端來源：`029857b5b7f9b57f5341130209ff6f6e8a2e9e36`，已先合入並同步 git.dan.tw／GitHub main。
- PWA build ID：`838b7d05b63414200db74591ccadcf543d2aa3476de18fd2eaafb093f8a375ad`。
- Manifest SHA-256：`edd5c1cfc53d3a3dbffcb98864af8868ea4a4a695b501318a18036edd21eb8bc`。
- 封包 SHA-256：`4d0e2f52a91a886c7b877fe4c32acd84e0ab4895fdc7d0ded52e5bce4a908595`。
- 正式目錄：`/opt/qgroup-frontend/releases/029857b5b7f9b57f5341130209ff6f6e8a2e9e36-edd5c1cfc53d3a3d`。
- 前一版前端：`15cac112cbbbeff8b485857d785c018f432f2b1f`，build ID `05a7f868beefc614d387b3f652bd32be37c1741ee0fc1d637612db12f62c43c4`。
- 相容 API：`15cac112cbbbeff8b485857d785c018f432f2b1f`；前後映像均為 `sha256:49a3c4f071d8d648d26d01273100c490fac4f20e35900e2d13900062f2340920`。
- bot：`7b0914ffd05b4418b9065932592d9bd5c33a71c7`；前後映像均為 `sha256:2b55e3d15df8035dbe5ed6334723c275f1e52061695c4ebc67edc09b369e8e00`。
- web 容器：`19aaeeb7eebea993550e11d147d496f44d2334fb8d4e336ac7cc8d5175f6f321`，啟動時間 `2026-11-27T16:28:22.265211883Z`。
- bot 容器：`9d3a349fa048df963eba1a2c8de4ea154bc9c5e28df61ee8a59a4a1bd5147e46`，啟動時間 `2026-11-25T16:30:45.90367263Z`。

兩容器 ID、映像、啟動時間、健康狀態和 restart count 前後相同，均健康、restart count 0。Runtime manifest 逐欄比較僅 frontend 區塊改動；API 來源沒有冒用前端 SHA。schema 保持 15，未遷移資料或寫入正式成分。

## 驗證與發布

- `npm run build:frontend`、HTTP 契約核對與 TypeScript 型別檢查通過。
- 程度選單、領域恢復、詞庫排行、工作區、同好匹配與直接頁面共 54 項瀏覽器回歸通過。包含領域勾選的四個選項、預設關閉、再點調整、移除、保存重載、推薦快捷操作、巢狀詳情焦點及 5／15 上限；修正舊測試仍預期領域直接選取的流程。
- 2026-11-28 00:42:28（台北）唯讀擷取正式 SQLite 最新一致性副本及刪除紀錄。完整性 `ok`、外鍵錯誤 0；副本有 59 份領域成分、163 筆領域選擇，程度 1／2／3／4 分別為 1／7／150／5 筆。清除正式登入憑證、待送工作及執行狀態，停用群通知與外部投遞；副本和圖片僅存忽略版控的私人目錄。
- 明確 SHA 通過 `check_release_source.py`，與實際 API 的後端輸入指紋相同；只封存核准提交，在乾淨暫存目錄建置正式前端包一次。
- 該正式產物搭配線上實際 API 映像，在本機 Docker 內部網路、隔離資料庫及受限資源下完成 390px／1440px 兩項驗收：音樂頁點已選領域、移除後重新勾選、預設關閉、逐一四檔切換、保存重載與還原；其他選擇完整相同，PWA／worker build ID 一致。僅本機測試身份寫入副本，未啟動 bot。
- 傳輸後核對封包、manifest 與核准來源發布工具摘要；切換前再次核對正式 runtime 和容器，使用前端發布鎖切換 current。
- 公開 `/frontend-version.json`、API 版本／健康、音樂頁、成分頁、詞條深連結、同好頁、活動頁及 worker 均正常。shell／worker／版本為 no-store；21 個新 shell 依賴摘要正確、維持 immutable，21 個前一版依賴仍可讀。
- 本機演練容器、代理、網路與資料 volumes 已清除。正式環境僅切換前端檔案和版本紀錄，驗收只使用唯讀請求。

發布前後 runtime、封包、發布工具和切換紀錄保留於 server2 `/opt/qgroup-releases/domain-picker-20261128-029857b/`。發布工具 SHA-256：`62654266c8befde0c7728d6028b7137762bdcaff0cd263375bc5963bd61dba1b`。

## 回退

回退目標為前一版 `15cac112cbbbeff8b485857d785c018f432f2b1f-fcb90e0e4446d017`，manifest SHA-256 `fcb90e0e4446d0176232917800be9f7ea14798d23de8b366d1e6f5c2c442131f`；完整舊產物已用同一 verify 工具核對與目前 API 相容。需要時依[前端獨立發布流程](../frontend-release.md) activate 已保存目錄並核對版本組合，不重建映像、不重啟服務、不還原業務資料。
