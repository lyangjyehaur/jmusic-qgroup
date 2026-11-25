# 2026-11-26 手機版面與成分草稿恢復

發布範圍：`web`（`frontend`）。台北時間 2026-11-26 01:46:05 完成靜態前端切換。來源為已整合並雙推遠端 main 的 `f9014a2b991ed7ae64dddabfb1357828e7b90336`；API、bot、資料庫與正式設定均未更新，兩容器沒有重啟。

手機頁面標題與主操作並排，活動與時間投票共用篩選間距，活動與音樂共用統計概覽；音樂趨勢放入音樂分頁。成分草稿恢復、版本不同、保存結果待確認與儲存錯誤集中於固定保存層。版本不同時提供「讀取最新版本」，保留目前勾選並顯示目前已保存的選擇，再由使用者保存；保存成功提示保持在懸浮層，不插入頁面內容造成版面跳動。

## 實際版本

| 產物 | 發布前 | 發布後 |
| --- | --- | --- |
| 前端 commit | `7b0914ffd05b4418b9065932592d9bd5c33a71c7` | `f9014a2b991ed7ae64dddabfb1357828e7b90336` |
| API commit | `7b0914ffd05b4418b9065932592d9bd5c33a71c7` | 不變 |
| bot commit | `7b0914ffd05b4418b9065932592d9bd5c33a71c7` | 不變 |
| API／bot 映像引用及實際 image ID | `sha256:2b55e3d15df8035dbe5ed6334723c275f1e52061695c4ebc67edc09b369e8e00` | 不變 |
| 資料庫 schema | 15 | 15 |

API 容器 `5524f53f6289c975eb5b5b25d326452100569936eb33fb3c03d80f6b31e094d1`，啟動時間 `2026-11-25T16:30:39.202136764Z`；bot 容器 `9d3a349fa048df963eba1a2c8de4ea154bc9c5e28df61ee8a59a4a1bd5147e46`，啟動時間 `2026-11-25T16:30:45.90367263Z`。切換前後 ID、映像與啟動時間一致，均 healthy、restart count 0；bot 原生 `--check-health` 退出碼 0。前次後端與 bot 發布見[活動發布紀錄](2026-11-26-activity-create-legacy-flow.md)。

前端產物：

- release：`f9014a2b991ed7ae64dddabfb1357828e7b90336-c4f2b017fc030740`，位於 `/opt/qgroup-frontend/releases/`。
- source tree：`526aa7439644f2b823f8aa0a6ccd23f2a685a854`。
- 相容 API commit：`7b0914ffd05b4418b9065932592d9bd5c33a71c7`。
- PWA build ID：`e0a174ed0e0f0fdfc747ec5c7d8a3a98121fcd59df368ea62cebffe2f210a914`。
- manifest SHA256：`c4f2b017fc0307403018e9db7a487d36da8f6996c08bb6b7b24072802c774a37`。
- archive SHA256：`9eef8a9165f491941814dd81ee09fb5a9c86ed17069194eb0654018fd81ab5cb`。
- 正式暫存與證據目錄：`/opt/qgroup-releases/frontend-review-20261126-f9014a2/`；本機私人證據：`artifacts/private/frontend-local-review-release-20261126/`（不納入 Git）。

## 驗證與相容性

- 明確 SHA 通過 `deploy/check_release_source.py`，從乾淨 archive 執行型別檢查與前端建置。230 個產物檔案摘要與本機已驗證的前端一致。API、bot、共用 packages、lockfile 與後端建置輸入沒有差異，後端指紋檢查通過；使用相同後端輸入的隔離 API 驗證。
- 成分保存與恢復相關回歸完成 35 次成功案例執行，包含最後一輪 33 項及 2 項重驗。涵蓋原稿恢復、版本衝突、重新讀取、跨頁保存層、保存結果確認與固定層版面。
- archive 產物的 Kimi 整合、音樂排行／趨勢、PWA／precache 與簡繁共 55 項完成驗證。首次 54 項通過，1 項使用舊活動時間欄位標籤失敗；測試改用現行日期／時間及進階報名截止欄位後重驗通過，沒有因此修改發布產物。測試修正與本發布紀錄的後續提交範圍為 `none`，無須再次發布。
- 公開 HTTPS 6 個入口各以 zh-CN／en-US 取得，共 12 組 shell 回應正常；前端版本、API 版本與 `/api/v2/health` 符合上表。82 個 JS／CSS 摘要、快取標頭、worker 與安裝 manifest 均符合產物。首次公開驗證因稽核程式未統一 HTTP 標頭大小寫而中止，修正稽核後通過，非服務故障。
- 正式音樂頁概覽與 5 個音樂分頁顯示正常，瀏覽器未記錄 console error。舊 PWA 收到新版提示，仍要求先保存或保全草稿；未強制啟用 worker、清除快取或動到使用者本機草稿。
- 保留舊 hash 資源，公開 `/assets/index-BEKU7hEB.js` 摘要仍為 `f5d340e96345b9c8a892cf6349477adf503617a08936b6027d838dd5dc909afa`，舊開啟頁面可繼續載入原資源。
- bot 指令、回呼、網址、schema、outbox、設定與投遞語意沒有修改。沒有遷移、覆蓋正式資料、變更憑證／群設定或發送真實 QQ 測試消息；隔離回歸不記為正式群投遞驗收。

## 回退

已驗證原前端包與目前 API 相容，目標為 `/opt/qgroup-frontend/releases/7b0914ffd05b4418b9065932592d9bd5c33a71c7-92cc2632a56f08ed`，原 build ID `53de938ac8847bb3be7783e5746e443bd005b1591dc8d0d25aa06202eb101f63`。回退只切換靜態目錄，API／bot 保持上表版本，不恢復資料庫、不重啟容器：

```sh
python3 /opt/qgroup-releases/activity-create-20261126-7b0914f/frontend_release.py activate \
  --artifact /opt/qgroup-frontend/releases/7b0914ffd05b4418b9065932592d9bd5c33a71c7-92cc2632a56f08ed \
  --root /opt/qgroup-frontend \
  --api-commit 7b0914ffd05b4418b9065932592d9bd5c33a71c7 \
  --manifest-sha256 92cc2632a56f08ed99d7ab082e11431d25829a305c4bbf68869e93df04dcd56d \
  --api-url http://127.0.0.1:8791 \
  --release-manifest /opt/qgroup/release-manifest.json
```

使用的已核准工具 SHA256 為 `62654266c8befde0c7728d6028b7137762bdcaff0cd263375bc5963bd61dba1b`。本次正常啟用只更新 runtime manifest 的 frontend 區塊並原子切換 `current`；回退前須再核對工具與實際 API，若後端已更新，不能沿用本紀錄假定相容。
