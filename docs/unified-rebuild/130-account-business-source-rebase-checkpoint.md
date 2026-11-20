# 原帳號關閉、完整業務重建與來源重整檢查點

日期：2026-11-20。資料契約影響按 **`both`** 評估；本次發布範圍 **`none`**。僅隔離開發、測試及原始碼同步，不部署、不合入 main，不改動正式 bot、憑證、群設定或真實待送工作。

## 實作

第 129 號處理了看板上的原帳號關閉與跨站回執引用，本輪接成完整流程：原始三方成分／身份合併 → 原關閉授權下的精確清理 → 有效衍生來源 → 原生業務與 proof 重建 → 再次來源重整。原資料先合併，再清理已關閉 ownership；不在合併前把原始來源正規化成另一份 baseline，以免抹掉獨立修改或產生假衝突。

`prepareForwardAccountEpoch` 固定全部十份原始來源與實際 authority，先用原三方 writer 和獨立 row／order oracle 核對原始成分與身份關係，再核對第 129 號的完整看板／帳號候選。只在原 authority 已有真關閉紀錄時清理對應 ownership 與私人 proof。未記錄關閉、錯誤原時間／申請、恢復私人結果、相反業務修改、審計改寫及高水位倒退均拒絕。

清理保留成分內容、聯絡號、原 key／ID／generated mode、used OAuth、PIN 限流、link audit、rowid、SQLite storage classes 和序號。清除 closed user 的 links／prelinks、有效 closed key 的 sessions／entry intents、原 closed browser session 仍失效的 proof，以及指向 closed user 的 entry intents。closed override 只解除 owner、revision 加一並使用原關閉時間；超出安全 revision 容量就拒絕。native payload 中的 closed owner 使用 SQLite `json_set` 清空，其他私人內容不改。

舊 native payload 殘留的 closed user ID 不等於有效 owner；目前 open owner 的 key／proof 保留。原 closed browser token 若已經屬於另一個 open user，也不能以舊 token inventory 刪除目前有效的 proof。獨立清理 oracle 從原 link／prelink 與 browser rows 另行推導作用範圍，逐列核對 surviving identity、storage classes、序號與成分內容／排列，不接受 writer 的清理清單作證據。

衍生 checkpoint 新增一筆 `forward_account_epoch` run，綁定十份原始來源 pins、原 authority manifest／head、完整帳號候選、清理前後成分與身份 image，以及操作時間。衍生 baseline 只能在原來源與 authority 的完整 parent 下使用；獨立 verifier 重讀全部原來源，核對 run、每張表、schema／metadata／sequences 和四領域投影。重新計算候選 SHA、修改衍生 baseline 或聲稱 report 通過均不能取代這項核對。

`reconstructForwardAccountBusiness` 接入既有原生 business 與 proof 的 writer／獨立 verifier。`rebaseForwardAccountBusiness` 先重驗完整原帳號 parent，再重整最新 source evidence；一般 source rebase 仍拒絕已存在的 epoch。內部 row writer 的抽取沒有解除一般入口的完整圖、來源或 proof 驗證。

最終輸出除了原 proof／business images、原 journal 與最新 music／identity pair，也返回各自複製的 `retainedAccountInput` 十份原始來源 bytes／pins／時間和 `retainedAccountParent` 完整衍生 epoch／business／proof bytes。final verifier 比較全部保留資料與原輸入，再獨立核對重整後所有資料列、binding、audit mapping、history cutoff 和實際回退投影。原 authority 仍是必須保全並重驗的外部私人 root，返回 path／manifest pin 不表示已封存 authority files 或完成外部 custody。

preparation、business、rebase 的開始與結束均檢查來源及 authority 未變；boundary 必須同步。business 與 final rebase 的獨立 verifier 在完整查驗結束後也重新確認 authority。途中來源、時間、parent bytes／pins、衍生來源或 authority 改變時拒絕返回候選。

## 驗證

