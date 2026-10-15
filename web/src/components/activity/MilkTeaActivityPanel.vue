<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, ref } from 'vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import { useAccountStore } from '@/stores/account'
import { useActivityStore } from '@/stores/activity'
import { useToastStore } from '@/stores/toast'

interface MilkTeaShopItem {
  slotId?: number
  itemId?: number
  itemCount?: number
  costItemId?: number
  costItemCount?: number
  status?: number
  name?: string
}

interface MilkTeaMilestone {
  tierId?: number
  threshold?: number
  state?: number
  rewards?: Array<{ itemId?: number, itemName?: string, itemCount?: number }>
}

const props = defineProps<{ activity: any | null, loading: boolean }>()
const emit = defineEmits<{ refresh: [] }>()

const accountStore = useAccountStore()
const activityStore = useActivityStore()
const toast = useToastStore()
const { currentAccountId } = storeToRefs(accountStore)

const operating = ref('')

const title = computed(() => props.activity?.title || '奶茶热销中')
const shopItems = computed<MilkTeaShopItem[]>(() => props.activity?.shop?.items || [])
const milestones = computed<MilkTeaMilestone[]>(() =>
  [...(props.activity?.shareRewards?.milestones || [])].sort((a, b) => (a.threshold || 0) - (b.threshold || 0)))
const unclaimed = computed(() => props.activity?.shareRewards?.unclaimed || { daily: false, firstShare: false })
const rulesText = computed<string[]>(() => {
  const tips = props.activity?.infoNodes?.find((node: any) => node?.payload?.tips)?.payload?.tips
  return Array.isArray(tips?.txt) ? tips.txt.filter((entry: unknown) => typeof entry === 'string') : []
})
const hasCustomShopBody = computed(() =>
  (props.activity?.infoNodes || []).some((node: any) => (node?.unknownFieldNames || []).length > 0))

const seedItems = computed(() => shopItems.value.filter(item => (item.name || '').endsWith('种子')))
const decorItems = computed(() => shopItems.value.filter(item => !seedItems.value.includes(item)
  && /(套装|围栏|仓库|木牌|栅栏|狗屋|街道|头像框)/.test(item.name || '')))
const propItems = computed(() => shopItems.value.filter(item => !seedItems.value.includes(item) && !decorItems.value.includes(item)))

const currencyNames: Record<number, string> = { 1001: '金币', 1041: '奶茶券' }

function costText(item: MilkTeaShopItem) {
  const name = currencyNames[Number(item.costItemId)] || `货币#${item.costItemId}`
  return `${item.costItemCount} ${name}`
}

function time(value?: number) {
  return value ? new Date(value * 1000).toLocaleString('zh-CN', { hour12: false }) : '—'
}

function rewardText(reward: { itemName?: string, itemId?: number, itemCount?: number }) {
  const name = reward.itemName || (reward.itemId ? `物品#${reward.itemId}` : '奖励')
  return `${name} ×${reward.itemCount ?? 1}`
}

function milestoneState(state?: number) {
  if (state === 3)
    return { label: '已领取', className: 'text-emerald-700 dark:text-emerald-300' }
  if (state === 2)
    return { label: '可领取', className: 'text-amber-700 dark:text-amber-300' }
  return { label: '未达成', className: 'text-gray-500 dark:text-gray-400' }
}

async function operate(action: string, params: { slotId?: number, count?: number }, label: string) {
  if (!currentAccountId.value || operating.value)
    return
  operating.value = `${action}:${params.slotId || 0}`
  try {
    const result = await activityStore.operateMilkTea(String(currentAccountId.value), action, params)
    if (result?.ok)
      toast.success(`${label}成功`)
    else
      toast.error(result?.error || `${label}失败`)
  }
  catch (error: any) {
    toast.error(error?.response?.data?.error || error?.message || `${label}失败`)
  }
  finally {
    operating.value = ''
    if (currentAccountId.value)
      await activityStore.fetchMilkTeaActivity(String(currentAccountId.value))
  }
}
</script>

