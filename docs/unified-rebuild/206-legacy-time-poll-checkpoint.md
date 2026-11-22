# 原時間投票操作恢復

日期：2026-11-22（Asia/Taipei）。變更範圍：`web`；部署：`none`。先按跨服務變更評估，再以固定舊 Python bot 的隔離組合驗證網站寫入相容性。沒有修改 Python bot、TypeScript bot 業務、schema、outbox 格式、群政策或既有深連結；共用 contracts 匯出影響的生成 bundle 已重新建置。正式切換仍須驗證實際運行的 bot 版本，不能把固定公開版本的模擬驗證視為正式驗收。

## 操作與保全

`/me/local-history` 新增原 `PUT /api/time-polls/:id/votes` 及原 `PATCH /api/time-polls/:id` 的七種管理操作：提前截止、延期並開放、取消、移除、群同步、群通知重送、定案。完整 method、path、body、requestKey、base_revision、base_vote_revision 與原 sorted JSON 簽名保留；不改為新版請求或產生替代編號。原建立投票請求仍待下一項 adapter；本次沒有縮減完整合併目標。

相符回執先於安排版本、投票截止與候選過期檢查。管理操作的回執仍核對目前發起者；已刪投票的填答回執也限目前發起者核對，不返回凍結的填答者、私人內容或舊權限。損壞、錯誤目標、不同原內容及新版 receipt 均拒絕覆寫。新回執使用原 reader 能按目前權限刷新的 `{id,time_poll:true}`，移除則為原 `{id,status:'deleted'}`；已刪管理結果可連到發起者管理入口。

未提交的原請求必須通過原版本及目前業務限制。填答須覆蓋全部有效候選，允許帶入已存在的過期候選；過期項不更新，舊選擇保持凍結。填答只增加 vote_revision，不建立報名、活動或管理歷史。延期、取消、群重送、定案沿用原狀態與原因限制；bot_sync 省略 bot_enabled 時繼承目前值。已知 inactive 欄位留在原簽名，按原規則只讀 active 欄位，例如精確模式以儲存候選的時間與時長定案。未知或無法對應的原欄位保持未解決，不能略過。

核對採純讀取 prepare，不建立再回滾試驗活動或通知。新的 recovery_token 只綁定本次核對、帳號、原編號、原簽名、票數、實際安排、顯示姓名及相關群政策；原協議沒有預覽證明，不補造舊 proof，也不替換原安排／票數版本。定案介面展示候選統計、實際開始時間與時長、正式報名截止、時區、地點、費用、人數、原因及自動報名／通知結果。日期與時間按投票時區顯示；使用者明確確認後才重試。

新版及原恢復共用 time-poll-command 的 read/execute pair。定案保持原次序：建立活動與初始安排、建立稽核、發起者接受安排並自動報名、報名稽核、可選 bot hook；其他填答者只收站內定案通知，須另外報名。原回執與必要寫入共用 immediate transaction，任一必要失敗全數回滾。bot_retry 的新增待送工作是必要寫入；群政策、原投遞狀態或候選改變須重新核對。可選發布／同步 hook 仍以 savepoint 隔離，失敗不能宣稱通知已投遞。並行重試、回應遺失及再次核對不重建活動、不重複入列通知。

前端沿用原內容 fingerprint、帳號與裝置世代、離頁、登出及來源 CAS 保護。相同原來源的 pending／done 快照一起保存核對結果；不同 fingerprint、未知請求與後續來源繼續阻擋。尚有同投票原請求時，阻擋新版填答與管理編輯，但保留投票唯讀資料；其他投票不受影響。新增原來源也會在新群通知重送保存 pending 前再次阻擋，不阻止已保存新版原操作的結果查回。

## 驗證

10 個 unit 檔案／182 個不同案例通過。其中新 adapter 22 個案例，包含 9 種固定原 Python 差分情境（填答、七種管理、另加日期定案）、原簽名與回執、過期票凍結、原欄位選取、票數與原因限制、並行定案、目前權限、損壞回執、review 變化、必要失敗整筆回滾及可選 hook 隔離。另重跑既有原生投票、65 項投票角色／狀態矩陣、bot 群通知、舊本機資料與 HTTP 契約案例。既有測試名稱與功能案例保留；HTTP inventory 數字隨新增的兩個操作更新。

