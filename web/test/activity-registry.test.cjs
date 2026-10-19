const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// 活动注册表替代了 Activity.vue 里一长串硬编码 ID 三元表达式。
// 这里用静态检查保证：
// 1. 每个注册项都在 Activity.vue 有对应面板分支；
// 2. Activity.vue 不再把活动 ID 直接写进适配判断；
// 3. 活动列表按「登记更新日期」而不是开始时间排序。

const ROOT = path.join(__dirname, '..', '..')
const registryPath = path.join(ROOT, 'web/src/constants/activity-registry.ts')
const activityPath = path.join(ROOT, 'web/src/views/Activity.vue')

function read(file) {
  return fs.readFileSync(file, 'utf8')
}

test('every registered activity has a panel branch in Activity.vue', () => {
  const registry = read(registryPath)
  const activity = read(activityPath)
  const keys = [...registry.matchAll(/key: '([\w-]+)'/g)].map(match => match[1])

  assert.ok(keys.length >= 6, `expected registrations, got ${keys.length}`)
  for (const key of keys) {
    assert.match(
      activity,
      new RegExp(`adaptedKey === '${key}'`),
      `Activity.vue 缺少 ${key} 的面板分支`,
    )
  }
})

test('Activity.vue uses the registry instead of hardcoded activity ids', () => {
  const activity = read(activityPath)
  assert.match(activity, /resolveActivityRegistration/)
  // 适配判断里不应再出现活动 ID 字面量
  assert.doesNotMatch(activity, /activityIds\.includes\(20\d{8}\)/)
  assert.doesNotMatch(activity, /group\.id === 20\d{8}/)
})

test('activity cards sort by registration update date', () => {
  const activity = read(activityPath)
  const cardBlock = activity.slice(activity.indexOf('const activityCards'), activity.indexOf('const filteredActivityCards'))
  assert.match(cardBlock, /updatedMs: registration \? registration\.updatedMs/)
  assert.doesNotMatch(cardBlock, /updatedMs: window\.startMs/)
})
