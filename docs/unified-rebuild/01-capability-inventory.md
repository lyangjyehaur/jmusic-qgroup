# 現有功能與保留矩陣

日期：2026-11-17。發布範圍：`none`。這是依本機程式、契約與測試交叉盤點的保留基線，不是新版實作／測試通過清單。

每個 ID 為後續不可省略的驗收單位，表內多個動作均須覆蓋，不能只驗其中一個。新入口是設計位置，並非現在已存在的路由。`依據` 對照文末來源及測試組；測試存在只表示可用作行為素材，本輪未重跑既有業務測試。後端可用但 UI 不可達、僅舊碼留存或明確停用的能力，另在最後區分。

## I. 帳號、身分與隱私

| ID | 既有能力 | 統一後入口 | 必須保留的驗收行為 | 依據 |
| --- | --- | --- | --- | --- |
| I01 | 匿名瀏覽／訪客 session | 公開活動與登入 | 看公開活動不建立 users；成員寫操作須登入 | 身分 |
| I02 | QQ 登入、既有帳號綁定、回調確認 | 共用登入流程 | bind／login 分流、原 session／state、一次性期限；本人確認才建帳號或切換 | 身分 |
| I03 | 回到活動／邀請原任務 | 登入後返回 | 保留 event／poll／action／邀請上下文，取消不改身份 | 身分、前端 |
| I04 | QQ 衝突與拒絕自動合併 | 帳號 | 已綁另一人、當前綁另一 QQ 不覆蓋；稱呼不作識別 | 身分 |
| I05 | 名稱註冊開關與隱私同意 | 登入／管理 | 預設關閉，API 不繞過；版本化明確同意，不刪既有帳號 | 身分、管理 |
| I06 | 站內稱呼、外部暱稱／頭像 | 我的／個人卡 | 改稱呼不換 ID；QQ 暱稱不覆蓋既有稱呼；頭像失敗有退路 | 身分、名冊 |
| I07 | 多帳號授權與明確切換 | 我的帳號 | 同裝置保留授權、scope 隔離；舊頁寫入拒絕；不自動搬資料 | 身分、恢復 |
| I08 | 跨裝置一次性連結 | 我的裝置 | 10 分鐘／一次使用、產生／接受均確認；接受不自動切帳號 | 身分 |
| I09 | 裝置查詢、撤銷與帳號紀錄 | 我的裝置 | 不能誤撤當前裝置；撤另一裝置不抹除其其他帳號 | 身分 |
| I10 | UnionID 狀態與重授權引導 | 帳號／提示 | 綁定原 QQ、不先登出；提醒節流；只回傳狀態，不宣稱 bot 已綁定 | 身分 |
| I11 | 看板與成分單邊／新會員進入 | 我的成分 | 已關聯一次登入；無成分按意圖建立，並行／重試不重複；不搶舊資料 | 成分身分 |
| I12 | 舊 QQ＋PIN 找回與 QQ 授權關聯 | 找回成分 | PIN 4–6 位、QQ／IP 持久限流；十分鐘意圖綁原 session，取消可重試 | 成分身分 |
| I13 | 固定成分 ID、自填聯絡 QQ | 我的成分／個人卡 | 舊數字鍵與新 m_ 鍵區別；自填號可清空、查詢／複製且非認證；重號拒絕 | 成分身分 |
| I14 | 帳號註銷與共享紀錄待審 | 我的隱私 | 未交接活動／投票先拒絕；撤 session／身份／管理權、保留共享帳務並真實標待審 | 隱私 |
| I15 | 成分刪除、重建與防復活 | 我的隱私／管理／維運 | 與帳號註銷分開；新建全新 ID；最新刪除 ledger 在恢復／匯出優先 | 隱私、成分維運 |
| I16 | 當前裝置登出與敏感資料隔離 | 共用帳號選單 | 清理該 session 與意圖，不登出其他裝置；私人快取不跨帳號 | 身分、隱私 |

## E. 活動生命週期與安排

| ID | 既有能力 | 統一後入口 | 必須保留的驗收行為 | 依據 |
| --- | --- | --- | --- | --- |
| E01 | 活動列表、本人參與、往期／歸檔 | 活動 | 依權限過濾，待補款但不再代管者仍找得到相關活動 | 活動、前端 |
| E02 | 建立／編輯、類別與時長預設 | 活動表單 | 類別、地點、說明、開始、時長、時區、截止、容量、最低人數、費用完整 | 活動 |
| E03 | 伺服器草稿、發布自動本人報名 | 我的發起 | 草稿限有權者；發布驗證安排並自動報發起者，發起者可按規則退出；舊 API 的明確 join_owner=false 兼容語意有對應測試 | 活動、名冊 |
| E04 | 複製活動與本機草稿 | 活動發起 | 只複製安排；日期／截止重填，不複製人、錢、圖、協辦與歷史 | 恢復 |
| E05 | 公開／邀請可見性與分享 | 活動詳情 | 邀請 access 授權原則、有限預覽、私有圖／歷史不能旁路 | 活動、名冊 |
| E06 | 暫停／恢復報名、截止 | 活動管理 | 報名開關與生命週期獨立；截止後不自動遞補 | 活動、名冊 |
| E07 | 最低成團確認 | 活動管理／待辦 | 人數不足仍可附原因確認；不自動取消 | 活動 |
| E08 | 預定／實際開始結束與延長 | 活動概況 | 預計超時不等於實際結束；跨日與未知時區不猜測 | 活動 |
| E09 | 取消、歸檔／取消歸檔與受限刪除 | 活動管理 | 取消須原因、可處理取消損失；歸檔不刪帳；remove 保留原資料／款項阻擋條件，已刪不出現在列表 | 活動 |
| E10 | 安排版本與重要改動原因 | 活動編輯／紀錄 | 時間、地點、費用等重要變動建快照，現有人員標待確認 | 活動 |
| E11 | 逐人接受／拒絕新安排 | 我的報名 | 本人／原管理人決定；拒絕需原因，不自動退出或收新費 | 活動、名冊 |
| E12 | 協辦 scope 邀請與撤銷 | 活動管理 | schedule／roster／attendance／settlement 分開，本人接受才授權 | 管理交接 |
| E13 | 指定結算人 | 活動管理／結算 | 可接受／替換／撤銷；每場一位指定者，其他協辦 scope 保留 | 管理交接、結算 |
| E14 | 發起者轉交 | 活動管理 | 受邀者接受、舊邀請失效、原人保留自己的報名／資金責任 | 管理交接 |
| E15 | 出席、遲到、早退、缺席及實際時間 | 活動名單 | 與名額／費用獨立；結束後更正需原因，不回寫舊帳單 | 出席 |
| E16 | 現場補錄 | 活動名單 | roster＋attendance、首版帳單前、超額／繞候補明確確認 | 出席 |
| E17 | 可見操作歷史與分頁 | 活動紀錄 | 前後快照、時間、操作者、原因；不洩漏邀請 token／私人申報 | 活動、稽核 |
| E18 | 摘要複製與高德導航 | 活動分享／地點 | 剪貼簿失敗可選文；導航由點擊開啟、不請求定位 | 恢復、前端 |

