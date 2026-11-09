# P3：逐人费用与结算版本

版本 20261108-5，数据库迁移 3，HTTP 写协议保持 2。P0–P2 名单、生命周期、邀请权限及审计规则继续适用。

## 账单与旧版

新增逐人账单，旧人均账单及每版收款码保持原值。网页只提供「核对并转逐人结算」：发起者逐人核对并明确转换，新建下一版，不根据旧除数猜测逐人责任。兼容期内旧网页仍可为尚未转换的账单追加人均版本；已有逐人版本后，所有旧结算写接口一律拒绝，不能覆盖新版。

只有当前发起者可读取结算编辑名册、预览和发布；协办无财务权。实际结束或取消后可发布，归档后仍可更正。所有历史与消费凭证遵循活动的公开／邀请可见性。财务审核记录、费用分配和图片属于该活动的可见内容。

`settlement_history` 沿用统一递增版本；新增 `settlement_details` 保存整份 JSON 快照，`settlement_receipts` 保存各版消费凭证。两表禁止 UPDATE／DELETE，外键关联同版历史。迁移 3 只建表及登记版本，不修改旧表数据、不重算旧账。修改后发布新版本，完全相同的保存不增加版本。

## 核对人员与付款归属

结算名单以稳定 attendee ID 关联，每位正式人员均须列入。免共同费用设 0 份并填写原因，不移除名额；候补／待确认／已退出默认不列入，可明确选择并写依据。缺席、退出申请、未接受新安排、改变付款归属、非一份 AA 均须核对原因。迟到或早退不自动减免。

每版冻结称呼、可区分同名者的标签、名额状态、出席、最后接受的安排版本及完整约定、AA 份数、逐项应付、原因和付款人分配。后续改名、核对出席或转交管理不会改写旧快照。新版本重新核对现况。

付款人独立于参加者：本人账号、代报管理人、未绑定账号的参加者，或额外命名的付款人。对外使用活动范围内的 opaque ID，不公开内部账号标识；不按称呼合并。一个付款人可承担多人，一位参加者可按比例或固定金额由多人合付。这里只分配应付责任，不意味着已付、已收或已退款，实收款在 P4 单独记账。

## 费用与精确计算

最多 50 项、500 位结算人员。金额为非负十进制字符串，最多七位整数及两位小数，内部整数分；退款／减免通过类型扣减，不接受负数字符串。总净额及逐人净应付均不能负数，预收款退回不冲减消费。零元可发布，无人可发布零元；存在正数且没有有效分摊者时拒绝。

| 方式 | 规则 |
| --- | --- |
| shares | 按每人共同 AA 份数；1 正常、0.5 半 A、0 免共同费用 |
| equal | 选中对象各一份，包含共同费用免 A 者；用于单独的实际消费 |
| weights | 每项为各人指定比例，0–1000，最多三位小数 |
| fixed | 各人固定金额之和必须精确等于该项目金额 |
| duration | 各人输入 0–1440 整分钟，按分钟比例；不根据迟到／早退自动推导 |

范围可为本版所有人或指定人员。指定范围、非默认方式、退款及减免需项目依据。免共同 AA 者仍可负担自己的单独消费。退款／减免项目表示店家退差价等成本减少，实际资金退款留待 P4。

分配用 Fraction 有理数：先按比例取整分，剩余分按最大余数依次补足；余数相同按本版冻结的原报名顺序。负项先对绝对值执行同一规则再取负，每项独立对平。请求列表重排不改变参加者补分顺序。多人合付的比例分配也用同一算法，同余按本版付款人输入顺序；固定合付必须等于该人净应付。逐人、逐付款人总和均等于净费用。

## 图片与历史

每版最多三张消费凭证，另有最多三类选填收款码（微信／支付宝／其他，各一张）；单图 2 MiB、最长边不超过 1600px，合计最多 6 MiB。浏览器接受 PNG／JPG／WebP，转换为去元数据的静态 PNG。后端沿用 PNG 结构、CRC、尺寸及长度校验。新图片按 SHA-256 存在数据库旁的私有 images 目录，SQLite 只存元数据和不可变版本引用；同内容跨账号、活动及图片用途只保存一份。文件先持久化再提交数据库引用；失败事务可能留下不可访问的文件，备份只包含已提交的资源。旧 BLOB 和历史记录原样兼容。编辑时可引用本活动旧版本的凭证，其他活动不可引用；移除或换图不影响历史。

