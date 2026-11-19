# 最新 bot 外部狀態與原時間恢復檢查點

日期：2026-11-19。發布範圍 **`none`**：離線恢復／核對工具與隔離測試；不修改 web／bot runtime、正式資料、設定、憑證或真實待送工作。未整合 main、部署或完成全功能驗收。

## 原時間恢復

檢查點 111／112 已保存最新 bot 原 bytes 與 mtime，但私人套件檔案的落盤時間不能直接當成恢復後的 bot 檔案時間。Python 和 TS 縮寫元件都會依檔案 mtime 清理結果；只複製 bytes 會讓原已過期檔案繼續留存。本次補上 `writeRollbackBotRestore`，接收固定 v2／v3 私人套件與捕獲時保存的外部完整 manifest SHA，拒絕缺少最新 bot 狀態的 v1。

只在全新、與私人套件及已記錄的 bot 原 source roots 隔離的目錄落盤；v3 另外排除原 capture root。v2 未記錄原歷史 capture 的絕對路徑，操作者仍須選擇與其他來源隔離的輸出，不能聲稱工具核對了未記錄的路徑。原來源可以已離線或搬移，恢復與 reader 不探測原 live paths。輸出保存：

| 輸出 | 原狀態保全 |
| --- | --- |
| `bot-logs/` | 群發送拒絕／授權、原健康紀錄、全部既有日誌輪替及原原子寫入暫存檔 |
| `bot-abbreviation-results/` | 原 metadata、group hash、created、byte cursor、budget、uncertain、body／section boundaries、版本本文、休眠及不完整 bytes |
| `sensitive-words.json` | 明確配置的自訂屏蔽詞原 bytes；未配置時不建立 |
| `bot-restore-manifest.json` | 固定原套件 SHA、原 bot index SHA、完整原 index、唯一檔案映射／size／SHA／mtime，固定 `rollbackEligible:false` |

目錄的存在／缺失語意延續原 index，已存在但空的目錄仍建立，原缺失的目錄不補建。未解析或正規化 bot 內容，不清理暫存、不重設 cursor／uncertain、不續期 metadata.created，也不把历史健康／ACK 時間宣稱成目前在線。

輸出只有 bot 外部檔案及私人證據；不建立業務 DB、owner DB、環境檔、設定或候選服務，也不停止／啟動 worker、回收 outbox 或發送消息。它尚未成為固定舊 bot 的完整運行／恢復根，不能據此消除 `fixed_bot_external_state_restore` 或實際候選組合門檻。

## exact mtime 與檔案身份

每份輸出以 `O_EXCL | O_NOFOLLOW` 新建為 owner 0600，目錄 0700，先寫入並 fsync 原 bytes。`restore-bot-file-times.py` 以 Python `-I` isolated mode 在已指定 device／inode 的 regular-file FD 上使用 `os.utime(ns=…)`，保留當前 atime、恢復原 mtime，再 fsync 及核對 named／held identity、size、mode、owner、nlink 和精確 mtime。

使用整數奈秒避免 JavaScript 秒數的浮點轉換損失。Python helper 不讀 bot／DB／環境內容；錯誤 inode、symlink、hardlink、公用模式或非目前 owner 均拒絕。mtime 無法由當前 filesystem 精確表示或 helper 失敗時不放行，保留 private partial；不以近似時間假裝成功。來源套件和 live SQLite 不傳入 helper，不開關任何持鎖 SQLite inode。

原 bot index 的 path、完整 inventory、來源 roles、缺失／自訂詞庫語意、排序與原 pin，現在抽出 `verifyRollbackBotIndex` 供恢復在開啟任何輸出 path 前核對。完整 bot bytes verifier 沿用相同規格，不改變原 v2／v3 pins 或 runtime 行為。

## 固定 reader 與失敗保全

來源 package 在保留輸出前、preseal、postseal 持續獨立核對。可供後續捕獲／恢復協調器接入同步 guard；thenable 拒絕。此 guard 不等於已取得部署／retention 鎖，也不是不可信 callback 沙箱。