## R. 報名、同行、候補與認領

| ID | 既有能力 | 統一後入口 | 必須保留的驗收行為 | 依據 |
| --- | --- | --- | --- | --- |
| R01 | 本人報名、確認費用安排 | 活動主動作 | 預覽綁當時規則／revision，提交不可默認接受新規則 | 名冊 |
| R02 | 同行／純代報、逐人備註與付款歸屬 | 報名表單 | 不創假帳號；每人獨立 attendee；manager 不等於 payer | 名冊 |
| R03 | 個別／整組排隊、混合分配 | 報名預覽 | 整組不足全候補且阻後方；混合正式候補須 accept_partial | 名冊 |
| R04 | 待確認與確認參加 | 我的報名 | 待確認不占位；確認取新組序，不繼承先前優先 | 名冊 |
| R05 | 後加同行與重新報名 | 我的報名 | 取新組序；不影響已正式者、不繼承原報名隊位 | 名冊 |
| R06 | 改稱呼／備註／付款標記／拆組 | 名單管理 | 依本人／管理人／角色判斷，管理他人需理由；拆組遵循隊列 | 名冊 |
| R07 | 截止前退出與候補遞補 | 我的報名 | 原正式保留、按原隊序補；不在關閉／截止後自動補 | 名冊 |
| R08 | 逾期退出申請、同意／拒絕 | 我的報名／待辦 | 必填原因，批准前留位；候補／待確認可直接退出 | 名冊 |
| R09 | 補報名邀請、有限預覽與接受 | 活動管理／邀請 | 邀請不占位；單次接受、額滿明確接受候補，不重複本人報名 | 名冊 |
| R10 | 代報認領邀請／申請／審核／撤銷 | 名單／認領連結 | 7 天、原管理權重驗、未審不授私有內容、不按同名合併 | 認領 |
| R11 | 認領後保持原隊位與付款責任 | 認領／結算 | attendee／party／排序／帳單／原投入不變；既有付款來源凍結 | 認領、財務 |
| R12 | 同名與頭像／成分浮層 | 活動名單 | 同名各一筆；浮層只屬該人，同行不借代報者偏好，關閉不加歷史 | 名冊、成分卡 |
| R13 | 上限與並行衝突 | 報名與管理 API | 每批 1–20 人、有限容量至 500；並行不超賣，409 保稿重預覽 | 名冊、恢復 |

## T. 時間投票

| ID | 既有能力 | 統一後入口 | 必須保留的驗收行為 | 依據 |
| --- | --- | --- | --- | --- |
| T01 | 日期／精確時段建立與草稿 | 活動→發起投票 | 月曆選不連續日期、至少兩項、按需增刪；無舊固定項數上限 | 投票 |
| T02 | yes／maybe／no、改票與填答進度 | 投票詳情 | 一次提交有效候選，不默認補票、不自動報名 | 投票 |
| T03 | 批次只填未選項 | 投票詳情 | 已選答案不被覆蓋，支援鍵盤與清楚選中狀態 | 投票 |
| T04 | 候選逐一失效與保留舊票 | 投票詳情 | date 按該地日末、exact 按開始；過期不可改但歷史保留 | 投票 |
| T05 | 截止調整、提前關閉與取消／刪除 | 投票管理 | 截止早於最後候選失效；舊截止不偷偷延長 | 投票 |
| T06 | 統計、最高票、定案原因 | 投票結果 | 只比較未過期候選，低票定案按既有規則附原因 | 投票 |
| T07 | 定案建立正式活動 | 投票→活動 | 關聯唯一活動，版本競態重驗，原票不等於報名 | 投票 |
| T08 | 群同步、通知與手動分享 | 投票管理／bot | 新投票預設同步、活動沿用；延遲通知只摘要有效候選 | 投票、機器人 |
| T09 | revision／vote revision／去重 | 投票 API | 不重複定案建活動，不用過期表單覆寫新票或新管理決定 | 投票 |

## P. 正式包間與成分分房

