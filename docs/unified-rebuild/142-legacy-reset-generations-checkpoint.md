# 重設後曲目與留言世代

日期：2026-11-20。發布範圍 **`none`**；遷移相容性按 **`both`** 評估。不部署、不合入 main，未操作正式資料、bot 憑證、群設定或投遞工作。

## 實作

原始 reset vault 中的全部操作前來源及完成結果必須完整且通過核對，再以最後一筆已完成 reset 的原 authority record SHA 為世代識別。真正的後續成分 JSON 另產生 derived source：曲目與 active／archived 留言取得確定且不同的 ID，避免重新使用原 ID 時被舊世代刪除範圍混淆。

曲目 map key／id、會員 created 與有效 selection 引用、trend 的現有及已移除曲目引用、留言 id 一起轉換。selection 使用現有 importer 的 JavaScript `String(item.id || item.entryId || '')` 規則，包含數字、布林、陣列及物件；原型別、重複項、順序、level、未生效引用與未知資料均保留。Python 編碼維持 `1.0`、`-0.0`、指數及 Unicode；不對長留言 ID 套用曲目 80 UTF-16 的限制。

獨立 reverse verifier 從 derived source 還原原內容，核對完整 mapping、tuple ID、每個引用與原 Python encoding／order；TypeScript 再核對轉換後的有效 selection。兩個 image 使用真正固定 checkpoint 與相同 lineage；保留實際原生曲目／留言 ID，若派生 ID 衝突就拒絕。來源、authority、vault、輸出 bundle 的邊界變動及非同步 callback 都拒絕，不改動原檔案、原生資料或 bot rows。

這一步只準備來源，不證明最新來源確實出自該 reset 之後，不執行原生清除、業務／proof 重建或 source epoch rebase。`latestSourceAncestryVerified=false`、`resetGenerationsReconciled=false`、`externalRetentionVerified=false`、`recoveryRequired=true`、`releaseEligible=false` 保留。

## 驗證

本次完整 generation 檔 **35 項**加 vault **42 項**，共 **77 項通過**，零 failed／pending；strict、台帳及 diff 檢查通過。測試執行兩次真正原 Python reset，包含無會員的第二次 reset、後續重用曲目／留言 ID、歷史趨勢、實際 native collision、完整 reverse corruption 與晚期 bundle 變動。原生 image 與 pending／sending／sent／failed／skipped bot rows 必須完全相等。

前一次完整 focused report **74／74 通過**；較早 **73／72／1 failed** 原報告保留。失敗案例嘗試修改不可變 lineage 而被 trigger 拒絕，已改為建立真正不同 lineage 的有效資料庫。沒有略過断言。新完整 inventory 預期 **153 檔／2,458 unit**，browser **78 檔／833 項**；本機 focused report 不替代新提交的全套 CI。

[第 140 號固定 Linux run 44679257574](https://github.com/lyangjyehaur/jmusic-qgroup/actions/runs/44679257574) 已 terminal success，完整 **152 檔／2,409 unit**、**78 檔／833 browser** 的身份、位置與每項 passed once 均獨立核對，零 skip／retry／flake。unit artifact `14604779367` 原 ZIP SHA256 `e4fe844e18f31fc1c97401f5d66d551a36d0c63cce2274126a3145a8d6cd179f`；browser `14604741908`：`66028a52471dff1fba2df431906d64b9cfd2aa31df7ebf79a2c536c8db1f3446`。原 ZIP、CRC、所有解包 bytes、三份 job logs 與完整 receipt 保存。固定雙映像與 development Python report 分別核對，沒有用 development 產物代替 image 身份。

[第 141 號 run 44680942423](https://github.com/lyangjyehaur/jmusic-qgroup/actions/runs/44680942423) 的雙映像已獨立通過：web `sha256:4a1118aac34e306a3e2576859d659ebb066bf328297fa97f82995dbdf9f2e38e`、Python `sha256:894a19d94652a98ad9876a1e8d56555b9bc364fa5fc902b2b25343cd5c936c4a`；artifact `14603879251` 原 ZIP SHA256 `92c1b06ecff36d939b833c8b3df655e88ba040409c9f53f329625fb5723ad270`，pair report `688472baf77559941b9a070491ad77c023d7814607a1897393ac86d9e846782b`。完整 unit／browser 尚待終態核對，不套用至本次新實作。

## 剩餘工作

166 項保持 `in_progress`、0 accepted、`release_eligible=false`。下一步將原 reset 範圍與世代映射接入原生 erasure projection、完整 business／proof reconstruction 及 source rebase。外部 ancestry／custody／高水位、latest-erasure 私人歷史、media／browser pending、停止來源 capture、完整 TS bot／B01–B15／實際 QQ 與版本組合、audited activation 仍需完成；固定開發 Python 與合成平台測試不等同這些驗收。
