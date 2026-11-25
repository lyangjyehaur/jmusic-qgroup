# 補齊新版簡繁顯示

2026-11-25 21:07（Asia/Taipei）完成。發布範圍 `web`（`frontend`）；API／bot 未建置、未重啟。此紀錄與 README 的更新屬 `none`，不另發布執行產物。

瀏覽器最高優先語言明確為簡體中文（如 `zh-CN`、`zh-SG`、`zh-Hans`）時顯示簡中；繁中、英文、日文、其他語言與未指定語言一律繁中。英文優先、簡中僅列為次選時仍顯示繁中。沿用既有 Accept-Language 品質與排序規則，不新增帳號語言偏好。

已補上日期星期、對話框關閉標籤、表單提示、複製結果、搜尋／管理選單、投票統計與恢復狀態標籤的轉換。固定活動類型與表單共用簡繁標籤；表單提交及資料庫仍使用原有代碼。姓名、活動標題、地點、詞條名稱、備註、輸入值與未知匯入值維持原文；沒有對使用者內容做整頁轉換。

## 實際版本

| 產物 | 來源 commit | 映像／manifest SHA256 |
| --- | --- | --- |
| 更新前 frontend | `459dade75de124453621ae3829067d024f304505` | `643d6a21bf8bc131da923c515d0f4f811101f674e0325d9001672c50b99fcc0d` |
| 日期／系統文案補齊，2026-11-25 20:42 | `0e73c31efdced221f378ca3e1b14d66768a71e9c` | `367bf215942ec2a9cf5ca8b635aebf86227473c8a0e66eeb4f1b68b4ff7e46aa` |
| 活動類型補齊，目前 frontend | `a381756ecea733e8c41537f52606ec392bb03350` | `2eef9e8e04e7b9611d7e663f65d32cd7d4efdc2ea65a3aa38b285141bddeba9d` |
| API，前後不變 | `b65e93b05eb8558f8c15d60eb15b2d0cc6cce4cc` | `sha256:c81f4ce7c90224314e0b6e1e9faeec370dd04a083a1306f690cf1985401bcf27` |
| bot，前後不變 | `54107b8a3c07444b1a3bd31188824bcfadaad4a8` | `sha256:2a7f4e9d9a9e1ed6cef6edc011ff366f0310f04509121c318d0abe891564c137` |

目前 PWA build ID：`8b6004ac0e5dccdc7cb05da2347d558695c1f714d340a2ff72157e1fd33b2df5`。前端封裝摘要：`fca553645dab3eb369e6dd88fbae35f70be40786c403dadf7c637c6e569f3e9d`。

## 發布與驗證

兩份前端來源均先合入 main、雙推並核對 git.dan.tw／GitHub 分支 SHA，再通過 `python3 deploy/check_release_source.py --commit <完整 SHA>`。只从核准提交的乾淨 archive 建置前端；後端輸入指紋與實際 API 來源相同。未變更 API、bot、共用 packages、schema、outbox、設定語意或網站入口。

38 項相關單元／整合檢查、20 項語言瀏覽器回歸、型別及前端建置通過。涵蓋簡中／繁中／英文／日文、離線提示、原始資料／草稿保全、簡中表單提交代碼，以及原 bot 投遞結果與分頁衝突恢復。最終核准檔案包另在隔離環境完成 4 項語言／離線瀏覽器驗收；與目前正式 API 實際映像搭配完成 271 項靜態 HTTP 檢查、35 項語言入口檢查及 worker precache 核對。沒有對真實 QQ 群送出驗收消息。

正式切換後核對 35 項本機入口、公開網址的 8 組語言與 18 份入口資源摘要；實際前端、API 版本與核准產物相符。公開反向代理以兩個 Vary 欄位保留 Accept-Encoding 和 Accept-Language，HTML 保持 no-store。獨立瀏覽器分頁確認繁中導覽、星期與「約 K」標籤正常，原使用者標題／地點保持原文。

web／bot 容器 ID、映像、啟動時間與 restart count 均保持不變，兩者 healthy、restart count 0。API 啟動時間 `2026-11-25T11:21:28.851437536Z`；bot 啟動時間 `2026-11-25T09:55:02.986769089Z`。部署前成套備份成功、備份 timer active。

## 資料與回退

無資料庫遷移、重匯或業務資料改寫，schema 維持既有版本 15。沿用正式資料庫、刪除權威、檢查點與圖片目錄。近期 3 場、往期 12 場，近期沒有已過預定結束時間的活動。

目前 `/opt/qgroup-frontend/current` 指向 `releases/a381756ecea733e8c41537f52606ec392bb03350-2eef9e8e04e7b961`，保留原有 immutable 資源。核准來源、原始檔案包、摘要與部署結果保存於 `/opt/qgroup-releases/language-20261125-a381756`；上一份文案修正保存於 `/opt/qgroup-releases/language-20261125-0e73c31`。

可按[前端独立發布](../frontend-release.md)以對應 manifest 摘要驗證後切回已保存前端，保留目前 API／bot，不還原業務資料庫。既有 PWA 仍透過保存草稿後更新的流程處理等待中的 worker，不強制啟用、不清除草稿。