| ID | 既有能力 | 統一後入口 | 必須保留的驗收行為 | 依據 |
| --- | --- | --- | --- | --- |
| P01 | 預分包間、命名與穩定 ID | 活動分房 | 最多 50 間、名稱同場不重複；只有發起者調整正式安排 | 包間 |
| P02 | 正式／候補／未分配與房付款人 | 活動分房 | 每 attendee 至多一房、可未分；多人同一付款人不合併均攤 | 包間 |
| P03 | 本人房／同行標示及名單 | 活動概況 | 本人依 attendee 的 is_me；歷史帳單保留舊姓名 | 包間 |
| P04 | 安排版本、歷史與可見性 | 活動分房／紀錄 | 追加快照，不改報名、管理權、原費用或實收付 | 包間 |
| P05 | 自選群友合拍分析 | 同好→自由分房 | 至少兩人、既有選取上限、共同項／平均／最差／孤立提示 | 分房演算 |
| P06 | 按房數／容量／自訂人數分房 | 自由試算／活動分房 | 容量守恆、同人不重複、保留性別選項與無性別資料情況 | 分房演算 |
| P07 | 手動調整與重新計分 | 分房工作區 | 會員移房後重算極值、共同項與孤立提示，不能僅改畫面 | 分房演算 |
| P08 | 按活動取得名冊、成分對應與更新 | 活動分房 | 對應穩定 user／attendee；找不到成分仍保留原報名者 | 分房演算、成分身分 |
| P09 | 切活動／來源失敗時結果失效 | 分房工作區 | 不拿舊結果套新場；讀取失敗不可當空名單 | 分房前端 |
| P10 | 自由／活動分房分享圖片 | 分房分享 | 保留匯出、長名稱及手機閱讀；不曝私人性別／留言 | 分房前端 |

現有 P05–P10 是試算，不會保存成 P01–P04。新系統新增「採用為正式分房」橋接；需獨立預覽與權限驗收，不將兩類資料直接混用。

## S. 應付結算、碼庫與歷史圖片

| ID | 既有能力 | 統一後入口 | 必須保留的驗收行為 | 依據 |
| --- | --- | --- | --- | --- |
| S01 | 舊人均帳單與明確轉逐人 | 活動結算 | 舊分母／金額不重算；轉換建立新版，不猜責任 | 結算 |
| S02 | 正式人員與非正式例外核對 | 結算編輯 | 正式全部列入；缺席／退出／拒絕安排及特殊人員需原因 | 結算 |
| S03 | 普通 AA、半 A、免共同費 | 結算編輯 | 0／0.5 份保留人；免共同仍可負擔單獨費用 | 結算 |
| S04 | shares／equal／weights／fixed／duration | 費用項目 | 指定範圍、0–1000 三位比例、0–1440 分鐘、固定額精確對平 | 結算 |
| S05 | 店家退差／減免、零元結算 | 費用項目 | 負項以類型扣減，總額和個人淨額非負，不能假記資金退款 | 結算 |
| S06 | 多人合付、代付與額外付款人 | 付款責任 | 一人多人付款／多人同付均保存，ID 不按稱呼合併 | 結算 |
| S07 | 精確分攤及原排序補分 | 結算計算 | 整數分／有理數／最大餘數；重排請求不改結果 | 結算 |
| S08 | 預覽、發布與重複提交 | 結算發布 | 綁 revision／base_version／名單／帳本，only settlement scope；一次入帳 | 結算、包間 |
| S09 | 不可變版本、改額／改備註／改圖 | 結算歷史 | 任一真實變動追加版，同內容不加版；保留操作者與修改項 | 結算 |
| S10 | 消費憑證、微信／支付寶／其他碼 | 結算／圖片檢視 | 圖片格式／大小／總量、原圖／下載／失敗重試；每版獨立引用 | 媒體、結算 |
| S11 | 私人收款碼庫、重用／封存 | 我的收款碼 | 只本人管理；刪／封存碼庫不改舊帳圖片與版本 | 媒體 |
| S12 | 實際包間人員／費用核對 | 包間結算 | 每位結算人歸一房、每房整數分對平；有效款項 room_id 不消失 | 包間 |
| S13 | unpaid／paid／recorded 與隨單墊付 | 包間結算發布 | 指定付款不等於已付；paid 以真實時間方式原子追加 expense，不重記舊支出 | 包間、財務 |
| S14 | 發布快照與現況帳本分開 | 活動結算／bot | 舊版人名／安排／房間／付款不隨現況變；新差額依新帳本投影 | 包間、結算 |

## F. 實際款項與對帳

| ID | 既有能力 | 統一後入口 | 必須保留的驗收行為 | 依據 |
| --- | --- | --- | --- | --- |
| F01 | 本人／管理同行申報與撤回 | 活動帳本 | 申報是待核對主張，不算已收；只能本人責任／受管理未綁同行 | 財務 |
| F02 | 確認、拒絕與私人申報原文 | 核對待辦 | 有結算權者核對原額，拒絕須原因；未確認原文不向其他人公開 | 財務 |
| F03 | collection／refund／reimbursement | 款項登記 | 預收、實收、實退及償還墊付各有真實對象，不自動發起支付 | 財務 |
| F04 | expense／merchant_refund | 款項登記 | 個人先付與代收池支付分清，退款關聯原支出或抵扣 | 財務 |
| F05 | deposit／deposit_return／deposit_apply | 訂金／押金 | 訂金非消費，退回與抵損失分開，關聯剩額不能為負 | 財務 |
| F06 | credit_transfer／cash_transfer | 款項更正／交接 | 責任歸屬調整與實際資金移交不同；需理由且對平 | 財務 |
| F07 | 預覽、實際時間／方式與原子提交 | 款項表單 | 正額、時間不能未來；預覽隨輸入失效，409 不偷改金額重送 | 財務、恢復 |
| F08 | 追加式沖銷與關聯保護 | 帳本歷史 | 不 UPDATE／DELETE；先處理已退款／抵扣依賴，不能沖銷沖銷 | 財務 |
| F09 | 待補／應退／持有款／訂金及恆等式 | 本人摘要／帳本 | 無逐人帳單不猜應付；同行管理權不代表本人金額；改帳不搬錢 | 財務 |
| F10 | 各包間投影與轉款清單 | 包間帳本 | 不跨房花代收、不跨房退款／關聯；同收款人可合計但不淨抵 | 包間、財務 |
| F11 | 結清、重新開啟與檢查點 | 帳本 | 每人／房／店家／訂金／持有款／申報均對平；新帳或新款重新待處理 | 財務、包間 |
| F12 | 歷史分頁、凍結實際人與原付款人 | 帳本／歷史 | 同名不合併，退出／轉交／認領後舊款與查看責任保留 | 財務、認領 |