新增 70 項 committed tests。兩種完整情境從實際 native selection／fields HTTP 保存與原 Python 帳號關閉開始，涵蓋找回的舊 claimant 與新建原生帳號。各自加入舊站活動／通知、closed 與 open 成分留言、詞條、新會員、原 identity proof、stale native payload、closed override、used OAuth／限流及追加 link audit／序號高水位，再完成 business、proof、重複 source rebase、完整回退投影和私人套件落盤／固定 reader 重讀。沒有把候選改成可啟動來製造 API 寫入證據。

核對原關閉申請／狀態／時間、closed receipts 清除、open owner／proof 保留、closed override 原時間／revision、原成分 ID／key／generated mode、舊／原生歷史、audit mappings 和 inactive proof 投影。bot pending／sending／sent／failed／skipped 的工作、payload、claim token、retry、simulation、delivered payload 與通知序號逐列保全。獨立 readonly Python oracle 核對原歷史、全部 bot rows、source private types／rowids、closed receipts 及 recovery block。

拒絕案例包含原閉帳授權／來源 pins／審計／序號／業務衝突、重新固定 SHA 的 raw／clean pair、closed／open proof、owner、override revision／時間、stale payload、排序、衍生 sources／run／schema／metadata／sequence／frozen history／bot work／recovery flag、完整 business／proof／重整保留 parent、早晚來源修改、晚到 parent／authority 改寫、非同步 boundary 及錯序時間。另核對原來源 buffer 與 returned retained buffer 獨立、固定輸入重跑結果一致，以及普通 merge／repeated rebase 仍拒絕未授權的帳號 epoch。

最終私人證據目錄：`/Users/danersaka/.codex/rebuild-verification/account-business-130-1bc1429de60f49c7befdb2a7a918432d/`。plan SHA256：`538bd3790cf02922e0e33db191db23cde0927b2444655cfc8684c2cf92590d89`。固定 **1,027 份非文件來源**，完整目前 TypeScript／API／bot inventory 為 **149 檔／2,325 項全部通過**，分 19 批、每批一個 worker。獨立 verifier 核對完整 inventory、每筆 assertion 和來源 SHA；零 failed／pending／todo／skipped。開發期間的 fixture／assertion 修正及選擇性測試另列 development notes，不作最終證據。

strict、完整 build、隔離 build smoke 與 166 項台帳檢查均通過，建置與 smoke 後固定來源仍相同。全部 **12 個 runtime bundles** 與第 129 號 `0a654e7ba5b6b43851ab8532d27ccc5553b4c084` bytes 相同，包含全部 **9 個 bot bundles**；13 檔 TS bot 測試均納入完整回歸。Python bot、schema、前端和 API runtime 沒有改動；本輪只修改離線資料合併／核對工具及其測試。smoke 涵蓋隔離 HTTP／WebSocket、ACK／Resume、投遞與模擬、SQLite ownership／SIGTERM、私人備份與 recovery block，沒有啟動正式 worker 或進行真實 QQ 投遞。

完整 plan、逐批結果、獨立 summary、strict／build／smoke／台帳、runtime comparison 及 development notes 保存在上述私人目錄。提交後以 Git blobs 逐份核對固定來源，另核對 origin／GitHub 功能分支的完整 SHA；來源同步與部署分開。這些證據不表示 831 項瀏覽器案例、實際 Linux 版本組合或外部來源保全已完成驗收。

## 保留門檻

候選完整 schema、integrity 和 FK 核對通過仍為 recovery-blocked；`authorityActivationRequired=true`、`externalRetentionVerified=false`、`rollbackEligible=false`、`releaseEligible=false`。衍生來源和 retained buffers 是離線核對資料，不是外部來源認證、authority activation 或可直接啟動的發布包。

這一條原帳號關閉流程已串接；一般最新 music erasure／完整 structured reset 的 generation、epoch ancestry／外部 custody／高水位、保全私人歷史的 latest-erasure 存取、media／browser pending／proof、真正停止寫入的 capture、固定實際 Linux web＋Python／TS bot 組合、全前後台／B01–B15／實機 QQ／資源驗收及 audited activation 仍須完成。新 TS worker 完整驗收前保留原 Python bot。

全部 166 項能力維持 in_progress，0 項 accepted，release_eligible=false。本輪不部署。
