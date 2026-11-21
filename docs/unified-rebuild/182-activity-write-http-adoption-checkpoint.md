# 活動操作的固定契約與恢復驗證

日期：2026-11-21。候選变更範圍：`web`。實際部署：`none`；未整合 main，保留 Python bot。

報名、出席、代報認領、安排回覆、管理分工、补報名邀請、生命週期與活動可見邀請八檔，移除 34 處過渡 path 呼叫。報名／逐人更正、現場補錄／出席、認領邀請／決定，以及管理邀請／撤銷邀請／撤銷角色分別使用固定操作，讓各自的 params 與 body 接受型別檢查。預覽保持原輸入與 revision，不新增操作編號。邀請 token、person／claim／role ID 使用原值交由契約編碼；分享仍依序讀取分享資訊與活動，保留活動 ID 核對。

所有寫入沿用原 UUID、帳號 scope 與 CSRF；讀取保持原 scope、cache keys、分頁、enabled、刷新與 AbortSignal。未更動本機紀錄格式、目的頁面、草稿世代、確認要求或未知結果恢復邏輯，也未新增介面文案。第一份 strict 檢查攔下缺少 `requestScope` 的寫入；補齊原 viewer scope 後通過，原失敗 log 保留。AST 對照第 181 號確認移除 34 處，全站現使用 161 個不同固定操作鍵，剩餘 35 處過渡 path 呼叫。

## 本輪驗證

- 11 檔／154 個原單元案例全部通過，逐項符合固定 inventory：活動報名、出席、認領、邀請、分工、可見授權、生命週期、安排、分享及 HTTP 契約。不為呼叫搬移新增鏡像測試。
- 16 檔／156 個原瀏覽器案例全部一次通過，固定 IDs、標題與位置已逐項核對，無 retries、skips 或 flaky。涵蓋八個操作頁、原 UUID／本文重試、持久化失敗、跨關閉分頁、登出與身份失效、歷史邀請、名冊、結算及共用流程。
- strict、完整建置及 compiled smoke 通過。隔離副本的 231 個 web 產物逐項與完整建置 byte 相同；81 個靜態資源、140 個壓縮表示、274 次 HTTP 檢查通過。84 個 precache 資源共 1,756,211 bytes，最大原子批次 575,377 bytes；原三個安装／持有最後批次／失敗恢復案例及瀏覽器 cache attachment 的原 hashes、keys、bytes 均已核對。
- API 的 178 個編譯來源及兩個 bundle、三個已鎖定 bot runtime 產物逐項與第 181 號相同。schema、outbox、bot 設定、網頁入口未變。compiled smoke 的合成 native bot 運行通過；未重新執行本輪 Python image pair，既有相同 runtime 的證據仍有限於隔離驗證，不能代替實際在線版本組合或 B01–B15 全部接受。

證據保存在本機 `activity-write-http-adoption-182/`，包括原始來源 pins、AST inventory、完整建置、unit／browser JSON、原始失敗與修正 strict logs、獨立靜態與 runtime 比對收據。

## 原 CI 結果

第 178 號原 run `44871389869` 的三個 job 均成功。原 unit artifact `14695381801` 與 browser artifact `14696010572` 的 ZIP digest、CRC、解包檔案 hashes 已核對；184 檔／3,056 個單元與 81 檔／844 個瀏覽器案例逐項符合固定 inventory，browser 全部一次通過。原 86 個 precache 資源共 1,757,408 bytes 的 cache keys、bytes、hashes 與該版本靜態清單相同。其 image artifact 的固定 Python 配對與 runtime manifest 核對證據沿用已完成的第 181 號紀錄。第 176／177 號原 run 的 failure 保持原結果。

第 180 號原 run `44872622986` 最近已完成 success，artifact metadata 已保存，完整產物核對仍待完成；第 181 號原 run `44874474669` 最近仍在執行，未取消或重跑。這些均為 rehearsal，不能當作正式來源核准或上線驗收。

166 capabilities 仍為 0 fully accepted，`releaseEligible=false`。原前後端與 bot 全功能保全目標不變；剩餘呼叫、完整 permission／response 綁定、真正 OpenAPI、來源／reset、media／browser、候選版本組合與切換演練繼續進行。
