# 2026-11-26 舊版本機草稿清除

發布範圍：`web`（`frontend`）。台北時間 2026-11-26 21:21:07 完成前端靜態切換，來源為已合入並雙推 main 的 `26d12074b3cb6f8c32e722c90e569d0e31fba932`。API、bot、schema、outbox、正式資料與設定不變；沒有重啟容器。

## 使用方式與範圍

舊草稿阻擋活動建立時，可直接點「清除舊版草稿，重新填寫」，舊看板本機紀錄頁也有相同操作。只清除此帳號在該瀏覽器的舊版草稿與對應保全副本，新版草稿與歷史版本、其他帳號、伺服器草稿、pending／done 原請求均保留。依儲存來源區分新舊，不以裝置時間判斷。操作前說明不可復原；清除失敗可以重試，重新整理後仍保留重試入口。

前端發布沒有自動清除任何用戶的草稿。實際清除需由持有資料的瀏覽器執行；沒有取得受影響用戶的本機原紀錄，也不宣稱已代刪。舊分頁的草稿不再自動匯入，明確匯入保全檔功能仍可使用。未核對的原請求繼續阻擋，避免重複建立活動或發群通知。詳細行為見[實作說明](../unified-rebuild/legacy-draft-cleanup.md)。

## 實際版本

| 產物 | 發布前 | 發布後 |
| --- | --- | --- |
| 前端 commit | `7bd0ce6103b92101c8df3412eb4c67258cfccec1` | `26d12074b3cb6f8c32e722c90e569d0e31fba932` |
| API／bot commit | `7b0914ffd05b4418b9065932592d9bd5c33a71c7` | 不變 |
| API／bot 實際 image ID | `sha256:2b55e3d15df8035dbe5ed6334723c275f1e52061695c4ebc67edc09b369e8e00` | 不變 |
| rebuild_schema／schema_migrations | 15／20 | 不變 |

| 容器 | 完整 ID（前後一致） | 啟動時間（前後一致） |
| --- | --- | --- |
| qgroup-unified-web-1 | `5524f53f6289c975eb5b5b25d326452100569936eb33fb3c03d80f6b31e094d1` | `2026-11-25T16:30:39.202136764Z` |
| qgroup-unified-bot-1 | `9d3a349fa048df963eba1a2c8de4ea154bc9c5e28df61ee8a59a4a1bd5147e46` | `2026-11-25T16:30:45.90367263Z` |

- release：`26d12074b3cb6f8c32e722c90e569d0e31fba932-f3c2959241a2faa3`。
- PWA build ID：`76e306f3397619fa5dd70dd34d114657d8aa408b9d5a3af486c1f6d1d6d3714f`。
- manifest SHA256：`f3c2959241a2faa30727c1ad6f05f30f21e5369dad5d23eb9983db69ce01a5e2`。
- archive SHA256：`bff7c808e75ee6c21973a28f478f1b0da1a572bbbc50208715a94059269bbb2e`。
- 正式暫存：`/opt/qgroup-releases/legacy-draft-cleanup-20261126-26d1207/`；本機私人證據：`artifacts/private/legacy-draft-cleanup-release-20261126/`，不納入 Git。

## 驗證

- `check_release_source.py` 通過完整來源 SHA，發布工具只封存該提交並在乾淨暫存目錄安裝、型別檢查及建置。來源與線上 API 的後端輸入指紋相同。雙遠端 main SHA 已核對。
- 確切發布產物的 72 項瀏覽器案例全部通過，包含清稿專項 8 項、舊紀錄／原活動請求恢復 32 項，以及簡繁與 PWA／precache。專項驗證其他帳號隔離、新版草稿與歷史版本逐位元保留、新版 pending 保留、來源／保全 transaction abort、重新整理後重試及舊分頁不復活。
- 早期測試 38／40 通過；調整清除進度與帳號切換預期後 39／40。後續兩個測試曾將按鈕改為「正在清除」提早當成完成，改為等待來源交易和實際結果。最終確切產物單次 72／72 通過，沒有 skip／retry；早期失敗不記為通過。
- 台北時間 20:23:47 取得 server2 最新一致性副本：17 場活動、100 筆名冊、56 個帳號。保留刪除紀錄並核對一致性、圖片雜湊、完整性與外鍵；清除正式憑證與待送工作、停用通知及外部投遞。只在本機副本的既有帳號登入驗證；舊稿 fixture 只存本機瀏覽器。清稿後能重新填寫，重新整理恢復新版草稿，390px 無橫向溢出、page error 0、伺服器 mutation 0。副本及圖片、身份與截圖只存忽略版控的私人目錄。
- 正式備份 `qgroup-backup.service` Result=success／ExecMainStatus=0。舊前端與目前 API 相容性、封裝傳輸摘要及新 manifest 均通過。
- 公開 HTTPS 的 12 組頁面／簡繁 shell、87 個資源摘要與快取標頭通過；舊 hash 資源仍可載入。前端／API 版本與兩套 schema 符合上表，runtime services、兩容器 ID／映像／啟動時間前後一致，healthy／restart count 0，bot 原生健康檢查退出碼 0。

沒有執行真實 QQ 投遞或正式業務測試寫入。既有 PWA 仍由使用者先保存新版草稿再確認更新，沒有強制啟用等待中的 worker。實體用戶瀏覽器的清除結果仍需用戶執行後確認。

## 回退

原前端 `7bd0ce6103b92101c8df3412eb4c67258cfccec1` 已保存並重新驗證與目前 API 相容。回退只切換靜態包，不能復原使用者已明確刪除的本機草稿，也不回寫資料庫。

```sh
python3 /opt/qgroup-releases/activity-create-20261126-7b0914f/frontend_release.py activate \
  --artifact /opt/qgroup-frontend/releases/7bd0ce6103b92101c8df3412eb4c67258cfccec1-3b8a7935517aba3d \
  --root /opt/qgroup-frontend \
  --api-commit 7b0914ffd05b4418b9065932592d9bd5c33a71c7 \
  --manifest-sha256 3b8a7935517aba3dccbf0d59fb2d0c5a142af8794632eb0643ad35beabf90cca \
  --api-url http://127.0.0.1:8791 \
  --release-manifest /opt/qgroup/release-manifest.json
```

已核准工具 SHA256：`62654266c8befde0c7728d6028b7137762bdcaff0cd263375bc5963bd61dba1b`。回退前再次核對 API、映像及資料相容性，不能追隨移動中的分支或標籤。