輸出先保存 `incomplete.json`，全部 payload、原時間及 inventory 核對／fsync 後才寫最終 manifest。根、父目錄及原子目錄有 inode fence；讀取器建成後再發生的最後 guard 變動也會再次檢查。失敗僅在原 root／parent 身份仍成立時補 incomplete marker，不觸碰替換的輸出 root／parent 或別人的檔案；子目錄被替換則在仍屬本次的原 root 標為不完整。

`readRollbackBotRestore` 必須收到外部保存的完整恢復 manifest SHA；核對 canonical metadata、0700／0600／owner／單 hardlink、完整及唯一 inventory、原 bot pin、映射、bytes 和每檔精確原 mtime。再以獨立 guards 核對原 root／子目錄／files／manifest view，不從檔案現在的時間重新生成原 index。額外、遺失、替換、改時間或 rehash 後的語意變更均拒絕。

CLI 入口：

```sh
npm run restore:rollback-bot -- <私人回退套件絕對路徑> <原套件外部-manifest-SHA256> <全新私人輸出絕對路徑>
npm run verify:rollback-bot -- <私人恢復輸出絕對路徑> <恢復時保存的外部-manifest-SHA256>
```

stdout 僅輸出狀態、數量、原套件／bot digests 和 `rollbackEligible:false`；不輸出私人來源、群授權、縮寫本文、cursor 或屏蔽詞。stderr 使用固定訊息，不回顯 Python／filesystem 原錯誤和私人路徑。工具不認證原 image／commit，也不把 restored manifest 當成服務啟動授權。

## 隔離驗證與剩餘門檻

合成來源涵蓋 v2／v3、缺失／空目錄、完整日誌、群拒絕、版本與休眠本文、不完整暫存、原 cursor／uncertain／created／mtime、自訂屏蔽詞。逐檔實際落盤、原 bytes／奈秒核對、來源與業務 DB 不變。

測試直接使用現有 TS／Python continuation readers、Python OutboxWorker 的群授權 reader，核對原 byte cursor、同群／不同群、metadata.created 到期與持續拒絕。另對一次性恢復目錄執行實際 Python cleanup 和 TS 縮寫元件 cleanup，原過期檔案均按原時間刪除；TS cleanup 以假的 QQ API 回應觸發，沒有真實外部消息或 worker 運行。兩種實際屏蔽詞 loader 使用明確恢復的自訂詞庫，核對屏蔽結果及原 bytes／時間不變。恢復目錄被業務元件改動後，固定 reader 如預期拒絕，原套件及來源仍不變。

其他測試涵蓋完整外部 pins、v1／既有輸出／重疊／symlink 拒絕、guard 三階段失敗、封存後改時間、Python helper 失敗／wrong inode／symlink／hardlink、root／parent／子目錄替換、file／mtime／permissions／inventory 修改、manifest view 修改、外層 rehash 與兩 CLI redaction。

相關 **205 項／4 檔通過**，新增實際自訂詞庫案例另外 **1 項通過**；Strict TypeScript 通過。完整單工回歸 **1,604 項／131 檔通過**，包含本次恢復的全部 46 項。紀錄：`/tmp/qgroup-bot-restore-targeted-final.log`、`/tmp/qgroup-bot-restore-dictionary-final.log`、`/tmp/qgroup-bot-restore-typecheck-final.log`、`/tmp/qgroup-bot-restore-native-final.log`。release-source 拒絕文字來自預期拒絕的隔離測試，沒有本次發布操作。

完整固定舊 web／music／bot read/write、恢復後有效配置與原版本組合、outbox 續送／不確定結果對帳與 forward restore 尚未驗收。外部部署／retention 協調、原版本紀錄認證、舊歷史 adapter、歷史看板 latest erasure、browser pending／proof、正式規模／實機 QQ 等門檻仍存在。全部私人套件及恢復輸出 **`rollbackEligible:false`**；台帳 **166 in_progress／0 完整驗收，release_eligible=false**。不部署。
