# 管理父項與離線恢復驗收

更新：2026-11-23。發布範圍：`none`，沒有運行程式修改。本批沿用已授權的線上私人隔離副本，不讀取憑證、不修改正式服務、不發送 QQ、不合 main、不部署。

目前實作與測試逐檔綁定 `1d672eb1b3a0e6519dc890a88e8a5bc855371774`，對應候選映像 `sha256:acbe1303656b48c7d1e4677aaaf63817b46573c4c13ffe901046858b28ddb159`。完整原條件審核涵蓋 A01–A11、A14 的 13 條款、79 個目前來源／測試 pins 與 43 個固定原 Python 來源 pins。89 個管理單元、60 個瀏覽器案例通過，零略過／重試／flaky；另核對第 232 批兩項註冊政策案例的精確名稱、成功結果與目前測試來源。

## 管理功能

| 範圍 | 正式隔離副本證據 |
| --- | --- |
| 登入、角色、帳號、註冊政策與私人備註 | 3,015 次 HTTP；48 個原帳號的 159 組搜尋／分頁／UnionID 篩選與原 Python 一致；47 次角色與 96 次備註／人工 QQ 寫入逐值核對。救援輪替／到期、撤權、CSRF、未知回執、精確重試及政策修訂限制由具體成功案例共同驗證。 |
| 成分清單、轉交、解除與 PIN | 68 份原成分读取；204 次解除／轉交／恢復 owner 的狀態與原 `Store.admin_change` 逐值一致，原身份副本與來源 JSON 不變。51 份數字 QQ 可重設 PIN，17 份原 `m_` 成分按原限制拒絕。 |
| 活動管理協助 | 14 場原活動，九次允許的安排修改與原 Python `events.patch` 完整對照；終止／結算、缺原因及 owner-only 設定按規則拒絕，無額外寫入。原報名、條件、稽核、通知與 outbox 保全。 |
| 詞庫、匯出、歷史、刪除與重置 | 300 次 HTTP；152 詞條欄位／別名／建立者名稱一致。更新／合併／刪除的整份匯出與原 handler 一致，新增成功；30 份原歷史按原字典順序及最新身份／刪除投影下載。兩次 linked／unlinked 刪除及一次 68 成分／152 詞條全重置驗證 durable journal、事前配對備份、帳號／活動／bot 保全。 |
| 刪除申請管理 | 60 次 HTTP，以實際關閉 API 建立共有參照的 shared_review 申請；note／status 與原 Python 一致，精確重試不重寫，completed／erased 客戶端欄位拒絕。 |

獨立 Python 對 history、linked 刪除、unlinked 刪除、全重置四個副本各核對 97 張表，按 rowid 與 SQLite typeof 比較；每份 64 張受保護非 music 表、六張 bot 表及原 118 筆 outbox 不變，四張原圖 bytes／size／digest 一致，integrity／foreign keys 通過。

私人完整審核在本機 `admin-parent-237/acceptance-private.json`；引用成功的 `run3`、`secondary6` 的 assistance **子報告**、`tail2`、`privacy2` 與獨立對帳。初次 helper 錯誤預期或調用的失敗報告保留，沒有改產品或原 oracle。`secondary6` 整輪後段失敗，不記為整輪通過；`privacy1` 選中的帳號僅在新統一系統具有額外共享紀錄，原站 completed 與新版 shared_review 的差別符合保全規則，另以原站亦有參照的帳號完成逐值比較。

## 恢復結果與剩餘範圍

第 236 批拒絕的第 221 批舊套件保持原樣。私人診斷仍保留原拒絕條件，確認值比較通過，拒絕發生在歷史字典順序比較；第一份不一致歷史有 50 個成員位置不同。診斷版只記錄差異雜湊與 stack，不作驗收使用，也未放寬 checker。

改用第 226 批排序修正後建立的 224 檔、30 份歷史套件，完整目前 checker 重新通過。套件 SHA256 為 `34bf98dbaeea1294363330574cd56d05ff41991b223277a63225ea168b8a18f5`；新建配對 erasure authority SHA256 為 `410ea740b2cf1772ff02d4679323d56317f200df6291ce39d2125e38ac46fd96`，沒有沿用舊 authority。

目前 `activateRecoveryCopy` 已成功建立全新隔離副本；原來源 `recovery_required=1` 仍阻擋正常啟動，新副本旗標為 0。原生 authority 兩次開啟／關閉與只讀 bot help 通過。獨立 Python 在 activation snapshot 及原生重啟後各比較 97 張表，只有恢復旗標改變；DDL、rowid、typeof、pragma、四張原圖與 wall manifest、journal、六個 bot 外部檔案 bytes／奈秒 mtime、七筆不確定投遞工作保全。沒有啟動投遞 worker。

這證明離線啟用及原生重啟，**尚未證明目前固定實際映像在該 recovery copy 的網站／保存 Python bot 成套恢復**。第 236 批已通過的映像通知組合也不能代替這一步。固定原 web／music／bot 的完整回退操作、O01–O15 及 U01–U03 仍須繼續。

**A01–A11、A14 完整本機父項通過，累計 151／166，剩 15 項共用操作及 U01–U03。** `originalP6Complete=false`、`releaseEligible=false`。台帳見[功能狀態](capability-status.json)及[完整證據索引](local-acceptance-status.json)，操作入口見[本機測試指南](local-testing.md)。
