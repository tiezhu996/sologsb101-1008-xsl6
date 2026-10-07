/**
 * 调节单状态（Pinia）
 * 维护调节单状态机、复核统计与筛选。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useIdbTable } from '@/hooks/useIdbTable'
import { createId, db, ROW_REVISION, type AdjustRow } from '@/utils/db'
import {
  ADJUST_STATE_FLOW,
  type Adjust,
  type AdjustDraft,
  type AdjustState
} from '@/types/adjust'
import { useValveStore } from '@/stores/valveStore'
import { balanceLevel, imbalance, type BalanceLevel } from '@/utils/balance'
import type { Valve } from '@/types/valve'

export interface AdjustEnriched {
  adjust: Adjust
  valve: Valve | null
  /** 生成调节单时的失衡度快照（按最新实测重算） */
  imbalanceValue: number
  level: BalanceLevel
}

/** 由失衡度排行灌入的批量派单数据（沿用排行的最新实测、建议开度与依据） */
export interface RankAdjustDraft {
  valve: Valve
  /** 排行按最新实测给出的判级，平衡阀门不派单 */
  level: BalanceLevel
  suggestOpening: number
  basisText: string
}

export interface BatchGenerateResult {
  /** 实际处理的失衡阀门数（平衡项不计入） */
  total: number
  /** 覆盖的待下发原单数 */
  overwritten: number
  /** 保留历史后新开的单数 */
  created: number
}

/** 批量写入中途失败：事务整体回滚，failedValveCode 标记首个写入失败的阀门 */
export class BatchAdjustError extends Error {
  failedValveCode: string
  constructor(failedValveCode: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : '本地写入失败'
    super(`阀门 ${failedValveCode} 调节单写入失败：${reason}`)
    this.name = 'BatchAdjustError'
    this.failedValveCode = failedValveCode
  }
}