## M. 音樂成分、詞條與匹配

| ID | 既有能力 | 統一後入口 | 必須保留的驗收行為 | 依據 |
| --- | --- | --- | --- | --- |
| M01 | 領域／細分、分類與詞條全集 | 音樂 | kind 與 category 區分、分類只列實際資料；不轉換使用者原文 | 音樂 |
| M02 | 名稱、拼音、首字母／假名搜尋 | 音樂搜尋 | 現有搜尋正規化、清空、`/` 快捷鍵與分類篩選可用 | 音樂前端 |
| M03 | 領域最多 5、細分最多 15、合計 20 | 成分編輯 | 前後端都驗證，保存至少 1；未開始的空白 profile 允許存在 | 音樂 |
| M04 | 領域與細分四級熟悉度 | 成分編輯 | 本命／常聽／聽過一些／只聽幾首；領域與細分均可調整；舊資料不無聲改值 | 音樂、成分選取 |
| M05 | 已選清單、分類收合與移除 | 我的成分 | 和搜尋／排行共用同一 selection，不維護兩份草稿 | 成分選取 |
| M06 | 未保存草稿、變更保存列 | 成分編輯 | 有變更才顯示，保存失敗保留；背景更新／改聯絡號不覆蓋 | 成分選取、音樂前端 |
| M07 | 會員自建詞條與建立數限額 | 建立詞條／我的詞條 | 領域 2／細分 8、名稱至 24 字、正規化重名拒絕並指向既有詞條 | 音樂 |
| M08 | 自建詞條改名／分類／類型 | 我的詞條 | 只本人建立者可改，重名檢查；管理員另有完整權限 | 音樂 |
| M09 | 自建詞條刪除保護 | 我的詞條 | 有人已選不能由建立者刪除，避免他人選擇被抹除 | 音樂 |
| M10 | 領域／細分熱門榜與人數 | 音樂排行 | 兩類獨立排序／展開；會員、詞條和近期統計保留 | 音樂、音樂前端 |
| M11 | 列表／氣泡展示 | 音樂排行 | 氣泡標籤與點擊詞條可用；列表為可及性退路 | 音樂前端 |
| M12 | 詞條詳情與誰選了 | 詞條詳情 | 可看選取者、選／取消詞條，沿用登入與可見範圍 | 音樂 |
| M13 | 相似推薦與共同／不同偏好 | 同好／個人卡 | 領域／細分拆分、各自程度、共同本命、冷門、覆蓋、比例與標籤完整 | 匹配 |
| M14 | 冷門／共同項與熟悉度兩種排序 | 同好 | 保留 tie-break、證據折算、個人偏好及顯示分上限 | 匹配 |
| M15 | 資料不足群友分區 | 同好 | 少量選擇不造成虛假的高排名；主榜與 sparseMatches 都保留 | 匹配 |
| M16 | 指定 QQ／成分 ID 比較 | 同好比較 | 支援自填別名、拒絕自己／不存在；展示共同／各自獨有與程度 | 匹配、成分身分 |
| M17 | 個人成分檢視與聯絡複製 | 同好個人頁 | 未公開性別不出現、QQ 明確為自填；不回傳身份憑證 | 音樂、成分身分 |
| M18 | 最相近相關的私人留言 | 我的成分／同好 | 最多 140 字、可清空；按實際 viewer 規則限制，不當公開自介 | 匹配 |
| M19 | 性別、可選自訂與公開開關 | 我的成分 | 可空、自訂至 12 字、公開開關；分房可用不等於到處顯示 | 音樂 |
| M20 | 成分分享卡、複製清單、原生分享 | 我的成分分享 | Canvas 圖、下載與分享可用，API 不可用時有退路，無憑證／私人留言 | 音樂前端 |
| M21 | 趨勢圖、排行漲幅與最近新增 | 音樂趨勢 | 取樣、圖例、時間、新詞條／新會員／近期統計完整，不混為通知 | 趨勢 |
| M22 | 聚類／圈子分析 API | 同好圈子 | 現有 minLink、群組／獨立成員和共同項結果保留；舊 UI 入口缺失另記 | 趨勢 |

## C. 喊話、外觀與行動使用

