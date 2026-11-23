# 實作與驗收收斂清單

更新：2026-11-23。**P0–P6 的實作及完整本機驗收已完成：166／166 既有功能與 U01–U03 全部通過。** 任務不包含 P7 正式切換；沒有合併 main、部署或向 QQ 發送消息。發布範圍：`none`。

[第 241 批完整報告](241-complete-local-acceptance.md)記錄最後 O12–O14 與連續恢復／回退／forward；[本機測試指南](local-testing.md)提供可操作預覽。`original_p6_complete=true`；候選尚未合入遠端 main，`release_source_approved=false`、`release_eligible=false`。本機驗收與正式來源批准分開，不以功能通過宣稱可直接發布。

## 完成範圍

| 原計畫 | 結果 |
| --- | --- |
| P0 功能盤點／規劃 | 166 個原功能與 U01–U03 保留原 ID、既有行為及驗收條款；舊程式與提交歷史可查。 |
| P1–P5 統一實作 | React／TSX 網頁、TypeScript API／worker、共用資料與活動／成分操作完成。必要操作提示保留，純展示文案移除。 |
| P6 完整本機驗收 | 各父項、整合動線、線上隔離副本、固定實際版本組合、bot 指令／交接、資料恢復與回退後新寫入往返通過。 |
| P7 正式切換 | 本次任務排除；須另按發布政策整合 main、批准完整 SHA、取得當時成套快照及切換。 |

## 父項驗收索引

| 原功能 | 完整本機證據 |
| --- | --- |
| I01–I16 身份／裝置／刪除 | [第 232 批](232-identity-parent-acceptance.md) |
| E01–E18 活動 | [第 233 批](233-activity-parent-acceptance.md) |
| R01–R13 名冊 | [第 234 批](234-roster-parent-acceptance.md) |
| T01–T09 時間投票 | [第 235 批](235-time-poll-parent-acceptance.md) |
| P01–P10 分房 | [第 227 批](227-room-parent-acceptance.md)、[第 229 批](229-formal-room-parent-acceptance.md) |
| S01–S14 結算 | [第 230 批](230-settlement-parent-acceptance.md)，原帳單相容性見[第 228 批](228-historical-settlement-compatibility.md) |
| F01–F12 財務 | [第 231 批](231-finance-parent-acceptance.md) |
| M01–M22 成分／詞庫／同好 | [第 224 批](224-music-parent-acceptance.md)、[第 225 批](225-matching-order-parent-acceptance.md) |
| C01–C07 喊話／PWA 等 | [第 222 批](222-shouts-pwa-and-admin-parent-acceptance.md)與既有 C04／C05／C07 證據 |
| A01–A15 管理 | [第 222 批](222-shouts-pwa-and-admin-parent-acceptance.md)、[第 237 批](237-admin-and-recovery-acceptance.md) |
| B01–B15 bot | [第 236 批](236-bot-parent-acceptance.md)，恢復交接見[第 240 批](240-recovery-worker-handoff-acceptance.md) |
| O01–O15 共用操作 | [第 238 批](238-common-and-actual-recovery-acceptance.md)、[第 239 批](239-common-and-integration-acceptance.md)、[第 241 批](241-complete-local-acceptance.md) |
| U01–U03 統一體驗 | [第 239 批](239-common-and-integration-acceptance.md) |

[功能台帳](capability-status.json)、[整合台帳](integration-status.json)與[原條款索引](local-acceptance-status.json)保留逐項來源、測試及父項決定。原條款索引的較早完整 CI 與各批次結果仍保留其實際提交時點，最新完整本機決定另列於 `latest_complete_local_acceptance`。

## 回歸與隔離正式副本

完整 Linux CI 提交 `0059259f4b5382d54aedb79a769edfddd8d4dafb` 的 4,063 單元／1,047 瀏覽器／映像取得成功終態；沒有略過、重試或 flaky。後续實作修正的相關單元、瀏覽器、原 Python 比較、build／bundle 與實際映像證據見各批報告，不將後續修改套用較早完整 CI。

固定新版 runtime 為 `1d672eb1b3a0e6519dc890a88e8a5bc855371774`，搭配實際保存的正式 Python bot `07defc429d619a7558ab7218372886f531813ae3`；實際映像 ID 見[第 241 批](241-complete-local-acceptance.md)。其後至本批只有文件及台帳檢查變更，未修改運行程式。

最新授權副本使用現在線上規模：48 帳號、14 活動、87 參加者、68 份成分、152 詞條、682 選擇、三份原詳細帳單、六版房間及 118 outbox。重複匯入、原資料與字典順序、最新刪除紀錄、30 成分歷史、14 看板歷史、媒體與六 bot 外檔已對帳。早期 1,000 人／2,000 詞條合成樣本只保留為額外證據，不作本次容量基準。

第 240 批完成恢復副本的 20 次 worker／43 HTTP／七種交接，保留原意圖、限流與不確定投遞語意。第 241 批沿用該成功副本建立新的三人分房／900 分結算，再完成固定原 HTTP 新寫入、完整來源＋authority 的 business／proof／rebase、三階段各 97 表重跑、重新封存／啟用、固定映像兩次啟停及原 Python 25 指令比較。終態獨立 97 表與圖片／外檔 bytes／mtime 對帳通過；完整失敗證據仍保存在私人目錄。

## 本機交付與正式環境

本機預覽入口為 <http://127.0.0.1:5082>，使用隔離合成資料及模擬登入，不載入私人正式副本、不啟動投遞 worker。啟動、測試帳號及建議操作順序見[測試指南](local-testing.md)。

正式環境沒有因本輪改動。唯讀擷取期間未停止服務，不能當成正式停寫切換證據；原看板刪除紀錄缺失已記錄，正式切換需重新取得当時成套快照。真實 QQ 授權／真群投遞及實機 WebView 結果另行記錄，不冒充本機模擬已通過，也不因此延伸本次本機實作範圍。

保存的原 Python bot 沒有新版 OS 排他鎖，更換 worker 必須先停止舊 bot並確認退出，再啟動新版。發布仍須遵守[發布政策](../deployment-policy.md)及 README 的 server2 保全流程；本機通過、原始碼推送及 main 更新都不等於部署。