export const useAdjustStore = defineStore('adjust', () => {
  const adjustTable = useIdbTable<AdjustRow>((database) => database.adjusts, { sortByUpdatedAt: false })
  const valveStore = useValveStore()

  const stateFilter = ref<AdjustState[]>([])
  const keyword = ref('')
  const latestMeasureByValve = ref<Record<string, { flowM3h: number; roomTempC: number; date: string }>>({})

  /** 由失衡度排行灌入最新实测快照，供失衡度重算与展示 */
  function syncLatestMeasures(
    rows: Array<{ valve: Valve; measured: number; latest: { roomTempC: number; date: string } | null }>
  ): void {
    const map: Record<string, { flowM3h: number; roomTempC: number; date: string }> = {}
    rows.forEach((row) => {
      if (row.latest) {
        map[row.valve.id] = { flowM3h: row.measured, roomTempC: row.latest.roomTempC, date: row.latest.date }
      }
    })
    latestMeasureByValve.value = map
  }

  const adjusts = computed<AdjustRow[]>(() =>
    [...adjustTable.rows.value].sort((a, b) => b.updatedAt - a.updatedAt)
  )

  const enriched = computed<AdjustEnriched[]>(() =>
    adjusts.value.map((adjust) => {
      const valve = valveStore.valves.find((item) => item.id === adjust.valveId) ?? null
      const snapshot = latestMeasureByValve.value[adjust.valveId]
      const design = valve ? valve.designFlowM3h : 0
      const measured = snapshot ? snapshot.flowM3h : 0
      const room = snapshot ? snapshot.roomTempC : 20
      const value = snapshot ? imbalance(measured, design, room) : 0
      return {
        adjust,
        valve,
        imbalanceValue: value,
        level: valve && snapshot ? balanceLevel(value, measured, design) : '平衡'
      }
    })
  )

  const filtered = computed<AdjustEnriched[]>(() =>
    enriched.value.filter((item) => {
      if (stateFilter.value.length > 0 && !stateFilter.value.includes(item.adjust.state)) return false
      const text = keyword.value.trim().toLowerCase()
      if (text.length === 0) return true
      return (
        (item.valve ? item.valve.code.toLowerCase().includes(text) : false) ||
        item.adjust.executor.toLowerCase().includes(text) ||
        item.adjust.basis.toLowerCase().includes(text)
      )
    })
  )

  const stateCounts = computed<Record<AdjustState, number>>(() => {
    const counts: Record<AdjustState, number> = { 待下发: 0, 已调节: 0, 已复核: 0 }
    adjusts.value.forEach((adjust) => {
      counts[adjust.state] += 1
    })
    return counts
  })

  const reviewedPercent = computed(() =>
    adjusts.value.length === 0 ? 0 : Math.round((stateCounts.value['已复核'] / adjusts.value.length) * 100)
  )

  function patchFilter(patch: { stateFilter?: AdjustState[]; keyword?: string }): void {
    if (patch.stateFilter) stateFilter.value = patch.stateFilter
    if (patch.keyword !== undefined) keyword.value = patch.keyword
  }

  function resetFilter(): void {
    stateFilter.value = []
    keyword.value = ''
  }

  const hasAdjust = (valveId: string): boolean => adjusts.value.some((adjust) => adjust.valveId === valveId)

  /** 该阀门当前待下发单（用于判断派单时是覆盖还是保留历史新开）；无则返回 null */
  const pendingOf = (valveId: string): AdjustRow | null =>
    adjusts.value.find((adjust) => adjust.valveId === valveId && adjust.state === '待下发') ?? null

  async function createAdjust(draft: AdjustDraft): Promise<AdjustRow> {
    return (await adjustTable.create(
      {
        valveId: draft.valveId,
        targetOpening: Math.min(100, Math.max(0, Math.round(draft.targetOpening))),
        basis: draft.basis.trim(),
        executor: draft.executor.trim() || '待指派',
        state: draft.state,
        reviewNote: draft.reviewNote.trim()
      },
      'aj'
    )) as AdjustRow
  }

  async function updateAdjust(id: string, patch: Partial<AdjustDraft>): Promise<void> {
    const next: Partial<AdjustRow> = { ...patch }
    if (patch.targetOpening !== undefined) next.targetOpening = Math.min(100, Math.max(0, Math.round(patch.targetOpening)))
    if (patch.basis !== undefined) next.basis = patch.basis.trim()
    if (patch.executor !== undefined) next.executor = patch.executor.trim()
    if (patch.reviewNote !== undefined) next.reviewNote = patch.reviewNote.trim()
    await adjustTable.update(id, next)
  }

  async function removeAdjust(id: string): Promise<void> {
    await adjustTable.remove(id)
  }

  /** 状态流转：已调节时把目标开度回写到阀门 */
  async function advance(id: string): Promise<AdjustState | null> {
    const adjust = adjusts.value.find((item) => item.id === id)
    if (!adjust) return null
    const next = ADJUST_STATE_FLOW[adjust.state]
    if (!next) return null
    await adjustTable.update(id, { state: next })
    if (next === '已调节') {
      await valveStore.applyOpening(adjust.valveId, adjust.targetOpening)
    }
    return next
  }

  /** 复核：写复核意见并闭环 */
  async function review(id: string, note: string): Promise<void> {
    await adjustTable.update(id, { state: '已复核', reviewNote: note.trim() || '复核合格' })
  }

  /**
   * 按排行勾选结果批量生成待下发调节单（单事务原子写入）。
   * 决策口径（依据排行最新实测对应的既有调节单状态）：
   * - 该阀门存在「待下发」单：直接覆盖原单（保留 id，更新目标开度/依据，重置执行人与复核意见），
   *   不新开，避免同一阀门出现两张待下发单；
   * - 仅存在「已调节 / 已复核」单：保留全部历史记录，另开一张待下发单。
   * 任一条写入失败时事务回滚，前面的修改一并撤回，并抛出携带失败阀门编号的 BatchAdjustError。
   */
  async function batchDispatchFromRank(drafts: RankAdjustDraft[]): Promise<BatchGenerateResult> {
    const target = drafts.filter((draft) => draft.level !== '平衡')

    const result: BatchGenerateResult = { total: target.length, overwritten: 0, created: 0 }

    if (target.length === 0) return result

    const now = Date.now()
    try {
      await db.transaction('rw', db.adjusts, async () => {
        const existing = await db.adjusts.toArray()
        const byValve = new Map<string, AdjustRow[]>()
        existing.forEach((adjust) => {
          const group = byValve.get(adjust.valveId)
          if (group) group.push(adjust)
          else byValve.set(adjust.valveId, [adjust])
        })

        await Promise.all(
          target.map(async (draft) => {
            try {
              const own = byValve.get(draft.valve.id) ?? []
              const pending = own.filter((adjust) => adjust.state === '待下发')
              const fields = {
                targetOpening: Math.min(100, Math.max(20, Math.round(draft.suggestOpening))),
                basis: draft.basisText.trim(),
                executor: '待指派',
                state: '待下发' as AdjustState,
                reviewNote: ''
              }

              if (pending.length > 0) {
                // 覆盖最早一张待下发单；同阀若存在重复待下发单，删除多余项，保证至多一张
                const [primary, ...duplicates] = pending.sort((a, b) => a.createdAt - b.createdAt)
                await db.adjusts.put({
                  ...primary,
                  ...fields,
                  createdAt: primary.createdAt,
                  updatedAt: now,
                  revision: ROW_REVISION
                })
                if (duplicates.length > 0) await db.adjusts.bulkDelete(duplicates.map((item) => item.id))
                result.overwritten += 1
              } else {
                // 已调节 / 已复核历史全部保留，另开新单
                await db.adjusts.put({
                  id: createId('aj'),
                  valveId: draft.valve.id,
                  ...fields,
                  createdAt: now,
                  updatedAt: now,
                  revision: ROW_REVISION
                })
                result.created += 1
              }
            } catch (cause) {
              // 标记实际写入失败的阀门；事务会随异常整体回滚
              throw new BatchAdjustError(draft.valve.code, cause)
            }
          })
        )
      })
    } catch (error) {
      if (error instanceof BatchAdjustError) throw error
      throw new BatchAdjustError(target[0]?.valve.code ?? '未知阀门', error)
    }

    return result
  }

  return {
    adjustTable,
    adjusts,
    enriched,
    filtered,
    stateFilter,
    keyword,
    stateCounts,
    reviewedPercent,
    syncLatestMeasures,
    latestMeasureByValve,
    patchFilter,
    resetFilter,
    hasAdjust,
    pendingOf,
    createAdjust,
    updateAdjust,
    removeAdjust,
    advance,
    review,
    batchDispatchFromRank
  }
})