| ID | 既有能力 | 統一後入口 | 必須保留的驗收行為 | 依據 |
| --- | --- | --- | --- | --- |
| C01 | 發喊話／找搭子 | 同好找搭子 | 最多 140 字、每 24 小時一條、顯示冷卻與錯誤，不靠前端限流 | 喊話 |
| C02 | 活躍喊話、詳情及內容／聯絡複製 | 找搭子 | 發布者資料依權限、複製失敗有退路，不把自填 QQ 當驗證 | 喊話、音樂前端 |
| C03 | 過期歸檔與歷史分頁 | 找搭子歷史 | 30 天、歷史至 500、分頁／更多；不可把過期當已刪 | 喊話 |
| C04 | 深淺主題與偏好保存 | 我的外觀 | 跨領域一致；不因切頁重設主題或草稿 | 音樂前端、前端 |
| C05 | 壁紙輪播與會員開關 | 我的外觀 | 管理配置與個人停用分開；移植後可用，不強制舊色彩或佈局 | 音樂前端、成分管理 |
| C06 | PWA manifest／更新提示／SW 範圍 | 全站 | 舊 /music/ 安裝者可更新；API／登入導覽不被離線快取越權 | 成分建置 |
| C07 | 回頂部與手機固定工具 | 全站 | 底導覽／保存／鍵盤不互遮、長名稱可換行、尊重減少動效 | 成分選取、音樂前端 |

## A. 統一管理功能

| ID | 既有能力 | 統一後入口 | 必須保留的驗收行為 | 依據 |
| --- | --- | --- | --- | --- |
| A01 | 帳號管理員／救援憑證登入 | 單一後台 | 逐請求重查角色，CSRF 綁 session／角色版本；憑證輪替立即撤銷 | 管理 |
| A02 | 使用者搜尋／分頁／UnionID 篩選 | 後台帳號 | 每頁 20，稱呼／ID／第三方暱稱／時間辨識；不出 OpenID／UnionID | 管理 |
| A03 | 管理員授予／撤銷與角色歷史 | 後台帳號 | 不自撤帳號管理權、註銷不可再授權，稽核同交易 | 管理 |
| A04 | 手動 QQ 與內部備註 | 後台帳號 | 各自版本／唯一檢查，僅後台，不能拿來登入或對照成分 ownership | 管理 |
| A05 | 成分關聯搜尋與狀態查看 | 後台帳號／成分 | 未關聯、prelink、OAuth 分開；不出 PIN hash／私人備註 | 成分管理 |
| A06 | 關聯修正／解除／版本競態／稽核 | 後台成分 | 原連結與舊會話撤銷、資料保留；override 重啟不復活舊 JSON | 成分管理 |
| A07 | 有限管理員安排協助編輯 | 活動支援 | 已發布、可查看、未結算且未終止；須原因、通知原發起者，不能擴財權 | 管理、活動 |
| A08 | 註冊政策與刪除申請處理 | 後台隱私 | 版本更新／說明紀錄；有共享紀錄不可勾成全部刪完 | 管理、隱私 |
| A09 | 詞條完整 CRUD 與合併 | 後台音樂 | 來源／目標、選擇程度與建立紀錄完整處理，無重名或孤兒選擇 | 成分管理 |
| A10 | 會員／選擇查看、舊 PIN 重設 | 後台成分 | 管理員不需先有成分；PIN 不作站內登入，已綁會員不放開舊 PIN | 成分管理 |
| A11 | 成分會員刪除與全站成分重置 | 後台危險操作 | durable erasure 優先、清身份／會話／投影、不刪活動或偽造已刪全帳號 | 成分維運 |
| A12 | 喊話清單與管理刪除 | 後台找搭子 | 活躍／歷史可查、刪除不殘留發布者敏感資料 | 喊話、成分管理 |
| A13 | 壁紙上傳／刪除／開關／順序／設定 | 後台外觀 | PNG／JPG／WebP 單張 2 MiB，路徑／格式保護，持久資料卷與備份 | 成分管理 |
| A14 | 成分 JSON 匯出與歷史備份下載 | 後台資料 | 當前身份／刪除投影優先，不是完整恢復包；不重新啟用舊管理口令 | 成分維運 |
| A15 | 管理退出行為 | 後台 | 帳號方式登出當前會員＋管理，憑證方式只清獨立管理；其他裝置保留 | 管理 |

## B. QQ bot 與其後台

| ID | 既有能力 | 統一後入口 | 必須保留的驗收行為 | 依據 |
| --- | --- | --- | --- | --- |
| B01 | 六主指令、快捷別名、簡繁與幫助 | QQ／後台 bot | 全部現有指令表保留，裸 @ 活動、未知幫助；連結不執行寫操作 | bot 指令 |
| B02 | 多場數字序號／8–16 位短碼與往期查詢 | QQ | 不歧義猜場；相同候選排序、錯碼提示；公開查詢不要求群同步 | bot 指令 |
| B03 | 名單、人數、正式／候補與倒計時 | QQ 卡片 | 名稱按隊序各至 10；不附私有備註／身分，超長有退路 | bot 視圖 |
| B04 | 發布／變更／開始／截止／取消／結算等通知 | outbox／QQ | 逐場同步與全局通知類型分開；草稿／私有／撤權發送前再驗 | 機器人 |
| B05 | 有人報名、退出與遞補合併通知 | outbox／QQ | 實際變動才通知，待確認／待審不發；同次退出與遞補一則，去重 | 機器人 |
| B06 | 發送模式與手動重送 | 後台／活動 | 沿部署／模擬／實際，模擬不算送出；重送不重做業務、不回放舊提醒 | 機器人 |
| B07 | 模板、預覽、版本與恢復前版 | 後台 bot | 保存追加版本、最新設定套用；已投遞內容不改，未來排程重算 | bot 設定 |
| B08 | 群發現、允許清單與通知目標 | 後台 bot | group_openid 非 QQ 群號；空政策全停；換群作廢舊工作、不轉發給新群 | bot 設定 |
| B09 | 提醒、勿擾、發送間隔與節流 | worker／後台 | 延後不耗失敗次數、跨重啟保持；公開回覆即時；重排只影響未來 | bot 設定、機器人 |
| B10 | outbox 租約、退避重試與不確定投遞 | worker | claim 過期不能回寫、逐條失敗不阻整批；不承諾恰好一次 | 機器人 |
| B11 | Markdown 模板、按鈕及回呼 | QQ／後台 | 容量與平台限制、事件去重、回呼每次驗群／權限、普通文字退路 | bot Markdown |
| B12 | 縮寫、引用英文辨識與完整結果 | QQ | /缩写／/縮寫／nbnhhsh、分段／大小寫／引用訊息、敏感詞遮罩及交付退路 | 縮寫 |
| B13 | 設定載入版本、診斷與投遞紀錄 | 後台 bot／活動 | 版本不等連線健康、最近紀錄與失敗原因、敏感資料遮罩 | bot 設定、bot 維運 |
| B14 | 官方 gateway、Resume、心跳與 token | worker | ACK 超時重連、恢復會話、HTTP 失敗／重試、健康檔位置一致 | bot 維運 |
| B15 | 結算明細公開設定與個人功能限制 | bot／政策 | 既有群額明細設定需告知；未完成身份綁定不發個人款項或私聊 | 機器人、隱私 |