<template>
  <section class="space-y-5">
    <header class="relative overflow-hidden rounded-2xl bg-gradient-to-br from-[#5a3a28] via-[#8a5a36] to-[#c98d52] p-5 text-white shadow-lg sm:p-7">
      <div class="pointer-events-none absolute -right-10 -top-16 h-48 w-48 rounded-full border-[24px] border-white/10" />
      <div class="pointer-events-none absolute -bottom-20 right-24 h-40 w-40 rounded-full bg-white/10 blur-2xl" />
      <div class="relative flex items-start justify-between gap-4">
        <div class="min-w-0">
          <div class="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-white/70">
            <span class="h-2 w-2 rounded-full bg-white shadow-[0_0_12px_rgba(255,255,255,.9)]" />
            奶茶季
          </div>
          <div class="mt-3 flex items-center gap-3">
            <span class="i-carbon-cafe flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-white/15 text-2xl backdrop-blur-sm" />
            <div>
              <h1 class="text-2xl font-semibold tracking-tight sm:text-3xl">{{ title }}</h1>
              <p class="mt-1 text-sm text-white/80">开店营业收奶茶券，兑换种子与限定奖励</p>
            </div>
          </div>
          <div class="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-white/75">
            <span>{{ time(activity?.startTime) }} — {{ time(activity?.endTime) }}</span>
            <span class="hidden h-1 w-1 rounded-full bg-white/50 sm:block" />
            <span>{{ activity?.active ? '活动进行中' : '未开始或已结束' }}</span>
          </div>
        </div>
        <BaseButton variant="secondary" size="sm" :loading="loading" :disabled="loading" aria-label="刷新活动数据" @click="emit('refresh')">刷新</BaseButton>
      </div>
    </header>

    <div v-if="loading && !activity" class="rounded-2xl border border-gray-200 bg-white p-10 text-center text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-800">正在读取活动状态…</div>
    <div v-else-if="!activity" class="rounded-2xl border border-gray-200 bg-white p-10 text-center text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-800">暂无活动数据，请稍后刷新。</div>

    <template v-else>
      <section class="rounded-2xl border border-amber-100 bg-white p-5 shadow-sm dark:border-amber-900/30 dark:bg-gray-800 sm:p-6">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <h2 class="text-base font-semibold text-gray-900 dark:text-gray-100">营业奖励</h2>
          <span class="text-xs text-gray-500 dark:text-gray-400">每日收益上限 {{ activity.shareRewards?.dailyClaimLimit ?? '—' }} 次 · 档位 {{ milestones.length }} 档</span>
        </div>
        <div class="mt-4 grid gap-3 sm:grid-cols-2">
          <div class="flex items-center justify-between gap-3 rounded-xl bg-amber-50 px-4 py-3 dark:bg-amber-950/25">
            <div class="min-w-0">
              <p class="text-xs text-gray-500 dark:text-gray-400">每日奶茶收益（{{ activity.shareRewards?.dailyReward ?? '—' }} 券/次）</p>
              <p class="mt-1 text-sm font-semibold" :class="unclaimed.daily ? 'text-amber-700 dark:text-amber-300' : 'text-gray-500 dark:text-gray-400'">
                {{ unclaimed.daily ? '有待领取奖励' : '今日已领取' }}
              </p>
            </div>
            <BaseButton
              size="sm" variant="primary" :disabled="!unclaimed.daily || !activity.active"
              :loading="operating === 'daily:0'" @click="operate('daily', {}, '领取每日奶茶收益')"
            >
              领取
            </BaseButton>
          </div>
          <div class="flex items-center justify-between gap-3 rounded-xl bg-amber-50 px-4 py-3 dark:bg-amber-950/25">
            <div class="min-w-0">
              <p class="text-xs text-gray-500 dark:text-gray-400">打工奖励</p>
              <p class="mt-1 text-sm font-semibold" :class="unclaimed.firstShare ? 'text-amber-700 dark:text-amber-300' : 'text-gray-500 dark:text-gray-400'">
                {{ unclaimed.firstShare ? '有待领取奖励' : '暂无可领奖励' }}
              </p>
            </div>
            <span class="text-xs text-gray-400 dark:text-gray-500">需在游戏内打工</span>
          </div>
        </div>
        <div v-if="milestones.length" class="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div
            v-for="tier in milestones" :key="tier.tierId"
            class="rounded-xl border p-3"
            :class="tier.state === 3 ? 'border-emerald-200 bg-emerald-50/60 dark:border-emerald-900/40 dark:bg-emerald-950/20' : tier.state === 2 ? 'border-amber-400 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30' : 'border-gray-200 bg-gray-50/60 dark:border-gray-700 dark:bg-gray-900/30'"
          >
            <div class="flex items-center justify-between gap-2">
              <span class="text-xs text-gray-500 dark:text-gray-400">营业额 {{ tier.threshold }}</span>
              <span class="text-xs font-medium" :class="milestoneState(tier.state).className">{{ milestoneState(tier.state).label }}</span>
            </div>
            <div class="mt-2 space-y-1">
              <div v-for="reward in tier.rewards" :key="reward.itemId" class="truncate text-xs font-medium text-gray-800 dark:text-gray-200" :title="rewardText(reward)">
                {{ rewardText(reward) }}
              </div>
            </div>
          </div>
        </div>
        <div class="mt-4">
          <BaseButton
            size="sm" variant="secondary" :disabled="!activity.active || !milestones.some(tier => tier.state === 2)"
            :loading="operating === 'milestones:0'" @click="operate('milestones', {}, '领取营业额档位奖励')"
          >
            一键领取可达档位
          </BaseButton>
        </div>
      </section>

      <section class="rounded-2xl border border-amber-100 bg-white p-5 shadow-sm dark:border-amber-900/30 dark:bg-gray-800 sm:p-6">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <h2 class="text-base font-semibold text-gray-900 dark:text-gray-100">兑换商店</h2>
          <span class="text-xs text-gray-500 dark:text-gray-400">{{ shopItems.length }} 件商品 · 花费奶茶券或金币</span>
        </div>

        <template v-for="group in [
          { key: 'seeds', label: '种子', items: seedItems },
          { key: 'decor', label: '装扮', items: decorItems },
          { key: 'props', label: '道具', items: propItems },
        ]" :key="group.key">
          <div v-if="group.items.length" class="mt-5">
            <p class="text-sm font-medium text-gray-700 dark:text-gray-300">{{ group.label }}</p>
            <div class="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              <div
                v-for="item in group.items" :key="item.slotId"
                class="flex min-w-0 items-center justify-between gap-2 rounded-xl border px-3 py-2.5"
                :class="item.status === 1 ? 'border-gray-200 bg-gray-50/60 dark:border-gray-700 dark:bg-gray-900/30' : 'border-gray-100 bg-gray-50/40 opacity-70 dark:border-gray-700/60 dark:bg-gray-900/20'"
              >
                <div class="min-w-0">
                  <p class="truncate text-sm font-medium text-gray-800 dark:text-gray-200" :title="item.name">{{ item.name || `物品#${item.itemId}` }}</p>
                  <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                    {{ costText(item) }}<span v-if="(item.itemCount || 1) > 1"> ×{{ item.itemCount }}</span>
                    <span v-if="item.status !== 1" class="ml-1 text-gray-400 dark:text-gray-500">· 未解锁</span>
                  </p>
                </div>
                <BaseButton
                  size="sm" variant="secondary" class="shrink-0"
                  :disabled="item.status !== 1 || !activity.active"
                  :loading="operating === `exchange:${item.slotId}`"
                  @click="operate('exchange', { slotId: item.slotId, count: 1 }, `兑换${item.name || '商品'}`)"
                >
                  兑换
                </BaseButton>
              </div>
            </div>
          </div>
        </template>
        <p class="mt-4 text-xs text-gray-400 dark:text-gray-500">状态为"未解锁"的商品需满足游戏内条件（店铺等级或营业额）后才能兑换。</p>
      </section>

      <section v-if="rulesText.length" class="rounded-2xl border border-amber-100 bg-white p-5 shadow-sm dark:border-amber-900/30 dark:bg-gray-800 sm:p-6">
        <h2 class="text-base font-semibold text-gray-900 dark:text-gray-100">活动说明</h2>
        <div class="mt-3 space-y-1.5 text-sm text-gray-600 dark:text-gray-300">
          <template v-for="(line, index) in rulesText" :key="index">
            <p v-if="line" class="leading-relaxed [&_b]:font-semibold [&_br]:hidden" v-html="line" />
          </template>
        </div>
      </section>

      <div v-if="hasCustomShopBody" class="flex items-start gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
        <span class="i-carbon-information mt-0.5 shrink-0 text-lg" />
        <p class="min-w-0">奶茶店主玩法（收银台收益、店铺升级、好友雇佣）为定制协议，待取证后接入；请先在游戏内操作。</p>
      </div>
    </template>
  </section>
</template>
