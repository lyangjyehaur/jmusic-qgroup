# 重置回應遺失測試的等待條件

日期：2026-11-21。變更範圍：`none`；實際部署：`none`。只修正 browser 測試並更新文件，沒有改動運行程式、資料模型、設定、網址或 bot。未整合 main，未部署。

## 修正

`orphan-music-reset.spec.ts` 的 trend-only 案例原本以「查詢刪除結果」按鈕出現作為重新整理的條件。但網站在本機保存操作識別後就顯示待確認區域，仍可能正在核對帳號或管理授權，尚未送出重置請求。這時重新整理再查收據，正確結果是「尚未找到完成紀錄」，不能測到預定的「伺服器已完成、回應損壞」情境。

固定 190 原 CI 的 trace 沒有重置 POST，也沒有 route.fetch／fulfill；重新整理後的收據查詢回傳 404，資料仍保留原本兩筆趨勢。原失敗不是已完成重置卻遺失收據的證據。

測試現在先掛上 response 等待，確認攔截器取得伺服器 200，再故意將 body 破壞為 `{`；確認瀏覽器收到這份損壞回應，以及查詢按鈕恢復可操作後才重新整理。原本的完成提示、只提交一次、重新整理後查回收據及帳號保持登入等斷言全部保留；沒有加重試、延長 assertion timeout 或修改業務邏輯。

## 驗證

- 三個原 browser 案例一次通過，0 重試、0 跳過：無成分時清空匿名找搭子及歷史並保全 bot 工作；趨勢重置的遺失回應恢復；空目錄禁止提交。原固定案例 IDs 與名稱相同，只有第三個案例因新增一行而移動位置。
- TypeScript strict 與 diff 檢查通過。使用既有固定建置及每個案例自己擁有的隔離 preview，沒有重新建置運行產物或碰觸正式資料。
- 前一提交 `2ded904f2ed432e309fe618f4d26440ef159ec2e` 的 [92 個活動權限案例與兩處 transport fixture 修正](191-activity-permissions-checkpoint.md) 已驗證 13 檔／309 個不同 unit 案例；兩個遠端分支 SHA 已核對。原 CI `44920259602` 在本次記錄時仍執行中，沒有取消或重跑。

## 190 原完整 CI 已完成核對

原 CI `44915975388`，固定提交 `4e726a3c9afa722ec7e7cb5c795a6b3008618d7d`，最終整體為 **failure**：

| 工作 | 原結果 | 固定案例結果 |
| --- | --- | --- |
| unit | failure | 190 檔／3,134 案例；3,132 通過、2 失敗、0 跳過 |
| browser | failure | 81 檔／844 案例；843 一次通過、1 失敗、0 重試／跳過 |
| actual Linux image | success | 固定來源、空私有 volume、runtime manifest、native bot smoke 與實際 Python image 配對通過 |

unit 的兩個 binary stream 測試使用不符合既有壁紙 ID 規則的 `synthetic`，已於 191 修正測試資料；唯一 browser 失敗是本次修正的等待條件。完整原失敗結果、logs、trace 與 ZIP 均保留，不記為通過。

三份原 ZIP 的 API digest、大小、CRC 及解包 hashes 已核對。unit／browser 的完整固定 inventory 逐項相同；原 OpenAPI、schemas、145 個生成器輸入與 54 個權限來源 pins 相同。原 PWA 附件的 84 個資源、全部 bytes／hashes 與本機固定 190 建置一致，共 1,777,913 bytes；cache 列舉順序不作為資源身份。

原 browser 的保留 Python 相容性結果也獨立核對：55 個 Python blobs、全部 harness pins、2 個編譯 API pins，以及 domain／recovery／handoff 和 3 個 native bundles 相同；71 次原 worker invocation、9 次 native consumer、314 個深連結與 532 個 HTTP 呼叫保持通過。這份一般 browser 建置回報 `development`、沒有內嵌 commit；來源由原 CI 提交與固定產物 pins 綁定。另一份實際 Linux image 的 rehearsal 版本有完整 commit／tree，不能混用兩者的版本敘述。全部投遞仍為 synthetic、外部網路被拒絕，沒有驗收正式 bot 版本或真實 QQ。

證據：`reset-response-synchronization-192/`；190 完整原 CI 證據保存在 `http-path-bindings-190/`。目前全站 unit 固定 inventory 為 191 檔／3,226 案例，browser 為 81 檔／844 案例；尚無修正後新提交的完整 CI 通過結果。`permissionBindingsComplete=false`、`releaseEligible=false`，166 capabilities 仍為 0 fully accepted；完整功能、資料來源世代、UX、bot 版本組合與切換／回退驗收持續進行。