5 個 browser 檔案／70 個不同案例通過，0 retry／skip。新 22 個涵蓋完整原 body／key、填答及七種管理、日期／精確定案、自動報名提示、遺失回應、映射 abort、fingerprint／來源／帳號／世代變化、pending／done、過期原安排、只阻擋相關投票、通知重送前的後續來源、登出及 hash 期間離頁；既有 48 個含原生投票、舊本機資料、bot 與耐久 pending 恢復。360px 核對畫面無水平溢出。既有全部 895 個 browser 的 ID、名稱及行列 tuple 與第 205 號宣告一致，新增 22 個。

strict TypeScript、建置、check:ui、built smoke 及 capability inventory 通過；201 個 HTTP operations／91 個 body、324 個 schemas、82 個權限來源 pins、160 個契約來源 inputs 完整核對。13 份 runtime bundle 獨立逐 byte 重現，API／音樂來源 union 200 個，擴充 native union 137 個。完整 domain authorization 與發布 gates 維持 false。

專用 compiled API＋固定原 Python bot `8da877857f163853c449474e168534e2e493121b` 驗證已加入 CI：核對 55 個確切公開 blobs；恢復原填答、群重送、精確及日期定案，建立兩場活動、兩份發起者報名與初始安排、兩則填答者站內通知、五份原回執；原 bot 的隔離 API 確認一則投票通知與兩則活動通知，二次 poll 無工作；原 reader 可以讀取新回執並刷新目前投票。重試沒有新增業務或 outbox。沒有真實 QQ 投遞。

同一固定原 Python bot 的既有 compiled 完整隔離場景亦通過：71 次原 worker、9 次 native consumer、314 深連結、532 HTTP 與 2 次限流延後，含投遞恢復、模擬／不確定狀態、交接順序與正常關閉。網路投遞被禁止，正式 bot 組合仍待驗收。

完整 inventory 為 208 個 unit 檔案／3,833 個預期展開案例、86 個 browser 檔案／917 個案例。本機只執行上述相關回歸，不宣稱這份來源的完整回歸通過。全 browser 宣告用 inventory-only 的 Umami 環境旗標包含既有公開 client 案例，本次沒有執行該項 analytics 測試。166 個既有能力與 U01–U03 的完整驗收狀態不提升。

## 限制與原證據

首輪差分測試誤以非列舉的 fixture 活動為新活動，改按 poll.event_id 識別；原失敗保留。TypeScript 注入測試的 unknown payload 型別、原 choice 取值與 browser 匯入 server 依賴的 runtime contract 也已修正測試資料／型別；沒有放寬正式驗證。首次 inventory 斷言仍含舊 JSON response／response schema／OpenAPI component 數量，按最終生成 inventory 更新，原報告保留。手機初次截圖被後續 Playwright 的清理移除，已重新保存並檢查；時區顯示改善後重新執行新 browser 檔案。群通知耐久案例曾因 regex 檔名比對重複選中，按不同 ID 去重後共 70 個，兩份原始報告均保留。所有自動 retry 設定仍為 0。

證據目錄：`/Users/danersaka/.codex/rebuild-verification/legacy-time-poll-206/`，包含原失敗、最終報告、完整宣告、contracts、來源／runtime pins、固定舊 bot 組合、手機截圖與獨立驗證收據。CI 204 已結束：image／browser 通過，unit 的兩個舊 inventory 失敗已在 205 修正並保留原報告。CI 205 的 image 通過；unit／browser 在本輪核對時仍進行中。沒有取消、重啟或把未完成 CI 記為通過。

原建立投票與其草稿識別、其他舊命令 adapters、完整來源／資料對帳、正式規模、多副本、實際裝置／QQ WebView、切換後實際 bot 版本及 P6／P7 尚待完成。未合入 main，未部署。
