# 第七十七批實作：舊看板本機紀錄保全與原回執查詢

日期：2026-11-18（Asia/Taipei）。分支 `codex/unified-rebuild`。變更範圍 **`web`**，實際發布範圍 **`none`**。只操作本機隔離 fixture、瀏覽器 context 與 mock QQ；未合入 main、未部署、未操作正式資料、憑證或 bot 工作。

## 同源保全

新入口 `/me/local-history`，收件匣可進入。用目前有效 session 的原 scope，只讀 `kanban-local-v1/entries` 內精確的 `draft:<scope>:`、`request:<scope>:` 範圍。帳號 scope 沿用 `sha256('kanban-drafts-v1:'+userId)`，沒有用新會員 ID 猜測或跨身份搬移。

原活動、複製活動、時間投票、包廂、結算與款項草稿，以及 pending／done 原請求，保存至獨立 `qgroup-legacy-local-v1`。原來源不刪除；目的交易 strict commit 後才算保全。來源不存在時中止建庫，不建立假的原資料庫；無法辨識的來源版本／keyPath 中止並保留原資料。

保留整筆 structured source、原 key／scope／at、欄位順序、明確 undefined、base revision／version、client_intent、原請求編號與 payload、原圖及圖片版本引用。以完整保全內容的 SHA-256 去重，不把不同內容合成一筆；舊分頁改寫同 key 時保留两份快照，原來源維持最新內容。查詢前發現被舊分頁改寫，拒絕用舊快照查詢。

已辨識草稿可檢視原表單與圖片、明確下載帶版本的 tagged tree 保全檔。未知 JSON 形狀留在專用保全庫，標示不能轉換；非原 BoardStore 的未支援資料類型留在原庫並阻止本批處理，不宣稱其已搬移。原請求不提供原文下載；含 PIN／OAuth 等授權欄位的已辨識草稿也不匯出。畫面不展示憑證欄位，專用庫不加入一般原稿、版本、收件匣原操作索引或公開匯出。

## 原回執查詢

新增只讀 POST `/api/v2/me/legacy-requests/check`。原 body 以 POST 傳送，避免圖片／原文字／身份放進網址。要求有效會員、原 scope、同 origin 及 CSRF；按目前會員與原 requestKey 查 `request_results`，不查其他帳號、不更新回執、不執行業務命令。

使用 Python 原協議 `sha256(method+' '+path+' '+json.dumps(data,sort_keys=True,ensure_ascii=False))` 比較既有 signature；TypeScript 序列化已與 Python 對照，包括 Unicode code point 排序與 JSON 原浮點 wire。原 method／path／payload 改變，或拿新版 signature 冒充原操作，均拒絕。保持原 requestKey，不產生新 UUID，不把舊 payload 直接送往新版 API。

回應只提供 committed 與目前可見的活動／投票入口，不回傳凍結的 owner／名單／私有內容／授權資料。活动／草稿／已刪除與投票刪除再次檢查；原時間投票沿用公開模型，沒有新增不存在的私有投票模式。原來源更新、帳號切換、登出或晚回應均不能把結果帶回舊頁。

查不到回執不能認定未建立，維持原 payload 與 key。`done` 來源狀態也不取代服務端原結果。查到回執仍只導向目前資料，不自動套用舊草稿、轉換、接受邀請或重送。

## 編輯與清除保護

新版活動新增／編輯／安排、時間投票新增、包廂、結算與款項編輯入口先核對相關舊紀錄。有原稿／原請求未完成映射時阻止掛載新版表單；未知紀錄阻止受保護編輯入口。這是過渡期防止重複操作的保護，尚未替代逐領域轉換器。

登出／帳號關閉沿用既有本機清除流程：先原子增加專用庫 epoch、禁止後續自動匯入及清除快照，再清除原庫已辨識 scope 的 draft／request；其他 namespace 不動。延遲匯入不能在清除後寫回，存活的舊分頁也不能重新自動搬入。來源清除 abort 保留原來源並顯示既有清除失敗提示，明確重試本機清除，不再發一次服務端登出。無法辨識的原 namespace 不宣稱已清除。

## 隔離驗證

- strict TypeScript、React／API／bot build 通過；既有 bundle 大小警告仍存在。
- 原回執 API／原保全紀錄、身份 bot、活動 bot、管理 bot 與隱私原生回歸 **34 項通過**；包括實際 Python 舊 signature 差分。
- 舊本機保全 **13 項**、既有活動／投票／財務／結算／草稿／登入／隱私 **64 項**，共 **77 項瀏覽器場景通過**，無跳過。包含完整瀏覽器 profile 重開、來源／目的交易 abort、來源競爭、延遲匯入及回應、切帳號、憑證隔離與清除重試；原回執缺失走實際 API，已提交入口／讀回應遺失的瀏覽器場景使用受控回應，原回執內容／權限由原生 API 測試驗證。
- 建置後隔離 API／bounded room worker、bot HTTP／WebSocket／ACK／Resume／原生 runtime／停機及備份 smoke 通過，沒有啟動正式 worker 或真實 QQ 投遞。
- 360px 原結算含圖保全頁檢視通過，無水平溢出；操作提示与欄位名稱保留，未添加裝飾文案。測試兩次抓到回歸定位誤判：IDB 按 key 排序而非輸入順序、登出失敗後登入入口已存在而清除仍在執行；已改成逐筆內容對照及等待本機清除實際完成。

## 尚未完成

本批完成來源保全與原結果查詢，**沒有完成完整 `kanban-local-v1` 遷移驗收**。逐領域轉換器仍須先綁定原 create intent／服務端原結果，再保留後續編輯、原時區與基準版本、付款人／名冊／圖片引用並轉為新表單；不能從有舊草稿推導第二筆建立。原非建立命令的精確協議重送、認領／交接／邀請及登入特殊憑證、匯出檔重新匯入、未知形狀分類仍需逐項完成。

跨裝置 create intent、實機／QQ WebView、實際候選 web 與 bot 組合、完整對帳、遷移與新寫入回退演練尚未完成。166 項能力維持 `in_progress`、`release_eligible=false`，依使用者要求不部署。
