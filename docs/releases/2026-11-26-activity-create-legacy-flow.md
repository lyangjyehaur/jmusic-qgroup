# 2026-11-26 活動直接發布與舊版時間操作

發布範圍：`both`（web frontend／API 與 bot）。台北時間 00:30 切換完成；API、前端、bot 均使用已整合遠端 main 的 `7b0914ffd05b4418b9065932592d9bd5c33a71c7`。

新增活動的主操作直接發布，草稿另存。常用欄位留在主表單，容量、截止、退出、可見性、時區與費用規則收進進階設定。沿用舊版日期／時間／1–24 小時時長、類別預設時長、倒數與凌晨／跨日核對；群推送預設勾選。新活動報名截止預設跟隨活動結束，可手動提前；活動進行中可報名、候補遞補和暫停後恢復。既有活動沒有批量改截止時間。完整行為及恢復規則見[變更說明](../unified-rebuild/activity-create-legacy-flow.md)。

| 產物 | 發布前來源 | 發布後來源／實際映像 |
| --- | --- | --- |
| API | `b65e93b05eb8558f8c15d60eb15b2d0cc6cce4cc`；`sha256:c81f4ce7c90224314e0b6e1e9faeec370dd04a083a1306f690cf1985401bcf27` | `7b0914ffd05b4418b9065932592d9bd5c33a71c7`；`sha256:2b55e3d15df8035dbe5ed6334723c275f1e52061695c4ebc67edc09b369e8e00` |
| bot | `515ec4c4938f5111b9bd61f046f7d9106d453104`；`sha256:7ce6a3bfcf55e54813f757c6a3bb390bfd96894acf1aa27a9c4503d777b5789b` | 同 API 本次來源與映像 |
| 前端 | `a381756ecea733e8c41537f52606ec392bb03350` | `7b0914ffd05b4418b9065932592d9bd5c33a71c7` |

正式 API 容器 `5524f53f6289c975eb5b5b25d326452100569936eb33fb3c03d80f6b31e094d1`，啟動於 `2026-11-25T16:30:39.202136764Z`；bot 容器 `9d3a349fa048df963eba1a2c8de4ea154bc9c5e28df61ee8a59a4a1bd5147e46`，啟動於 `2026-11-25T16:30:45.90367263Z`。兩邊健康、restart count 0，bot 已取得本次啟動後的新心跳、poll，gateway 與 policy resolved 正常。

獨立前端 release 為 `7b0914ffd05b4418b9065932592d9bd5c33a71c7-92cc2632a56f08ed`；build ID `53de938ac8847bb3be7783e5746e443bd005b1591dc8d0d25aa06202eb101f63`；manifest SHA256 `92cc2632a56f08ed99d7ab082e11431d25829a305c4bbf68869e93df04dcd56d`。前端仍使用 `/opt/qgroup-frontend`，保留舊 assets 和歷史檔案包；後續純前端修改仍可獨立發布。本次包含後端與 bot 行為修改，不能只替换靜態檔案。

驗證與保全：

- 305 項活動、契約、bot 測試通過；63 項相關瀏覽器案例完成驗證，首次三項失敗修復後重驗通過。直接發布、凌晨與跨年、手動截止與恢復連動、舊稿時區／秒數、草稿競態、跨帳號及待確認操作均涵蓋。
- 建置 API／bot runtime、原生 HTTP／WebSocket、ACK／Resume、公開回覆、縮寫、模擬／不確定投遞與 SIGTERM smoke 通過。手機檢查修正回頂懸浮按鈕遮住發布的問題。
- 固定 SHA 經 `deploy/check_release_source.py` 核准，以乾淨 archive 本機建置 linux/amd64 映像。使用 BuildKit 內建 frontend，僅移除外部 syntax directive，保留原 Dockerfile 與相同 ignore 摘要。兩個遠端 main SHA 核對一致。
- 候選與線上 API 的 database bundle 只有 `CreateActivityDraft` 新增可選發布旗標的差異；其餘位元組相同，schema 和資料操作不變。實際候選映像使用線上 API database bundle完成 native bot smoke；隔離 API 行為 smoke 驗證直接發布、冪等、本人同意、單一 outbox、活動中報名及新版 bot 狀態文字。API 行為 harness 使用隔離 test mode；正式 production 設定另由 actual runtime Compose checker 驗證。禁止外部網路，沒有真實 QQ 測試投遞。
- 初次產物驗證把 saved config digest 與 runtime OCI image ID 混用，在改服務前被拒絕；核對本機與正式機實際 OCI image ID 一致後修正。第一次服務切換受前端 API commit 鎖定擋住，API 未健康，依預案恢復原版本及前端包；原服務恢復健康。調整切換次序：先停 bot／web，再切前端、啟动 API，核對健康後啟動 bot。本次最终成功；失敗過程與回退保留私人紀錄。
- 延續正式資料，schema 維持 15，沒有資料庫遷移、outbox／憑證／群設定修改或待送重播。切換前等待無 sending 工作，使用單一 bot；資料庫沒有回寫舊備份。
- 切換前後 paired backup 成功，backup timer 維持 active；既有 erasure authority、checkpoint、runtime.env 和 Compose／frontend override 路徑保留。兩服務实际版本與前端包寫入 `/opt/qgroup/release-manifest.json`。
- 公開 HTTPS `/api/v2/version`、health、前端版本與新增活動 shell／bundle 摘要一致；沒有對正式活動發測試發布。

回退使用表中的原 API／bot 映像及原前端包 `a381756ecea733e8c41537f52606ec392bb03350-2eef9e8e04e7b961`。先停 bot 和 web、切回原前端，再按原映像啟動 API，核對版本與健康後啟動單一 bot，核對新心跳並更新 manifest。schema 相容、保留新寫入與通知狀態，不覆蓋資料庫；舊程式的開始後不開放報名行為會恢復。前端 manifest 有 API commit 鎖定，不能先啟動原 API 再切前端。

產物及私人證據：正式 `/opt/qgroup-releases/activity-create-20261126-7b0914f`；本機 `artifacts/private/activity-create-release-20261126/`。重型全量重構套件曾受並行超時影響而中止；本紀錄不宣稱該次全量試跑通過。正式 QQ 新活動通知未做真送驗收，模擬／隔離結果不視為實際群投遞。