現有指令全集：`活動、報名、我的、結算、管理、幫助、名額、待辦、出席（簽到）、同行、退出、發起、再約、待確認、確認安排、地點、規則、款項、帳本、已付款、申報、補報、認領、協辦、往期、縮寫`，含程式的簡繁與英文 aliases。群內直接報名、個人金額與自動支付不是現有能力，不在保留矩陣中假稱已有。

## O. API、恢復、語言、統計與部署

| ID | 既有能力 | 統一後入口 | 必須保留的驗收行為 | 依據 |
| --- | --- | --- | --- | --- |
| O01 | 合作方公開 v1 列表／明細／名冊／包間 | 原 /api/public/v1 | Bearer、未配置停用、GET／HEAD、分頁／篩選、白名單、CORS／快取政策不變 | 公開 API |
| O02 | /music/ 及內部成分／管理橋接權限 | 遷移 adapter／新 policy | 拒絕偽造 context；內部接口不因改架構變成公開，舊網址仍可銜接 | 成分橋接 |
| O03 | 全部活動／邀請／投票／bot 深連結 | 舊網址 adapter | 每種 query／hash／action 精確轉換、返回正常，不默認執行 | 前端、bot 指令 |
| O04 | IndexedDB 草稿、圖片與身份隔離 | 全站表單 | 活動／結算／款項及投票恢復保原版本；明確恢復，不沿用舊預覽 token | 恢復、投票 |
| O05 | 未知結果查回、安全重試與 create intent | 收件匣／API | 先持久化再送；失敗不送、原 key 原 payload；query 重新驗權，不重複建場 | 恢復 |
| O06 | revision／idempotency／追加稽核 | 全部 mutations | 業務／紀錄／通知／結果同交易；409 保稿，不自動覆寫 | 稽核、恢復 |
| O07 | 動態待辦、未讀與通知已讀 | 收件匣 | 已讀不代表完成；按最新安排／認領／退出／申報／款項推導 | 恢復、稽核 |
| O08 | Accept-Language 簡繁與原文邊界 | 全站含說明／後台 | 主站既有最高優先語言策略保留並擴到新共用頁；用戶內容／協議值不轉換 | 語言 |
| O09 | 手冊、隱私、聯絡與回調說明 | 共用公開頁 | 原 URL、簡繁與 ICP 資訊、政策用途保留，重構後手冊更新 | 前端、隱私 |
| O10 | Umami 頁面與互動白名單 | 共用統計服務 | 僅正式 origin；無輸入／名字／金額／ID／token，失敗不阻功能 | 統計 |
| O11 | 靜態壓縮、MIME、ETag／快取與安全標頭 | API／靜態服務 | JS 正確 MIME、API 不快取私有內容、CSP／同源／請求大小與限流 | HTTP、成分建置 |
| O12 | SQLite 版本遷移、備份與圖片配對 | 維運工具 | 重複執行保原列、完整性與外鍵；不拿舊 registrations 重建新名冊 | 儲存 |
| O13 | music 原子寫入、維護鎖、配對保全 | 遷移／新備份工具 | JSON／身份／壁紙與 erasure 有一致快照；恢復不重啟舊管理入口 | 成分維運 |
| O14 | 可追溯來源、雙遠端及獨立版本組合 | 發布工具／manifest | 合遠端 main、完整 SHA、核准 archive、兩遠端 SHA；按相容性選 web／bot／both | 發布 |
| O15 | 服務健康、最小權限與資源隔離 | API／worker／部署 | 非 root、唯讀 rootfs、機密外置、健康與版本分開、驗證限資源 | 發布、bot 維運 |

## 來源與現有測試組

以下為相對本文件可開啟的原始依據。索引快照另保存每個檔案的函式／入口／測試名稱，後續可據此補齊細分案例。

