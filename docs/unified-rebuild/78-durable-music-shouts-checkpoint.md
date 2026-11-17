# 第七十二批實作：找搭子原稿與發布操作持久化

日期：2026-11-18（Asia/Taipei）。分支 `codex/unified-rebuild`。變更範圍 **`web`**，實際發布範圍 **`none`**。未合入 main、未部署，未接觸正式資料、憑證、群設定或 bot 工作。

## 文字原稿與原發布操作

找搭子編輯器改用共用 IndexedDB 原稿，沿用 `qgroup:rebuild:music:shout:v1:<帳號 scope>:<musicEpoch>:<profileId>` key，保存原 `{text,pending?:{key,input}}`。未送出文字關頁後完整保留，需明確「恢復本機原稿」後才可編輯或發布；不因載入舊稿或版本而自動發布。

待確認命令保留原 UUID、未正規化文字、profileId、musicEpoch 與 confirm，從收件匣「發布找搭子」回目前編輯入口後，明確以相同 key／body 重試。索引只顯示操作類別及固定入口，不顯示原稿文字；使用成員回執 `/me/operations/:key`。純文字原稿及已完成的空原稿不列為未完成命令。

載入時核對 pending 的 profile／epoch 與 scoped key，且原稿文字必須與 pending.input.text 一致；不能把異常紀錄套用到目前成分或替換命令內容。損壞或不一致原文可保全下載，不會自動送出。key 的世代限定安全整數及 canonical 十進位格式。

## 故障、競爭與權限

發布前等待完整交易提交；put 成功後 abort 不發 HTTP。伺服器已接受，但本機完成確認交易失敗，仍保留原 pending；明確拒絕的本機確認失敗也保留原命令，不能直接建立新 UUID。泛用限流保留 pending；明確 `SHOUT_COOLDOWN` 拒絕則確認後回到可編輯原文字。

兩頁編輯或發布使用共用 CAS：保留兩份原稿／UUID，競爭頁不發第二筆 HTTP；明確讀取已保存版本及載入保全稿不自動提交。保存失敗時選擇離開會再等保存完成，失敗就留在原頁及目前輸入。舊 session 在 IndexedDB 提交後才移除，遷移 abort 保留來源。

發布的 401／403／帳號或成分身份變更會立即隱藏編輯器與私人名單，保留原 scoped 命令並重新查核 session／成分。其他帳號不會取得先前文字或命令；舊帳號延遲成功回應不能替新帳號顯示成功或清除原 pending。刪除成分時清除目前紀錄及保全版本；即使沒有 BroadcastChannel，持久清除世代也會阻擋舊頁重新送出。

## 既有行為與 bot

140 Unicode code point、Python 空白正規化、24 小時冷卻邊界、新發布取代前一則、30 天歸檔、最近 500 則歷史、聯絡資料來源及複製退路保留。API、schema、發布交易、bot 指令／模板／設定／outbox 契約未改。

原生測試對照 Python 歸檔、排序與公開名稱；發布／歸檔／管理移除前後核對實際 Python bot 讀取結果、所有相容表與 pending／sending／sent／failed／skipped 投遞列完全不變。均為隔離 fixture／本機模擬，不是正式 bot 或真實 QQ 驗收。

## 驗證

- `npm run build:rebuild` 通過，仍有既有大 chunk 警告；最終 `npm run typecheck:rebuild` 與 `git diff --check` 通過。
- 新增持久化瀏覽器場景 **16 項通過**，涵蓋原稿、原發布、交易 abort、限流、分頁、遷移、下載、帳號／成分刪除及延遲回應；原有找搭子 **8 項通過**。首輪修正了共用提示含操作按鈕、不能用整個提示的 exact text 定位的測試斷言；沒有放寬業務斷言。
- 找搭子、原操作索引與收件匣原生測試 **38 項全部通過**。
- 最終找搭子／帳號成分／收件匣瀏覽器交叉回歸 **53 項全部通過**，包含上述 24 項找搭子場景，無失敗或跳過。
- 建置後隔離 API／bot smoke 與 `node tests/test_bot_links.js` 通過，未啟動正式 worker、未送出真實 QQ。
- 360px 損壞原命令的保全下載已驗證無水平溢出，下載原文一致，已檢視實際截圖。`npm run check:capabilities` 通過。

77 號剩餘清單中的 `music-shouts.tsx` 已移除直接 session 保存。`music-rooms.tsx`、`music-recovery.tsx`、含 secret 的隱私／管理刪除證明、短效裝置授權、舊 `kanban-local-v1` 遷移、跨裝置 create intent、完整匯出／恢復、實機與實際 web／bot 版本組合仍待完成。全部 166 項能力保留，維持 in_progress，`release_eligible=false`；依使用者要求先不部署。
