# 2026-11-27 參加紀錄介面與返回流程

發布範圍：`web`（`frontend`）。台北時間 2026-11-27 01:46:54 完成靜態包切換。來源為已合入 main、雙遠端 SHA 核對一致的 `2e900492239bb01ef2c61fc026bb12746a598e94`。API、bot 的映像、容器 ID、啟動時間與設定不變，沒有重啟或資料遷移。

## 介面與行為

- 移除參與統計上方的長說明，統計規則仍保留於使用手冊。手機日期顯示「最近參加：」，日期本身不斷行。
- 列表的「紀錄」改為右箭頭圖示，保留可及性名稱與 44×44 點擊範圍。紀錄視窗移除底部重複的「返回統計」，保留右上角關閉圖示與 Esc。
- 從整體或本人的參加紀錄進入活動詳情，左上角顯示「返回參加紀錄」。回去後恢復同一人的紀錄、期間、類型、列表頁碼及紀錄頁碼；重新整理或切換活動內容／結算頁籤後仍保留來源。返回目標只接受本網站兩個參與統計入口。
- 原活動詳情深連結沒有紀錄來源時，仍顯示「所有活動」。正式報名次數、未成團判斷、權限及 API 契約維持[上一版](2026-11-27-participation-statistics.md)。

## 實際版本

| 產物 | 發布前 | 發布後 |
| --- | --- | --- |
| 前端 commit | `4ef5ff8fc6801434ba9f01c68b1b0285ec7240ed` | `2e900492239bb01ef2c61fc026bb12746a598e94` |
| API commit | `4ef5ff8fc6801434ba9f01c68b1b0285ec7240ed` | 不變 |
| API image ID | `sha256:3021adaf924515cc73b129125f82623089f5bc8e33daf2796e9fc3a45ae1d9fa` | 不變 |
| bot commit | `7b0914ffd05b4418b9065932592d9bd5c33a71c7` | 不變 |
| bot image ID | `sha256:2b55e3d15df8035dbe5ed6334723c275f1e52061695c4ebc67edc09b369e8e00` | 不變 |
| rebuild_schema／schema_migrations | 15／20 | 不變 |

- API 容器 `86d1d5d3d2575383147bf1b9d5a6d25cd3f0ec5b965ca31971996cb2245ec0a4`，StartedAt `2026-11-26T16:06:17.146240018Z`。
- bot 容器 `9d3a349fa048df963eba1a2c8de4ea154bc9c5e28df61ee8a59a4a1bd5147e46`，StartedAt `2026-11-25T16:30:45.90367263Z`。
- frontend release：`2e900492239bb01ef2c61fc026bb12746a598e94-f087c7f59be9af45`。
- PWA build ID：`c3dc9e36644e11b14107421d607d5a2877928ceeb44ca68e201a45ac69b1273e`。
- manifest SHA256：`f087c7f59be9af45907545e87ad7a51a3945d0a4f0d68760dc0c4f240a524ca5`。
- archive SHA256：`c15eeabbca136901e1fd2dce9aa424215692c0928245fd995f47c502abb27042`。
- 正式暫存：`/opt/qgroup-releases/participation-ui-20261127-2e90049/`。本機證據在忽略版控的 `artifacts/private/participation-ui-release-20261127/`。

## 驗證與保全

- 完整 SHA 的 `check_release_source.py` 通過；`frontend_release.py build` 只封存該提交，在乾淨暫存目錄安裝、型別檢查及建置。候選來源與實際 API 提交的後端輸入指紋相同，沒有改動 bot 依賴的入口或共用語意。
- 確切靜態發布包搭配相同 API 原始碼與隔離線上資料副本，4 項瀏覽器驗收全部通過，沒有 skip／retry。副本擷取於台北時間 2026-11-27 00:52:32，含 18 場活動、106 筆報名、56 個帳號；憑證及待送工作已清除，通知停用，業務寫入一律拒絕。驗證手機／桌面紀錄操作、重新整理後返回、篩選及列表／紀錄頁碼、本人紀錄、序號／頭像、未成團篩選與原活動直接入口。
- 既有 fixture 測試的關閉按鈕及連結預期同步更新；本次效果驗收使用實際資料副本，未執行 fixture 效果驗收。
- 發布鎖內保存舊前端指標、activation receipt 與 runtime manifest，確認舊靜態包仍與線上 API 相容，執行成套備份。complete marker 為 `/var/backups/qgroup-unified/kanban-20261126-174653-320152.complete.json`，SHA256 `82bc1c71947f2536bd67fc41c88d1d28a0363269333593855e3502386b722183`。備份服務 success／退出碼 0，timer active。
- 以已核准發布工具核對封裝與 manifest 摘要、檔案及實際 API 版本，再原子切換 `current`。runtime manifest 僅更新 `frontend`；兩個服務的完整紀錄及其餘欄位保持不變。
- 公開 HTTPS 的 12 組簡繁／統計／原 bot 深連結 shell、90 個原始資源摘要與快取標頭通過；前端版本、build ID、API 版本正確，前端版本與 shell／worker 使用 no-store，舊 hash 資源仍可載入。
- 實際線上瀏覽器確認長說明已移除、手機日期標籤、右箭頭與 44×44 點擊範圍；可開啟紀錄、從活動詳情重新整理後回到原紀錄、關閉後返回原列表。沒有正式業務寫入或真實 QQ 測試投遞。
- API／bot healthy、restart count 0，bot 原生健康檢查通過。既有 PWA 保存草稿後更新流程保留，沒有強制啟用等待中的 worker 或清除使用者草稿。

## 回退

上一版前端 `4ef5ff8fc6801434ba9f01c68b1b0285ec7240ed-058530da2ddebb2a` 已保存並驗證與現行 API 相容。本次沒有觸發回退。回退只切換靜態包，不重啟服務、不回寫資料庫；先取得同一發布鎖，核對當時 API／bot／資料相容性，再執行：

```sh
python3 /opt/qgroup-releases/participation-20261126-4ef5ff8/frontend_release.py activate \
  --artifact /opt/qgroup-frontend/releases/4ef5ff8fc6801434ba9f01c68b1b0285ec7240ed-058530da2ddebb2a \
  --root /opt/qgroup-frontend \
  --api-commit 4ef5ff8fc6801434ba9f01c68b1b0285ec7240ed \
  --manifest-sha256 058530da2ddebb2a42d81d0471e29ccda32b3cf248703a580da5fb309f8f46fc \
  --api-url http://127.0.0.1:8791 \
  --release-manifest /opt/qgroup/release-manifest.json
```

發布／回退工具 SHA256：`62654266c8befde0c7728d6028b7137762bdcaff0cd263375bc5963bd61dba1b`。切換後再次核對前端、API、兩容器與 schema，不追隨移動中的分支或標籤。
