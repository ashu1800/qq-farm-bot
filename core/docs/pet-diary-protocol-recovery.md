# 萌宠成长日记（S3 比熊萌宠主题赛季）协议取证

> 活动组 `2026090100`，UID `SEASON_BEAR_CAMPAIGN`。
>
> 本文档由仓库内已实现的服务、proto、素材清单与接力记录（`progress.md`）整理而成，
> 用于说明各字段当前的证据等级。原始抓包文件不在仓库内。
>
> 证据等级：
> - **在线明文（高）**：子活动 ID、活动体字段号、命令字、请求/响应选择器
>   （来自 2026-09-10 在线账号 `ActivityService.List` / `GetGroup` / `Operate` 明文响应，
>   命令字同时与官方小程序 1.14.0.1 生成编码器一致）。
> - **推断（中）**：活动体内的子字段语义（结合官方活动规则与多帧差分命名）。
> - **未确认**：抓包中为空子消息、或仅在客户端 Prefab 中出现过的字段。

## 活动登记

| 项 | 值 |
| --- | --- |
| 组活动 ID | `2026090100` |
| 客户端 UID | `SEASON_BEAR_CAMPAIGN` |
| 主体玩法 | `2026090101`（`ActivityNode` 字段 115 `ActivityBodyPetDiary`） |
| 比熊赠礼 | `2026090102`（`star_record`） |
| 拾物小铺 | `2026090103`（通用 `exchange_shop`） |
| 活动窗口 | `1789005600`（2026-09-10 10:00 CST）— `1791820799`（2026-10-12 23:59:59 CST） |

活动窗口在 `core/src/models/store.js` 的 `TIMED_ACTIVITY_AUTOMATION_GROUPS` 与
`web/src/constants/activity-windows.ts` 的 `PET_DIARY_ACTIVITY_WINDOW` 各登记一份，
并由 `core/test/pet-diary-automation.test.js` 与 `core/test/activity-window-sync.test.js`
校验一致性。

## 活动体字段（ActivityNode 字段 115）

`core/src/proto/activitypb.proto` 中的 `ActivityBodyPetDiary`：

| 字段 | 消息 | 语义 | 证据 |
| --- | --- | --- | --- |
| 1 | `PetDiaryPet` | 比熊成长状态（阶段、投喂进度） | 在线明文，子字段推断 |
| 2 | `PetDiaryHome` | 比熊之家解锁状态 | 在线明文 |
| 3 | `PetDiaryEscort` | 寻宝 / 宝藏护送状态 | 在线明文 |
| 4 | `PetDiaryPhotoWall` | 爪印手记照片墙 | 在线明文 |
| 6 | `PetDiaryPouch` | 锦囊槽位 | 在线明文 |
| 7 / 8 / 9 | — | 抓包中为空子消息，含义未确认，未解析 | 未确认 |

## 操作命令

命令字与响应选择器来自官方生成编码器（`activitypb.ts`），不得按响应长度或 UI 文案推断。

| 动作 | cmd | 响应选择器 |
| --- | --- | --- |
| 领养 / 完成开场 CG | 27 | `pet_treasure_hunt_finish_cg` |
| 投喂 | 29 | `pet_treasure_hunt_feed` |
| 抽取 | 30 | `pet_treasure_hunt_draw` |
| 领取手记 | 32 | `pet_treasure_hunt_claim_story` |
| 刷新锦囊 | 41 | `pet_treasure_hunt_refresh_charm_pool` |
| 装备锦囊 | 42 | `pet_treasure_hunt_equip_charms` |
| 好友夺宝 | 43 | `pet_treasure_hunt_start_battle` |
| 开启宝藏 | 45 | `pet_treasure_hunt_open_treasure` |
| 领取夺宝补偿 | 46 | `pet_treasure_hunt_claim_plunder_compensation` |
| 领取比熊 | 48 | `pet_treasure_hunt_claim_dog` |
| 标记故事已读 | 49 | `pet_treasure_hunt_mark_story_animated` |
| 跳过战斗动画 | 50 | `pet_treasure_hunt_set_skip_battle_cg` |
| 领取活动种子 | 21 | `mega_event_claim_all` |
| 拾物小铺购买 | 1 | `shop_buy` |

实现位于 `core/src/services/activity-pet-diary.js`（`OPERATIONS`）。

## 本地素材映射

`core/src/activity-data/pet-diary-assets.json` 记录每个素材的：

- `path`：协议下发的 Cocos 资源路径（去掉 `/spriteFrame` 后作为映射键）；
- `file`：`web/public/activity/pet-diary/` 下的本地文件名（文件名即契约，不得重命名）；
- `url` / `frameSource`：CDN 来源；
- `sha256`：入库校验值。

`core/test/pet-diary.test.js` 与 `core/test/pet-diary-item-images.test.js` 校验文件存在且摘要匹配。

## 自动化开关

`core/src/models/store.js` 的 `PET_DIARY_AUTOMATION_KEYS` 登记了全部开关，并整体纳入
`TIMED_ACTIVITY_AUTOMATION_GROUPS` 的时间窗管理：活动结束后配置边界会强制关闭并持久化。

刻意不提供的开关：

- 拾物小铺兑换（需要用户指定商品）；
- 锦囊付费刷新（消耗点券，仅自动使用免费额度）；
- `markStories`（纯 UI 状态，无奖励）；
- `skipBattle`（一次性设置项，不是周期任务）。

## 未完成与后续取证

1. **字段 115.7 / 115.8 / 115.9**：抓包中为空子消息。恢复路径与
   `$qq-farm-activity-protocol-recovery` 一致：定位最新 `miniapp_src` 中的
   `chunks:///_virtual/activitypb.ts`，用官方编码器逐个字段做 sentinel 探测。
2. **子字段语义**：`PetDiaryPet.stage/progress` 等命名基于多帧差分推断，
   需要再用一次完整赛季操作样本核对。
3. **素材重命名风险**：本地文件名与协议路径的映射是运行时契约，任何重命名都会导致空图。
