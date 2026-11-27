# 領域熟悉度前端發布

2026-11-27 22:56:44（台北）完成正式切換，23:09 完成公開 HTTP 與容器核對。發布範圍：`web/frontend`。

恢復領域四檔熟悉度選單，保留原有程度；成分卡、雙方比較、推薦卡、活動名單成分、管理成分及分享圖片均顯示領域程度。既有 API、匹配公式、排序、schema、bot、設定與 outbox 未變。[修改及驗證紀錄](../unified-rebuild/domain-familiarity-restoration.md)。

## 正式版本

- 前端來源：`000bcbee4a9935442756276e2e008c3bc72d569e`；已整合並同步 git.dan.tw 與 GitHub main。
- 前端 build ID：`9f227c118223c587d4b2aa6a607aa1bfc55adeee691897ce0f8ead418c29ec49`。
- Manifest SHA-256：`7582e14b81d25ced5ba3cf096fb13d86f8a1d4373dafc47367439d4c2d4229af`。
- 傳輸封包 SHA-256：`f6aed57c0546b516e94619bcf8dfe1ec56df0a6eb3056cae92934ceef4c216b9`。
- 正式目錄：`/opt/qgroup-frontend/releases/000bcbee4a9935442756276e2e008c3bc72d569e-7582e14b81d25ced`。
- API 來源保持 `ad2d8fca10f1750e849faba2d9499d8e20f7d79c`，映像保持 `sha256:00badfae8a607b148b3c0c396a80a396f42c5041938d8303849489f007d460e3`。
- bot 來源保持 `7b0914ffd05b4418b9065932592d9bd5c33a71c7`，映像保持 `sha256:2b55e3d15df8035dbe5ed6334723c275f1e52061695c4ebc67edc09b369e8e00`。
- web 容器 ID 保持 `1ea7dc3eace2853aa94cc0d7f05e17b76f387a599346ac81aa08568d9d05ec2a`，啟動時間保持 `2026-11-27T05:40:25.995482268Z`。
- bot 容器 ID 保持 `9d3a349fa048df963eba1a2c8de4ea154bc9c5e28df61ee8a59a4a1bd5147e46`，啟動時間保持 `2026-11-25T16:30:45.90367263Z`。

兩容器健康、restart count 均為 0。正式 release manifest 逐欄比較只有 frontend 區塊改動。統一版 schema 保持 15，未執行資料遷移或正式資料寫入。

## 驗證與保全

從完整 SHA 執行 `deploy/frontend_release.py build`，工具通過 `check_release_source.py`、核對前端來源與實際 API 的後端輸入指紋，在乾淨 archive 目錄建置一次。傳輸前後核對封包、manifest 及發布工具摘要；以核准來源的工具在發布鎖內切換 current。

2026-11-27 22:05:49（台北）從正式環境唯讀擷取最新一致性副本，保留刪除紀錄、清除正式登入憑證及待送工作、停用群通知與投遞。使用實際線上 API 映像，在本機內部 Docker 網路掛載本次正式前端封包，未啟動 bot。390px／1440px 兩項驗收通過：五筆真實領域原值、修改單筆、保存、重載、詞條詳情及還原；其他選擇逐筆相同，PWA build ID 與 worker 一致。所有副本、測試身份與圖片僅存私人目錄。

正式公開 `/frontend-version.json`、`/api/v2/version`、`/me/music`、詞條深連結、`/people`、`/activities`、`/sw.js` 均正常，新 build ID 一致；shell／版本／worker 為 no-store，20 個首頁依賴資源均可讀且維持 immutable。正式環境只進行唯讀核對，沒有以真實成分保存或 QQ 發送作驗收。

發布前後紀錄及封包保留於 server2 的 `/opt/qgroup-releases/domain-familiarity-20261127-000bcbe/`。回退目標為 `ad2d8fca10f1750e849faba2d9499d8e20f7d79c-827bd9e6068030a0`，manifest SHA-256 為 `827bd9e6068030a0ca95416028ccf12359f418ed2c8df93fd404cbeecb89364c`；已用同一 verify 工具核對與目前 API 相容。需要回退時依前端獨立發布流程 activate 已保存目錄，不重建映像、不重啟服務、不回退業務資料。
