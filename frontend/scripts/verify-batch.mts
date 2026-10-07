/**
 * 验证批量派单决策：覆盖待下发 / 保留历史新开 / 去重 / 失败整批回滚。
 * 直接复用 db.ts 的 Dexie 实例与 adjustStore 的纯逻辑不便（依赖 Vue 作用域），
 * 故在此用独立 Dexie 表复刻 batchDispatchFromRank 的事务体不可取——
 * 改为：在 effectScope 中真实实例化 Pinia + adjustStore，valveStore 用桩替换。
 */
import 'fake-indexeddb/auto'
import { EffectScope, effectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { db, ROW_REVISION } from '../src/utils/db'
import { useAdjustStore, BatchAdjustError } from '../src/stores/adjustStore'
import type { Valve } from './src/types/valve'

function valve(id: string, code: string): Valve {
  return { id, buildingId: 'b', stationId: 's', code, dn: 50, currentOpening: 50, designFlowM3h: 20, position: '楼栋总阀' }
}

const draft = (id: string, code: string, opening = 70) => ({
  valve: valve(id, code),
  level: '偏小' as const,
  suggestOpening: opening,
  basisText: `${code} 依据`
})

async function addAdjust(id: string, valveId: string, state: '待下发' | '已调节' | '已复核', createdAt = 1) {
  await db.adjusts.put({
    id, valveId, targetOpening: 40, basis: 'old', executor: '张三', state, reviewNote: '',
    createdAt, updatedAt: createdAt, revision: ROW_REVISION
  })
}

let pass = 0
let fail = 0
function assert(cond: boolean, msg: string): void {
  if (cond) { pass++; console.log(`  ✓ ${msg}`) }
  else { fail++; console.error(`  ✗ ${msg}`) }
}

async function run(): Promise<void> {
  setActivePinia(createPinia())
  const scope: EffectScope = effectScope()
  const store = scope.run(() => useAdjustStore())!

  // 等 liveQuery 首次载入
  await new Promise((r) => setTimeout(r, 50))

  console.log('场景1：无历史 → 新开')
  await db.adjusts.clear()
  let res = await store.batchDispatchFromRank([draft('v1', 'V1'), draft('v2', 'V2')])
  assert(res.created === 2 && res.overwritten === 0, '返回 created=2')
  let rows = await db.adjusts.toArray()
  assert(rows.length === 2 && rows.every((r) => r.state === '待下发' && r.executor === '待指派'), '两张待下发单')

  console.log('场景2：已有待下发单 → 覆盖原单，不新开')
  await db.adjusts.clear()
  await addAdjust('aj-pending', 'v1', '待下发', 100)
  res = await store.batchDispatchFromRank([draft('v1', 'V1', 85)])
  assert(res.overwritten === 1 && res.created === 0, '返回 overwritten=1')
  rows = await db.adjusts.where('valveId').equals('v1').toArray()
  assert(rows.length === 1, '仍只有 1 张单（无重复待下发）')
  assert(rows[0].id === 'aj-pending', '保留原单 id')
  assert(rows[0].targetOpening === 85 && rows[0].basis === 'V1 依据', '更新开度与依据为最新实测结果')
  assert(rows[0].executor === '待指派' && rows[0].reviewNote === '', '重置执行人/复核意见')
  assert(rows[0].createdAt === 100, 'createdAt 保留，updatedAt 刷新')

  console.log('场景3：已调节 / 已复核 → 保留历史并新开')
  await db.adjusts.clear()
  await addAdjust('aj-done', 'v1', '已调节', 100)
  await addAdjust('aj-review', 'v1', '已复核', 90)
  res = await store.batchDispatchFromRank([draft('v1', 'V1', 65)])
  assert(res.created === 1 && res.overwritten === 0, '返回 created=1')
  rows = await db.adjusts.where('valveId').equals('v1').toArray()
  assert(rows.length === 3, '历史 2 张保留 + 新开 1 张')
  const kept = rows.filter((r) => r.id === 'aj-done' || r.id === 'aj-review')
  assert(kept.length === 2 && kept.every((r) => r.targetOpening === 40 && r.basis === 'old'), '已调节/已复核原单未被改动')
  const fresh = rows.find((r) => r.targetOpening === 65 && r.state === '待下发')
  assert(!!fresh, '新开单为待下发且用最新建议开度')

  console.log('场景4：同阀重复待下发单 → 合并为一张')
  await db.adjusts.clear()
  await addAdjust('dup1', 'v1', '待下发', 100)
  await addAdjust('dup2', 'v1', '待下发', 200)
  res = await store.batchDispatchFromRank([draft('v1', 'V1', 75)])
  rows = await db.adjusts.where('valveId').equals('v1').toArray()
  assert(rows.length === 1, '只保留 1 张待下发单')
  assert(rows[0].id === 'dup1' && rows[0].targetOpening === 75, '覆盖最早那张')

  console.log('场景5：混合批（覆盖 + 新开 + 平衡跳过）')
  await db.adjusts.clear()
  await addAdjust('ajx', 'v1', '待下发', 100)
  await addAdjust('ajy', 'v2', '已复核', 100)
  const mixed = [
    draft('v1', 'V1'),
    draft('v2', 'V2'),
    draft('v3', 'V3'),
    { ...draft('v4', 'V4'), level: '平衡' as const }
  ]
  res = await store.batchDispatchFromRank(mixed)
  assert(res.total === 3 && res.overwritten === 1 && res.created === 2, '平衡项跳过，覆盖1新开2')
  assert((await db.adjusts.count()) === 4, '共 4 张：原 2 + 新开 2')

  console.log('场景6：任一写入失败 → 整批回滚 + 抛出失败阀门')
  await db.adjusts.clear()
  await addAdjust('keep', 'v1', '已复核', 100)
  const before = (await db.adjusts.toArray()).map((r) => ({ ...r }))
  // 桩掉 db.adjusts.put：前 2 次成功、第 3 次起抛错（模拟后段阀门写入失败）
  const origPut = db.adjusts.put.bind(db.adjusts)
  let putCalls = 0
  db.adjusts.put = ((...args: unknown[]) => {
    putCalls += 1
    if (putCalls >= 3) return Promise.reject(new Error('QuotaExceededError 模拟'))
    return origPut(...(args as [unknown]))
  }) as typeof db.adjusts.put
  let caught: unknown = null
  try {
    await store.batchDispatchFromRank([draft('v1', 'V1'), draft('v2', 'V2'), draft('v3', 'V3')])
  } catch (e) {
    caught = e
  } finally {
    db.adjusts.put = origPut
  }
  assert(caught instanceof BatchAdjustError, '抛出 BatchAdjustError')
  assert((caught as BatchAdjustError).failedValveCode === 'V3', `失败阀门为 V3（实际 ${(caught as BatchAdjustError)?.failedValveCode}）`)
  const after = await db.adjusts.toArray()
  assert(after.length === 1 && after[0].id === 'keep', '前面已写入的新开/覆盖全部回滚')
  assert(JSON.stringify(after) === JSON.stringify(before), '回滚后数据与批前完全一致')

  scope.stop()
  console.log(`\n结果：${pass} 通过，${fail} 失败`)
  if (fail > 0) process.exit(1)
  process.exit(0)
}

void run()
