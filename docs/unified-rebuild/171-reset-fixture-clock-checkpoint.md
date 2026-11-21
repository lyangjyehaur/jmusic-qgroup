# 原始重設恢復測試的候選時間

日期：2026-11-21。變更與發布範圍：`none`；只修改合成測試 fixture、測試輸入及文件。不部署，不修改業務程式、原始 bot、schema／outbox 或正式資料。

第 169 號原 unit job `136643642662` 失敗：原始 Python reset 使用實際時間，恢復 fixture 卻把候選時間固定為 `2026-11-21T00:10:00.000Z`。實際 reset 越過該時刻後，正式保全檢查正確拒絕早於 reset 的 retirement。原 artifact `14682072501`、ZIP digest／CRC／bytes、terminal log 與固定 inventory 已核對保存；178 檔／2,923 案中 2,868 passed、3 failed、52 skipped，五個檔案受影響。沒有把 skipped 算成通過，也不重啟原工作。

共用恢復 fixture 改在原 reset、後續原資料寫入與 native fixture 寫入完成後，取得實際候選時間。三個候選階段使用同一個自然時間，符合既有允許相等的順序檢查；獨立 retirement 測試也使用該候選時間。不凍結原 worker 時鐘、不改 erasedAtJson、不放寬時間比較、不補未來時間。原先拒絕過早 retirement 的測試保持原樣。

受影響的五個檔案／55 個原有案例本機全部通過，與既有固定 inventory 逐項一致，沒有新增、刪除或跳過案例；包含 pending／authorized／completed 原認領證據、完整 retirement 恢復及錯誤候選拒絕。型別檢查通過。完整預期仍為 179 檔／2,960 unit、81 檔／843 browser；本提交自己的完整 Linux CI 尚待核對。

第 170 號 image job `136658148606` 已成功且完成獨立核對。原 artifact `14681822812` 共 13 個檔案，ZIP digest／CRC／bytes 與原日誌保留。實際 web／bot 版本回報、image inspect、Compose origin、來源／tree／authority pin、三個校驗工具 hashes 均與候選清單一致。新清單只證明隔離映像及候選設定身份相符，不驗證正式運行的版本組合或 authority 內容。

同一份原映像證據保留 71 次固定 Python worker、9 次 compiled TypeScript worker、531 次實際 HTTP（包含一次限流等待）及 314 個不同入口；原 Python 55 個 blobs、十四列未到期提醒、七類順序交接、回覆／鍵盤 bytes、native runtime hashes、原 worker 投遞恢復、靜態資源與 precache 均完成獨立核對。這是隔離受控驗證，沒有 QQ 真送、正式 bot 切換或完整 B01–B15 放行。

166 capabilities 仍為 0 fully accepted，`releaseEligible=false`。第 169／170 號其他尚未完成的原始工作繼續觀察；原失敗報告保留。完整 bot 功能、來源／reset 世代、實際版本組合、media／browser pending 及完整切換驗收仍待完成。
