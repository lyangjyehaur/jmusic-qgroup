# 第 215 批：撤銷裝置授權時保全另一帳號的成分找回

2026-11-22。分支 `codex/unified-rebuild`。運行產物影響範圍 `web`，本輪實際發布 `none`；不合併 main、不部署。

## 問題與修正

A 帳號撤銷另一裝置上的 A 授權時，若該裝置正在使用 B 帳號，原生 API 仍按整個 session 刪除成分找回紀錄。B 的待確認 PIN 意圖、已完成 QQ 授權及已完成關聯回執都會遺失；這違反 I09 的單一帳號授權隔離要求。

現在按裝置目前帳號分流：撤銷正在使用的 A 帳號時仍清理該 session 的全部找回意圖；僅撤銷非目前的 A 授權時，只清理目標帳號的意圖，保全 B 的 session、QQ 授權及找回紀錄。現有 scope、Origin、CSRF、當前裝置拒絕、替代帳號選擇及稽核交易沿用原規則。

重新核對 `account-devices.ts` 的七個 HTTP 身份邊界後更新來源 pin；沒有改動請求／回應契約、schema、outbox、bot 指令、群政策或網站深連結。

## 驗證

新增三項隔離 API 流程，使用真實的裝置授權、PIN 找回及合成 QQ 授權操作，分別核對 pending／authorized／completed。修正前，三項均在撤銷後得到 `status=none`；修正後，原狀態及完整意圖列保留，B 可繼續授權／關聯或讀取原完成結果，且不能再切換至已撤銷的 A。

三項亦逐列保全 users、成分／選擇、QQ 身份、登入嘗試、bot_outbox 及 bot_settings；既有主動 session 撤銷、帳號切換、登出失效與交易回滾仍須通過。

- 成分找回、裝置及登入：3 檔、44 項通過，無略過。
- 裝置、成分找回及持久恢復瀏覽器：31 項通過，無略過、重試或 flaky；本機預覽已重啟載入本批修正。
- 重構建置／strict TypeScript／HTTP 契約及產物 smoke 通過。產物 smoke 涵蓋原生 bot 的本機 HTTP／WebSocket、ACK／Resume、outbox、模擬／不確定投遞、唯一投遞者與停止流程。
- 後續已核對本批固定候選 Linux CI：完整 unit 4,055 項、browser 1,041 項及隔離映像組合通過；本機完整單工 unit 4,055 項亦通過。較早間歇性失敗仍保留，根因未證明；詳細限制與線上副本演練見[第 216 批](216-online-copy-rehearsal-checkpoint.md)。

本機原始結果保存在私人驗證目錄的 `inactive-device-grant-before-final.json`、`inactive-device-grant-after.json` 及建置／smoke 紀錄，不包含正式來源或真實 QQ 投遞。

## 未完成條件

I09 保持 `in_progress`。P6 的完整正式私有副本對帳、新寫入回退、全台帳語意審核及實際版本／平台驗收仍未完成。沒有把本機修正或前一批 CI 成功視為全部功能已驗收。
