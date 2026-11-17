# 第六十五批實作：成分關聯原稿與 PIN 回執持久化

日期：2026-11-18（Asia/Taipei）。分支 `codex/unified-rebuild`。變更範圍 **`web`**，實際發布範圍 **`none`**。只修改 React 管理介面、共用本機原稿層與收件匣索引；API、schema、outbox、bot 使用的網址、指令、政策及模板契約不變。保留現有 Python bot；未推送、未合入 main、未部署，未操作正式憑證、群設定、資料庫或真實待送工作。

## 關聯原稿與原操作

管理成分關聯改接 IndexedDB，保留原 v1 key 的帳號 scope、管理授權 scope 及成分 ID；target、reason、pending UUID／input／revision 逐欄延續。未送出原稿關頁後須明確恢復，重新取得預覽並確認；恢復、載入分頁衝突版本及保全版本都清除預覽與確認，不把原預覽當作可繼續授權的憑據。另提供明確放棄原稿，清除後才可轉做 PIN 重設。

送出前等 pending 的整筆本機交易提交，交易中止不發 HTTP；同步 busy guard 阻止連點，保存期間卸載不開始請求。已送出的關聯修正或解除只重試原目標（含 null）、原 revision、UUID 與 body；伺服器接受後若讀最新資料或保存本機確認失敗，仍保留原 pending。明確拒絕也先保存解除 pending 的狀態才解鎖。草稿 target／reason 與 pending input 不一致時保留原文並阻擋送出，不悄悄選用另一個目標。

## PIN 只保存操作編號

PIN 回執紀錄接上同一套持久原稿機制，但 payload 只允許 `{requestId}` 或完成後的 null。白名單新增兩種經審查的管理 key；PIN payload 在遷移、正常保存、分頁衝突保全及 retire 邊界都用嚴格契約驗證。PIN、重設原因與確認勾選只留記憶體，不寫入 IndexedDB、保全版本、sessionStorage 或 localStorage。

必須先提交操作編號，才送一次 PIN 命令；本機交易失敗時不送，記憶體中的 PIN 仍可核對。命令開始後清空輸入，未知結果關頁後由收件匣返回原成分，只用原 requestId 查回執，不重送 PIN。查不到完成紀錄時須先核對目前版本，再重新輸入並確認；成功後本機清除交易失敗也保留原 requestId。完成的 null 紀錄不再顯示成收件匣損壞操作。

格式異常的舊 PIN session 紀錄不直接匯入，留在原分頁來源並阻擋操作。由使用者明確下載原始檔後，才能清除這份紀錄並重新核對；不把可能混入的憑證複製到持久庫或保全版本。已被外部方式損壞的持久 PIN row 同樣先下載，再以 CAS 保護的明確清除處理，不另存損壞原文。下載檔的 bytes 已逐字核對。下載後若其他分頁已換成新操作編號，清除的 CAS 失敗會保留新紀錄，並提供讀取已保存版本的入口；異常舊原文不會被收入版本庫。隔離舊 session 原文時仍先取得管理清除世代，防止無分頁訊號的撤權後寫回。其他一般原稿繼續使用既有的版本保全；沒有因此減少其保全內容。

## 同頁流程與權限

共用原稿層拆出不註冊 router blocker 的 `useDurableValue`，原 `useDurableRecord` 保留頁面離開／關頁保護。成分關聯頁只註冊一個 blocker，納入子流程的 PIN、未送出原因、讀取／保存狀態及待確認回執；離開時保存一般原稿，明確告知 PIN 不會留下。原稿層新增僅在記憶體保留的 damagedRaw，供 PIN 特殊保全使用，不自動序列化。

兩個分頁可能分別留下關聯及 PIN pending。重開同一頁時仍能先查回原 PIN 回執，再處理原關聯命令；不因兩個表單互相鎖定而失去查回入口，也不解鎖另一筆新修改。管理清除世代繼續阻擋無 BroadcastChannel 的舊分頁；PIN 世代失效時清空記憶體輸入，不發 HTTP。查詢、預覽、保存及歷史遇到 401／403 會刷新管理授權，由共用 gate 清除失效管理快取與原稿。

## 驗證與剩餘工作

`durable-admin-ownership.spec.ts` 新增 22 項：關聯／PIN 的關頁收件匣查回、成功後確認交易 abort、pending 交易 abort、成功後讀取失敗保原操作、原 session 提交後才移除來源；關聯原稿明確恢復與重新預覽、PIN／原因／確認僅記憶體與唯一 blocker、雙分頁保全與下載、兩種異常 PIN 原文下載及不入版本庫、雙 pending 查回、無分頁訊號撤權阻擋、解除關聯的 null 目標精確重試、草稿與 pending 目標不一致保全。

既有關聯／PIN 的 14 項瀏覽器測試已通過，保留原關聯／解除、選擇保全、PIN 真正改寫後可找回、原歷史分頁、未送出口令捨棄及伺服器 revision 競爭。不同裝置的競爭改用獨立 context，並在 finally 完整關閉，避免伺服器退出等待殘留連線；同瀏覽器的 CAS 衝突另有測試。新增 22 項完整通過，93 個原生測試檔共 807 項通過，建置／strict TypeScript、建置後 API／TypeScript bot 隔離冒煙及原 bot 三語網址檢查通過。360px 的關聯保全版本、核對表單及異常 PIN 保全操作畫面已檢視，沒有水平溢出。全站 500 項瀏覽器回歸全部通過（10.6 分鐘）；其後補上的兩項 PIN 隔離競態另經重新建置與專項驗收。

A06／A10、O04／O05 保持 `in_progress`。剩餘包括成分已被其他操作刪除後的關聯／PIN 原回執入口（目前 profile loader 仍依賴可讀成分）、管理刪除收據 secret、bot 設定與其他領域表單、舊 session recovery 副本與 `kanban-local-v1` 同源遷移、完整匯入／匯出與跨裝置 create intent、實體裝置／真實 QQ 及實際切換版本組合驗收。166 項能力未整體 accepted，`release_eligible=false`；本批不構成全站完成或正式切換核准。