| 依據鍵 | 程式／契約 | 現有測試素材 |
| --- | --- | --- |
| 身分 | [accounts](../../qgroup_core/accounts.py)、[identity](../../qgroup_core/identity.py)、[QQ](../../qgroup_core/qq_oauth.py)、[UnionID](../../qgroup_core/unionids.py)、[身分契約](../identity-contract.md) | [accounts](../../tests/test_accounts.py)、[identity](../../tests/test_identity.py)、[QQ](../../tests/test_qq_oauth.py)、[UnionID](../../tests/test_unionids.py) |
| 成分身分 | [service](../../music_site/service.py)、[identity_store](../../music_site/identity_store.py)、[contacts](../../music_site/contacts.py)、[說明](../../music_site/README.md) | [music](../../tests/test_music_site.py)、[music link](../../tests/test_music_link.js) |
| 隱私 | [privacy](../../qgroup_core/privacy.py)、[maintenance](../../music_site/maintenance.py)、[政策維運](../privacy-operations.md) | [privacy](../../tests/test_privacy.py)、[maintenance](../../tests/test_music_maintenance.py) |
| 活動 | [events](../../qgroup_core/events.py)、[lifecycle](../../qgroup_core/lifecycle.py)、[conditions](../../qgroup_core/conditions.py)、[契約](../activity-contract.md) | [flow](../../tests/test_activity_flow.py)、[API](../../tests/test_api.py)、[admin events](../../tests/test_admin_events.py) |
| 名冊 | [roster](../../qgroup_core/roster.py)、[Roster TSX](../../ui/board/Roster.tsx)、[契約](../roster-contract.md) | [roster](../../tests/test_roster.py)、[avatars](../../tests/test_roster_avatars.py)、[roster JS](../../tests/test_roster_avatars.js) |
| 認領 | [identity](../../qgroup_core/identity.py)、[契約](../identity-contract.md) | [identity](../../tests/test_identity.py) |
| 管理交接 | [management](../../qgroup_core/management.py)、[permissions](../../qgroup_core/permissions.py)、[Management TSX](../../ui/board/Management.tsx) | [activity](../../tests/test_activity_flow.py)、[rooms](../../tests/test_rooms.py) |
| 出席 | [attendance](../../qgroup_core/attendance.py)、[契約](../activity-contract.md) | [activity](../../tests/test_activity_flow.py) |
| 稽核 | [audit](../../qgroup_core/audit.py)、[server](../../server.py) | [roster](../../tests/test_roster.py)、[API](../../tests/test_api.py) |
| 投票 | [time_polls](../../qgroup_core/time_polls.py)、[Polls TSX](../../ui/board/Polls.tsx)、[契約](../time-poll-contract.md) | [polls](../../tests/test_time_polls.py)、[poll JS](../../tests/test_time_polls.js)、[deadlines](../../tests/test_poll_deadlines.js)、[bot polls](../../tests/test_time_poll_bot.py) |
| 包間 | [rooms](../../qgroup_core/rooms.py)、[契約](../room-settlement-contract.md) | [rooms](../../tests/test_rooms.py)、[rooms JS](../../tests/test_rooms.js) |
| 分房演算 | [upstream room functions](../../music_site/upstream.py)、[活動來源對照](../../music_site/service.py) | [music](../../tests/test_music_site.py)；演算法的逐例差分待新建 |
| 分房前端 | [app](../../music_site/public/app.js)、[index](../../music_site/public/index.html) | [React UI](../../tests/test_react_ui.mjs)、[music](../../tests/test_music_site.py) |
| 結算 | [settlements](../../qgroup_core/settlements.py)、[billing](../../qgroup_core/billing.py)、[契約](../settlement-contract.md) | [settlements](../../tests/test_settlements.py)、[payload](../../tests/test_settlement_payload.js) |
| 媒體 | [media](../../qgroup_core/media.py)、[payment codes](../../qgroup_core/payment_codes.py) | [codes](../../tests/test_payment_codes.py)、[picker](../../tests/test_payment_picker.js) |
| 財務 | [finance](../../qgroup_core/finance.py)、[契約](../finance-contract.md) | [finance](../../tests/test_finance.py)、[rooms](../../tests/test_rooms.py) |
| 音樂 | [upstream](../../music_site/upstream.py)、[service wrapper](../../music_site/service.py) | [music](../../tests/test_music_site.py) |
| 音樂前端 | [app](../../music_site/public/app.js)、[initials](../../music_site/public/initials.js)、[pinyin](../../music_site/public/pinyin.js) | [React UI](../../tests/test_react_ui.mjs)；完整音樂操作矩陣待擴充 |
| 成分選取 | [SelectionPanel TSX](../../ui/music/SelectionPanel.tsx)、[selection store](../../ui/music/selection-store.ts) | [selection](../../tests/test_music_selection.mjs) |
| 匹配 | [match_stats／compute_matches／note_allowed](../../music_site/upstream.py) | [music](../../tests/test_music_site.py)；公式／可見性 golden corpus 待補 |
| 趨勢 | [compute_trend／compute_clusters／trend_loop](../../music_site/upstream.py)、[圖表](../../music_site/public/app.js) | [music](../../tests/test_music_site.py)；完整取樣／聚類差分待補 |
| 喊話 | [shout functions](../../music_site/upstream.py)、[UI](../../music_site/public/app.js) | [music](../../tests/test_music_site.py) |
| 管理 | [admin](../../qgroup_core/admin.py)、[Admin TSX](../../ui/board/AdminApp.tsx) | [admin users／metadata](../../tests/test_admin_users.py)、[admin events](../../tests/test_admin_events.py) |
| 成分管理 | [administration](../../music_site/administration.py)、[admin_links](../../music_site/admin_links.py)、[admin UI](../../music_site/public/admin.js)、[music_admin](../../qgroup_core/music_admin.py) | [music](../../tests/test_music_site.py) |
| 成分維運 | [maintenance](../../music_site/maintenance.py)、[administration](../../music_site/administration.py)、[準備匯入](../../deploy/prepare_music_snapshot.py) | [maintenance](../../tests/test_music_maintenance.py)、[music](../../tests/test_music_site.py) |
| 成分卡 | [member_profiles](../../music_site/member_profiles.py)、[music_profiles](../../qgroup_core/music_profiles.py)、[MemberMusic TSX](../../ui/board/MemberMusic.tsx) | [music](../../tests/test_music_site.py)、[React UI](../../tests/test_react_ui.mjs) |
| 成分橋接 | [music_proxy](../../qgroup_core/music_proxy.py)、[music_admin](../../qgroup_core/music_admin.py)、[service](../../music_site/service.py) | [music](../../tests/test_music_site.py) |
| bot 指令 | [replies](../../qgroup_bot/replies.py) | [commands](../../tests/test_bot_commands.py)、[bot links](../../tests/test_bot_links.js) |
| bot 視圖 | [bot_views](../../qgroup_core/bot_views.py)、[replies](../../qgroup_bot/replies.py) | [roster](../../tests/test_bot_roster.py)、[countdown](../../tests/test_bot_countdown.py) |
| 機器人 | [bot_outbox](../../qgroup_core/bot_outbox.py)、[worker](../../qgroup_bot/worker.py) | [outbox](../../tests/test_bot_outbox.py)、[signup](../../tests/test_bot_signup_notifications.py)、[withdrawal](../../tests/test_bot_withdrawal_notifications.py) |
| bot 設定 | [bot_settings](../../qgroup_core/bot_settings.py)、[bot_groups](../../qgroup_core/bot_groups.py)、[BotSettings TSX](../../ui/board/BotSettings.tsx) | [settings](../../tests/test_bot_settings.py)、[groups](../../tests/test_bot_groups.py) |
| bot Markdown | [markdown](../../qgroup_bot/markdown.py)、[bot_markdown](../../qgroup_core/bot_markdown.py)、[main](../../qgroup_bot/main.py) | [markdown](../../tests/test_bot_markdown.py)、[broadcast](../../tests/test_bot_markdown_broadcast.py) |
| 縮寫 | [abbreviations](../../qgroup_bot/abbreviations.py)、[input](../../qgroup_bot/abbreviation_input.py)、[text](../../qgroup_bot/abbreviation_text.py)、[delivery](../../qgroup_bot/abbreviation_delivery.py)、[sensitive](../../qgroup_bot/sensitive_words.py) | [abbreviations](../../tests/test_bot_abbreviations.py)、[quoted](../../tests/test_bot_quoted_abbreviations.py)、[delivery](../../tests/test_bot_abbreviation_delivery.py)、[sensitive](../../tests/test_bot_sensitive_words.py) |
| bot 維運 | [main](../../qgroup_bot/main.py)、[api](../../qgroup_bot/api.py)、[observability](../../qgroup_bot/observability.py)、[logging](../bot-logging.md) | [protocol](../../tests/test_bot_protocol.py)、[logging](../../tests/test_bot_logging.py) |
| 公開 API | [public_api](../../public_api.py)、[契約](../public-api.md) | [public API](../../tests/test_public_api.py) |
| 恢復 | [client](../../public/client.js)、[storage](../../public/storage.js)、[recovery](../../ui/board/recovery.ts)、[契約](../experience-contract.md) | [experience](../../tests/test_experience.py)、[client](../../tests/test_client.js)、[todos](../../tests/test_todos.js) |
| 前端 | [BoardApp](../../ui/board/BoardApp.tsx)、[Identity](../../ui/board/Identity.tsx)、[使用手冊](../user-guide.md) | [board React](../../tests/test_board_react.mjs)、[React UI](../../tests/test_react_ui.mjs)、[React controllers](../../tests/test_react_controllers.mjs) |
| 語言 | [i18n](../../qgroup_core/i18n.py)、[build locales](../../deploy/build_locales.cjs)、[localize TSX](../../deploy/localize_react.mjs) | [Python](../../tests/test_i18n.py)、[JS](../../tests/test_i18n.js) |
| 統計 | [analytics](../../public/analytics.js)、[README](../../README.md) | [analytics](../../tests/test_analytics.js) |
| HTTP | [server](../../server.py)、[music service](../../music_site/service.py) | [API](../../tests/test_api.py)、[music](../../tests/test_music_site.py) |
| 成分建置 | [build UI](../../deploy/build_ui.mjs)、[SW](../../music_site/public/sw.js)、[manifest](../../music_site/public/manifest.json) | [React UI](../../tests/test_react_ui.mjs)、[patterns](../../tests/test_yahha_patterns.mjs) |
| 儲存 | [storage](../../qgroup_core/storage.py)、[backup](../../deploy/backup.py)、[verify migration](../../deploy/verify_migration.py) | 各領域 migration cases、[release source](../../tests/test_release_source.py) |
| 發布 | [政策](../deployment-policy.md)、[Compose](../../compose.yaml)、[music Compose](../../deploy/music-compose.yaml)、[來源檢查](../../deploy/check_release_source.py) | [release source](../../tests/test_release_source.py)；混合版本與正式副本演練須另取證據 |

## 明確不當成已可用功能的舊碼

- 成分 upstream 的舊管理密碼／token 登入與修改密碼被 `service.py` 包裝層停用；新系統保留管理功能，改用統一管理身份，不能重新啟用預設密碼。
- 成分 upstream 的 QQ＋任意新 PIN 註冊被包裝層替換；現在只可找回既有成分，新會員由站內／QQ 身份建立。
- `/api/clusters` 仍有後端；`renderClusters` 因目前 HTML 沒有 `clustersCard` 而無可用入口。保留後端並在新版提供圈子頁，不宣稱舊畫面已可達。
- 舊看板 DOM 控制器仍在倉庫供比對，現行 Board／Admin bundle 不載入；不能盤點成第二套獨立功能。
- WeChat adapter、群內直接寫報名、bot 個人身份綁定／私聊、收款碼富媒體及自動支付未完成；不把資料表預留或文字入口當已實作能力。
- `deploy/reset_test_data.py` 等受控測試清理工具屬維運，不提供普通用戶入口；正式遷移不可拿它重置資料。