每版同时冻结完整计算输入、逐项分配、逐人应付、付款人合计、备注、修改原因、收款码摘要和凭证摘要。历史提供修改分组及可读的前后差异，可查看全部原版内容。首次发布或变更后向相关报名管理人追加站内提醒，不声称已通知 QQ 群。

## API

所有新写接口要求协议 2、去重请求头、`base_revision` 及 `base_version`。先预览，再使用该次 `preview_token` 发布；服务端重算并比对费用、名单、图片及当前版本。表单任何输入变动使预览失效。并发或转交使版本过期时返回 409，保留输入，不自动替发起者重新接受新版本。

| 方法与路径 | 内容 |
| --- | --- |
| GET /api/events/:id/settlement/roster | 发起者专用的核对人员、原约定及付款人选项 |
| POST /api/events/:id/settlement/preview | people、items、custom_payers、note、reason、reviewed_roster、convert_legacy；可选 payment_codes，旧客户端 qr_image 兼容为 other |
| PUT /api/events/:id/settlement/detailed | 同一输入，加 preview_token；业务、图片、历史、审计、提醒及请求结果原子提交 |
| GET /api/events/:id/settlement/history | 混合返回 legacy／detailed 历史，逐人版含 detail |
| GET /api/events/:id/settlement/history/:version/receipts/:item_id | 该活动该版消费凭证 PNG |

人员：`{id,share,reason,payment_mode,payments:[{payer_id,share 或 amount}]}`。付款模式 shares／fixed。额外付款人：`{id:"custom:<16 hex>",name}`。

项目：`{id:<16 hex>,name,amount,kind,scope,mode,reason,allocations,receipt}`。kind 为 expense／refund／discount，scope 为 common／selected；allocations 为 `{person_id,weight 或 minutes 或 amount}`，简单 shares／equal 指定范围只需 person_id。receipt 为 Base64 PNG、null，或 `{version,item_id}` 的本活动历史引用。

`GET /api/events` 及详情中的 settlement.mode 为 legacy 或 detailed；逐人版没有可解释的统一人均数，per_person_amount 为 null，展示 detail 的逐人及付款人合计。my_payable_cents 仅按当前浏览器绑定账号的付款人标识汇总，不按昵称识别身份。

P4 已接續上線，實際收付款、預收、墊付、訂金與結清規則見 [收付款契約](finance-contract.md)。改帳保留原款項並重新對帳；已確認的非報名付款人可沿用同一 ID 分配最終責任。

## 私人收款码库与版本绑定

`GET /api/payment-codes` 仅列出当前账号；`POST` 保存 `{kind:wechat|alipay|other,name?,image:<Base64 PNG>}`；也可用 `source:{event_id,version,kind}` 显式保存自己活动的旧版图片。相同账号／类别／名称／内容去重。每账号最多 30 张有效码；`DELETE /api/payment-codes/:id` 软移除，已发布版本不受影响。`GET /api/payment-codes/:id/image` 仅码主可读，切换／连接账号沿用现有身份规则。写操作要求协议 2 和 Idempotency-Key，不要求活动 revision，接续现有未知结果查回机制。

结算 `payment_codes` 为最多三项 `{kind,code_id}` 或 `{kind,version}`，后者仅可引用本活动已有版本中同类别的图片。未传字段保留原码，空数组明确清除；不能同时传 `qr_image`。类型、名称、摘要全部冻结在账单快照；选择、改名、换类别及移除均参与预览 token、无变更判断和结算历史。历史接口输出 `payment_codes:[{kind,name,url}]`，URL 绑定活动、版本及类别；统一执行活动访问权限，不暴露私人码库。无全局摘要读图接口。

新凭证引用存在 settlement_receipt_images，新收款码引用存在 settlement_code_images，两者均不可更新／删除。新账单的旧 qr_image BLOB 列为空；旧 BLOB 仍从原路由读取。库表 user_payment_codes 与资源表 image_assets 由迁移 6 新增，不改旧表、原图或历史。

每日备份由同一 SQLite 快照和其引用的不可变文件组成：`.sqlite3` 配对 `.images.tar.gz`，数据库最后出现表示配对完整。还原必须恢复两者，图片放回数据库旁 images/；旧版无外部图片的 SQLite 备份可单独恢复。verify_migration.py 可从源 images/ 或配对备份包复制和校验文件，重复迁移及恢复均检查原有数据。
