# 群聚看板 API 接入說明

基礎網址：`https://kanban.danndann.cn/api/public/v1`

所有接口均為 **GET**，返回 JSON。請由後端帶以下請求標頭呼叫，金鑰另行提供：

```http
Authorization: Bearer <API_KEY>
```

金鑰保存在後端，不放在網頁前端或網址參數中；接口不提供跨站 CORS。

## 查詢接口

以下路徑接在基礎網址之後，`{event_id}` 使用活動列表返回的 `id`。

| 路徑 | 返回內容 |
| --- | --- |
| `/events` | 活動列表，支援分頁 |
| `/events/{event_id}` | 單場活動資料、報名名單與包間分配 |
| `/events/{event_id}/participants` | 單場報名名單 |
| `/events/{event_id}/rooms` | 單場包間分配 |

只提供已發布的公開活動，包含已結束、取消或歸檔的活動。不提供私人活動、QQ 號、報名備註或收付款資料。

## 活動列表

`GET /events?limit=20&offset=0`

| 可選參數 | 說明 |
| --- | --- |
| `limit` | 每頁筆數，預設 20，最多 100 |
| `offset` | 起始位置，預設 0 |
| `lifecycle` | 篩選活動狀態：`scheduled`、`ongoing`、`ended`、`cancelled` |
| `status` | 篩選報名狀態：`open`、`closed`、`cancelled` |

回應包含 `events`、`total`、`limit`、`offset`、`next_offset`。依開始時間、活動 ID 升冪排列；使用 `next_offset` 取得下一頁，為 `null` 時結束。

活動常用欄位：

| 欄位 | 說明 |
| --- | --- |
| `id`、`title`、`category`、`location` | 活動 ID、標題、類型、地點 |
| `starts_at`、`ends_at`、`timezone` | 開始／預計結束時間、時區；時間為 ISO 8601，未知結束時間為 `null` |
| `deadline`、`registration_open` | 報名截止、目前是否開放報名；開放不保證取得正式名額 |
| `counts` | `confirmed` 正式、`waiting` 候補、`tentative` 待確認人數 |
| `capacity`、`remaining_capacity` | 名額上限、剩餘名額；不限名額時分別為 `0`、`null` |
| `lifecycle`、`archived_at` | 活動狀態、歸檔時間（未歸檔為 `null`） |
| `url` | 活動相對網址，接在 `https://kanban.danndann.cn` 後使用 |

單場詳情的活動欄位位於 `event`，另含 `description`（活動說明）、`fee_policy`（費用規則）。

## 報名名單與包間分配

建議使用 `/events/{event_id}`，一次取得活動、名單與包間，避免分開請求時資料已變更。下例為虛構資料，僅節錄活動欄位：

```json
{
  "api_version": 1,
  "event_id": "0123456789abcdef",
  "revision": 7,
  "event": {"id": "0123456789abcdef", "title": "週末聚會"},
  "participants": [
    {"attendee_id": "1111111111111111", "user_id": "example-user-id", "name": "小明", "status": "confirmed", "confirmation_state": "accepted"}
  ],
  "room_assignments": {
    "planned": {
      "version": 1,
      "rooms": [
        {"id": "aaaaaaaaaaaaaaaa", "name": "牡丹廳", "attendee_ids": ["1111111111111111"], "members": [{"attendee_id": "1111111111111111", "user_id": "example-user-id", "name": "小明"}]}
      ],
      "unassigned_attendee_ids": []
    },
    "actual": null
  }
}
```

- **帳號對照用 `user_id`**：同一帳號跨活動沿用，可人工維護 `QQ 號 ↔ user_id`。
- **串接報名與包間用 `attendee_id`**：每筆報名獨立；同一人參加不同活動會有不同 ID。包間的 `attendee_ids` 對應這個欄位，`members` 提供人名及帳號 ID。
- `user_id=null` 表示沒有可用的帳號對照，例如未認領同行或已註銷帳號；不能用代報人的帳號代替。
- 名單 `status` 為 `confirmed`／`waiting`／`tentative`；不包含已退出或尚未接受邀請者。`confirmation_state` 為安排確認狀態：`accepted`／`pending`／`declined`。
- `planned` 是預分包間，`unassigned_attendee_ids` 為未分配者；候補也可被預分，分房不代表正式名額。
- `actual` 非 `null` 時，優先使用它顯示實際安排；其結構同 `planned`，版本欄位改為 `settlement_version`，人名來自確認時的快照。即使 `actual.rooms=[]`，也不要回退顯示預分。`actual=null` 時可顯示 `planned` 並標示「預分」。

單獨查名單時，回應的 `participants` 與上例相同；單獨查包間時，`planned`、`actual` 直接位於回應頂層。兩者均另含 `api_version`、`event_id`、`revision`。

## 呼叫範例與同步

`QGROUP_API_KEY` 由呼叫方後端的私密環境變數提供：

```sh
curl -H "Authorization: Bearer ${QGROUP_API_KEY}" \
  'https://kanban.danndann.cn/api/public/v1/events?limit=20'
```

建議每 60 秒或手動刷新時更新，定期完整讀取所有分頁並依 ID 去重。改名等異動未必增加 `revision`，不要只靠它跳過更新。

| HTTP 狀態 | 處理方式 |
| --- | --- |
| `200` | 成功 |
| `400` | 參數錯誤，檢查參數名稱、值及是否重複 |
| `401` | 缺少或無效金鑰，檢查 Authorization |
| `404` | 活動不存在或已不公開，移除本地展示資料 |
| `405` | 不支援寫入，請使用 GET |
| `503` | 暫時不可用，稍後重試 |

錯誤回應格式為 `{"error":"錯誤說明"}`。完整同步成功後，移除列表已不再出現的活動；鑑權失敗、服務異常或網路失敗不可當作活動刪除。
