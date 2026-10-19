/**
 * 活动注册表（前端视图层）
 *
 * 之前 Activity.vue 里用一长串三元表达式把活动 ID 硬编码到适配面板，
 * 并用「开始时间」冒充「更新日期」排序。AGENTS.md 要求：
 * - 每个活动登记更新日期，列表按更新日期倒序；
 * - 新增活动时必须配置显式的开始/结束时间并据此控制入口状态。
 *
 * 这里把「活动 ID → 适配面板 / 卡片元数据」集中成一张表，
 * Activity.vue 只负责把服务端返回的活动组套进这张表。
 */
import {
  CHARITY_FLOWER_ACTIVITY_WINDOW,
  MILK_TEA_ACTIVITY_WINDOW,
  PET_DIARY_ACTIVITY_WINDOW,
  RAIN_POEM_ACTIVITY_WINDOW,
  SHARE_REWARD_ACTIVITY_WINDOW,
  WISH_SIGN_ACTIVITY_WINDOW,
} from '@/constants/activity-windows'

export type AdaptedActivityKey
  = | 'milk-tea'
    | 'pet-diary'
    | 'charity-flower'
    | 'rain-poem'
    | 'wish-sign'
    | 'share-reward'

/** 与 activity-windows.ts 的窗口字面量同构（updatedMs 为登记更新日期） */
export interface ActivityWindowMs {
  startMs: number
  endMs: number
  updatedMs: number
}

export interface ActivityRegistration {
  /** 适配面板标识，与 Activity.vue 的分支 key 一致 */
  key: AdaptedActivityKey
  /** 活动组 ID；第一个为主要活动 ID，其余为可用于识别的子活动 ID */
  ids: readonly [number, ...number[]]
  /** 卡片标题（服务端未下发标题时使用） */
  title: string
  description: string
  icon: string
  image: string
  imagePosition?: string
  /** 已登记的活动时间窗；用于目录接口未返回时的兜底 */
  window: ActivityWindowMs
  /** 目录接口没有该活动时是否仍强制展示（当前只有进行中的奶茶活动需要） */
  alwaysListed?: boolean
}

/**
 * 活动注册表。新增活动时在这里登记一行，并在 Activity.vue 提供对应面板分支。
 *
 * 列表排序使用活动窗口里登记的 `window.updatedMs`（更新日期），
 * 这里不再维护第二份日期，避免两处写法不一致。
 */
export const ACTIVITY_REGISTRATIONS: ActivityRegistration[] = [
  {
    key: 'milk-tea',
    ids: [2026110100],
    title: '奶茶热销中',
    description: '经营奶茶小店、兑换商店与兼职工作',
    icon: 'i-carbon-cafe',
    image: '/activity/milk-tea/img_s4Main_bg.png',
    window: MILK_TEA_ACTIVITY_WINDOW,
    alwaysListed: true,
  },
  {
    key: 'pet-diary',
    ids: [2026090100],
    title: '萌宠日记',
    description: '查看比熊成长、爪印手记、拾物小铺与比熊赠礼',
    icon: 'i-fa-solid-paw',
    image: '/activity/pet-diary/scene-home-adult.webp?v=20260912',
    imagePosition: 'center 64%',
    window: PET_DIARY_ACTIVITY_WINDOW,
  },
  {
    key: 'wish-sign',
    ids: [2026092400],
    title: '秋祈良愿',
    description: '查看祈愿状态、祈愿池和每日奖励',
    icon: 'i-carbon-sun',
    image: '/activity/wish-sign/card-bg.svg',
    window: WISH_SIGN_ACTIVITY_WINDOW,
  },
  {
    key: 'share-reward',
    ids: [2026092500],
    title: '快乐不独享',
    description: '查看每日快乐值与档位进度',
    icon: 'i-carbon-share',
    image: '/activity/share-reward/card-bg.svg',
    window: SHARE_REWARD_ACTIVITY_WINDOW,
  },
  {
    key: 'charity-flower',
    ids: [2026090900, 2026090901],
    title: '公益小红花',
    description: '查看爱心、公益进度与奖励状态',
    icon: 'i-carbon-favorite',
    image: '',
    window: CHARITY_FLOWER_ACTIVITY_WINDOW,
  },
  {
    key: 'rain-poem',
    ids: [2026070300],
    title: '雨落成诗',
    description: '查看天气、每日进度与气象研究',
    icon: 'i-carbon-rain-heavy',
    image: '/activity/rain-poem/day-rain-bg.jpg',
    window: RAIN_POEM_ACTIVITY_WINDOW,
  },
]

/** 目录接口为空时的兜底活动（保持历史行为：雨落成诗卡片仍可见） */
export const FALLBACK_ACTIVITY_REGISTRATION = ACTIVITY_REGISTRATIONS.find(item => item.key === 'rain-poem') as ActivityRegistration

/** 按活动组 ID 查找适配注册项；未适配返回 null */
export function resolveActivityRegistration(activityIds: readonly number[]): ActivityRegistration | null {
  const ids = new Set(activityIds.map(Number))
  return ACTIVITY_REGISTRATIONS.find(item => item.ids.some(id => ids.has(id))) || null
}
