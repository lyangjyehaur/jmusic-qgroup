# 2026-11-26 活動詳情、共用表單與手機 dock

發布範圍：`web`（`frontend`）。台北時間 2026-11-26 16:24:16 完成靜態前端切換，正式入口為 https://kanban.danndann.cn。來源為已整合並雙推 main 的 `7bd0ce6103b92101c8df3412eb4c67258cfccec1`。API、bot、schema、outbox、正式設定與資料均未更新；兩容器沒有重啟。

## 更新內容

- 活動詳情直接顯示起訖時間與跨日提示、注意事項；完整名冊以姓名／頭像開成分，備註保留換行。恢復本人直接報名，以及確認結束後續接結算表單。
- 共用草稿提示與離開確認集中於可見的浮層，提供保留或捨棄；表單標題、分組及操作排列統一。
- 活躍前端的選單、勾選、開關、單選、展開區及浮動選單改用 Yahha 元件；日期、時間及檔案仍沿用系統選擇器。
- 啟用 viewport-fit，手機 dock 與對話框避讓安全區；dock 固定底部，保存欄只在輸入鍵盤造成明顯遮擋時上移。移除導覽／頁籤下劃線、修復回頂固定位置，調整頂欄與同好箭頭／排名。

具體功能對照與本機驗證見[活動詳情](../unified-rebuild/activity-detail-legacy-review.md)、[草稿與表單](../unified-rebuild/shared-draft-form-review.md)、[Yahha 元件](../unified-rebuild/yahha-controls-audit.md)及[原型細節](../unified-rebuild/kimi-shell-review.md)。這些文件保留當時的本機狀態，本紀錄記錄其正式發布結果。

## 實際版本與產物

| 產物 | 發布前 | 發布後 |
| --- | --- | --- |
| 前端 commit | `f9014a2b991ed7ae64dddabfb1357828e7b90336` | `7bd0ce6103b92101c8df3412eb4c67258cfccec1` |
| API commit | `7b0914ffd05b4418b9065932592d9bd5c33a71c7` | 不變 |
| bot commit | `7b0914ffd05b4418b9065932592d9bd5c33a71c7` | 不變 |
| API／bot 實際 image ID | `sha256:2b55e3d15df8035dbe5ed6334723c275f1e52061695c4ebc67edc09b369e8e00` | 不變 |
| 統一版 rebuild_schema | 15 | 15 |
| 保留的舊版 schema_migrations | 20 | 20 |

| 容器 | 完整 ID（前後一致） | 啟動時間（前後一致） |
| --- | --- | --- |
| qgroup-unified-web-1 | `5524f53f6289c975eb5b5b25d326452100569936eb33fb3c03d80f6b31e094d1` | `2026-11-25T16:30:39.202136764Z` |
| qgroup-unified-bot-1 | `9d3a349fa048df963eba1a2c8de4ea154bc9c5e28df61ee8a59a4a1bd5147e46` | `2026-11-25T16:30:45.90367263Z` |

兩容器均 healthy，restart count 0；bot 原生 `node .rebuild-dist/bot/start.mjs --check-health` 退出碼 0。

- release：`7bd0ce6103b92101c8df3412eb4c67258cfccec1-3b8a7935517aba3d`，位於 `/opt/qgroup-frontend/releases/`。
- source tree：`42158b7ea89c9e1ea1becaedfbd39eeb601aa680`。
- 相容 API commit：`7b0914ffd05b4418b9065932592d9bd5c33a71c7`。
- PWA build ID：`40d93963dffdb3c87b8ac9711b24398efb46b116eef0455ad4563975ddda719d`。
- manifest SHA256：`3b8a7935517aba3dccbf0d59fb2d0c5a142af8794632eb0643ad35beabf90cca`。
- archive SHA256：`c9b20e63868be1baa06641168095fe821a2de2a0494e4b1bf4039c6b2c667627`。
- 正式暫存：`/opt/qgroup-releases/frontend-ui-20261126-7bd0ce6/`；本機證據：`artifacts/private/frontend-ui-release-20261126/`（不納入 Git）。

## 驗證

- 明確 SHA 通過 `deploy/check_release_source.py`，只從核准 archive 在乾淨暫存目錄安裝依賴、型別檢查及建置。後端輸入指紋與正式 API 一致；233 個產物檔案與先前已驗證的最終前端逐檔相同。新增時間範圍單元測試移至前端目錄，既有後端測試來源維持正式 API 的版本；相關 10 項通過。
- 隔離 API 與合成資料驗證本次確切產物，活動詳情、草稿離開、手機 shell、簡繁及 PWA 共 48 項完成驗證。首輪 47 項通過，1 項 PWA 深連結使用舊的 `p strong` 定位；定位修正先遇重複文字，再限定強調標題，重驗通過。測試修正不改發布產物，無未處理失敗。
- compiled worker 的完整 precache 86 個資源通過，有界批次、完整清單及不強制啟用均通過。保留明確確認更新、離線保護及草稿恢復流程。
- `qgroup-backup.service` 執行成功（Result=success、ExecMainStatus=0）；舊前端完整 manifest／逐檔摘要及現有 API 相容性驗證通過。上傳封裝與 manifest 摘要一致。
- 公開 HTTPS 的 6 個頁面／深連結以 zh-CN、en-US 共 12 組取得正常；前端／API 版本與健康符合上表。87 個公開資源（含 worker 與安裝 manifest）摘要、no-store／immutable 標頭符合產物。舊 hash 資源 `/assets/index-BEKU7hEB.js` 摘要仍一致。
- 正式活動頁在 430×932 Chromium 畫面載入本次 build ID，dock position=fixed、bottom=0、底緣=932px，頁面無橫向溢出、console error 為 0。原有 PWA 顯示新版提示，未強制啟用等待 worker 或清除使用者草稿；驗證用暫時分頁已關閉，使用者原頁未重新整理。
- API／bot 容器、映像、啟動時間、runtime services 與兩套 schema 版本前後逐項一致。沒有向正式活動／帳務／QQ 群發送測試寫入；模擬回歸不記為真實 QQ 投遞驗收。

實機 iPhone Safari／PWA 的 Home indicator、彈性捲動與鍵盤動畫仍待使用者試用；安全區及 visual viewport 的桌面模擬不記為 iPhone 實測。未登入訪客摘要等既有契約差異仍見活動詳情對照，不因本次純前端發布宣稱已補齊。

## 回退

舊前端 `f9014a2b991ed7ae64dddabfb1357828e7b90336` 已保留並通過目前 API 的驗證。回退只原子切換靜態目錄，不重啟容器、不恢復資料庫：

```sh
python3 /opt/qgroup-releases/activity-create-20261126-7b0914f/frontend_release.py activate \
  --artifact /opt/qgroup-frontend/releases/f9014a2b991ed7ae64dddabfb1357828e7b90336-c4f2b017fc030740 \
  --root /opt/qgroup-frontend \
  --api-commit 7b0914ffd05b4418b9065932592d9bd5c33a71c7 \
  --manifest-sha256 c4f2b017fc0307403018e9db7a487d36da8f6996c08bb6b7b24072802c774a37 \
  --api-url http://127.0.0.1:8791 \
  --release-manifest /opt/qgroup/release-manifest.json
```

已核准工具 SHA256：`62654266c8befde0c7728d6028b7137762bdcaff0cd263375bc5963bd61dba1b`。回退前須再次核對實際 API 與工具；若後端已更新，不能沿用這份紀錄假定相容。
