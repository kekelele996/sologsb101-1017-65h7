/**
 * 退火窑位与曲线状态管理（Pinia · 排产侧）
 * 维护窑位占用表与退火曲线段；窑位冲突时禁止提交，出炉即回写作品状态。
 * 数据落在排产库 gbglassblow-schedule（scheduleDb），保存失败可按本侧重试，
 * 不影响吹制库已确认的工序温度、时长与操作人。
 * 排产页可看到「卡在哪一件」：前序工序未完成或时间窗重叠的作品会被明确列出。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { Anneal, AnnealDraft, AnnealState, CurveSeg } from '../types/anneal'
import { ANNEAL_STATE_FLOW } from '../types/anneal'
import type { Piece } from '../types/piece'
import type { Step } from '../types/step'
import {
  advanceAnnealState,
  initDatabase,
  putAnneal,
  removeAnneal,
  retrySave,
  saveState,
  scheduleDb,
} from '../db/roleDb'
import { buildStepProgress } from '../hooks/useStepProgress'
import {
  checkSlotConflict,
  formatHours,
  kilnSlots,
  segmentHours,
  totalAnnealHours,
  type SlotConflict,
} from '../utils/thermal'
import { nowLocalInput, uuid } from '../utils/id'

/** 退火筛选条件 */
export interface AnnealFilters {
  keyword: string
  state: AnnealState | 'all'
  curveSeg: CurveSeg | 'all'
  kilnCode: string | 'all'
}

/** 窑位占用行 */
export interface SlotOccupancy {
  kilnSlot: string
  annealId: string
  pieceId: string
  pieceName: string
  curveSeg: CurveSeg
  inAt: string
  outAt: string
  state: AnnealState
  /** 该窑位当前是否被未出炉记录占用 */
  occupied: boolean
}

/** 排产受阻作品：前序未完成 或 时间窗重叠 */
export interface BlockedPiece {
  pieceId: string
  pieceName: string
  craft: string
  /** prerequisite = 前序工序未完成；conflict = 窑位时间窗重叠 */
  kind: 'prerequisite' | 'conflict'
  /** 受阻原因（含具体道次或冲突对象） */
  reason: string
}

const EMPTY_FILTERS: AnnealFilters = { keyword: '', state: 'all', curveSeg: 'all', kilnCode: 'all' }

let subscribed = false

export const useAnnealStore = defineStore('anneal', () => {
  const anneals = ref<Anneal[]>([])
  const pieces = ref<Piece[]>([])
  /** 工序进度只读副本（来自吹制库），用于排产前判断前序是否完成 */
  const steps = ref<Step[]>([])
  const loading = ref(true)
  const ready = ref(false)
  const error = ref('')
  const lastMessage = ref('')
  const revision = ref(0)
  const filters = reactive<AnnealFilters>({ ...EMPTY_FILTERS })

  /** 排产侧保存失败信息（按本侧重试，不影响吹制侧已确认数据） */
  const saveError = computed<string>(() => saveState.schedule.error)
  const canRetrySave = computed<boolean>(() => saveState.schedule.canRetry)
  const retryingSave = computed<boolean>(() => saveState.schedule.retrying)

  async function retryLastSave(): Promise<void> {
    await retrySave('schedule')
  }

  const kilnCodes = computed<string[]>(() => {
    const set = new Set<string>()
    anneals.value.forEach((row) => {
      const code = row.kilnSlot.split('-').slice(0, -1).join('-')
      if (code !== '') set.add(code)
    })
    return Array.from(set).sort()
  })

  const wallThicknessOf = (pieceId: string): number =>
    pieces.value.find((row) => row.id === pieceId)?.wallThicknessMm ?? 4

  /** 全部窑位（按已有退火记录推导窑号，兜底 AN-01） */
  const allSlots = computed<string[]>(() => {
    const codes = kilnCodes.value.length > 0 ? kilnCodes.value : ['AN-01']
    return codes.flatMap((code) => kilnSlots(code))
  })

  /** 窑位占用表 */
  const occupancy = computed<SlotOccupancy[]>(() =>
    anneals.value
      .map((row) => {
        const piece = pieces.value.find((item) => item.id === row.pieceId)
        return {
          kilnSlot: row.kilnSlot,
          annealId: row.id,
          pieceId: row.pieceId,
          pieceName: piece?.name ?? '（作品已删除）',
          curveSeg: row.curveSeg,
          inAt: row.inAt,
          outAt: row.outAt,
          state: row.state,
          occupied: row.state !== '已出炉',
        }
      })
      .sort((a, b) => a.kilnSlot.localeCompare(b.kilnSlot) || a.inAt.localeCompare(b.inAt))
  )

  const occupiedSlotCount = computed<number>(() => new Set(occupancy.value.filter((row) => row.occupied).map((row) => row.kilnSlot)).size)
  const occupancyRate = computed<number>(() => {
    const total = allSlots.value.length
    return total === 0 ? 0 : Math.round((occupiedSlotCount.value / total) * 1000) / 10
  })

  const visibleAnneals = computed<Anneal[]>(() => {
    const keyword = filters.keyword.trim().toLowerCase()
    return anneals.value.filter((row) => {
      if (filters.state !== 'all' && row.state !== filters.state) return false
      if (filters.curveSeg !== 'all' && row.curveSeg !== filters.curveSeg) return false
      if (filters.kilnCode !== 'all' && !row.kilnSlot.startsWith(filters.kilnCode)) return false
      if (keyword === '') return true
      const piece = pieces.value.find((item) => item.id === row.pieceId)
      return (
        row.kilnSlot.toLowerCase().includes(keyword) ||
        (piece?.name ?? '').toLowerCase().includes(keyword) ||
        row.inAt.includes(keyword)
      )
    })
  })

  /**
   * 排产受阻作品清单：前序工序未完成（看得见卡在哪一道）或窑位时间窗重叠（看得见撞在哪件）。
   * 排产员据此知道「卡在哪一件」，而不是只得到一个笼统的冲突提示。
   */
  const blockedPieces = computed<BlockedPiece[]>(() => {
    const result: BlockedPiece[] = []
    for (const piece of pieces.value) {
      const progress = buildStepProgress(piece.id, steps.value)
      if (!progress.allDone) {
        result.push({
          pieceId: piece.id,
          pieceName: piece.name,
          craft: piece.craft,
          kind: 'prerequisite',
          reason:
            progress.total === 0
              ? '尚未登记任何吹制工序'
              : `前序第 ${progress.currentSeq} 道「${progress.currentName}」未完成（当前 ${progress.done}/${progress.total} 道）`,
        })
        continue
      }
      // 前序已完成：检查该作品既有退火记录是否与他人在同一窑位时间窗重叠
      const ownAnneals = anneals.value.filter((row) => row.pieceId === piece.id)
      let conflictReason = ''
      for (const own of ownAnneals) {
        const conflict = checkSlotConflict(
          anneals.value,
          {
            id: own.id,
            kilnSlot: own.kilnSlot,
            inAt: own.inAt,
            outAt: own.outAt,
            curveSeg: own.curveSeg,
            pieceId: own.pieceId,
          },
          wallThicknessOf,
          own.id,
        )
        if (conflict.conflict) {
          const other = pieces.value.find((item) => item.id === conflict.withPieceId)
          conflictReason = `窑位 ${own.kilnSlot} 时间窗与「${other?.name ?? '已删除作品'}」重叠（${own.inAt.replace('T', ' ')} 起）`
          break
        }
      }
      if (conflictReason !== '') {
        result.push({
          pieceId: piece.id,
          pieceName: piece.name,
          craft: piece.craft,
          kind: 'conflict',
          reason: conflictReason,
        })
      }
    }
    return result
  })

  /** 前序已完成且无冲突、可立即排产的作品 */
  const schedulablePieceIds = computed<Set<string>>(
    () => new Set(pieces.value.filter((piece) => !blockedPieces.value.some((b) => b.pieceId === piece.id)).map((piece) => piece.id)),
  )

  /** 某件作品的窑位冲突检测（编辑时排除自身） */
  function conflictOf(
    candidate: Pick<Anneal, 'id' | 'kilnSlot' | 'inAt' | 'outAt' | 'curveSeg' | 'pieceId'>,
  ): SlotConflict {
    return checkSlotConflict(anneals.value, candidate, wallThicknessOf, candidate.id)
  }

  /** 某件作品的退火时长汇总 */
  function durationOf(pieceId: string): { hours: number; text: string } {
    const thickness = wallThicknessOf(pieceId)
    const hours = totalAnnealHours(thickness)
    return { hours, text: formatHours(hours) }
  }

  async function loadAll(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      await initDatabase()
      if (!subscribed) {
        subscribed = true
        liveQuery(async () => {
          const [annealRows, pieceRows, stepRows] = await Promise.all([
            scheduleDb.anneals.toArray(),
            scheduleDb.pieces.toArray(),
            scheduleDb.steps.toArray(),
          ])
          return { annealRows, pieceRows, stepRows }
        }).subscribe({
          next: ({ annealRows, pieceRows, stepRows }) => {
            anneals.value = [...annealRows].sort((a, b) => a.inAt.localeCompare(b.inAt))
            pieces.value = pieceRows
            steps.value = [...stepRows].sort((a, b) => a.pieceId.localeCompare(b.pieceId) || a.seq - b.seq)
            loading.value = false
            ready.value = true
            error.value = ''
          },
          error: (err: unknown) => {
            error.value = err instanceof Error ? err.message : '读取退火数据失败'
            loading.value = false
          },
        })
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : '初始化本地数据库失败'
      loading.value = false
    }
  }

  function setFilters(patch: Partial<AnnealFilters>): void {
    Object.assign(filters, patch)
  }

  function resetFilters(): void {
    Object.assign(filters, { ...EMPTY_FILTERS })
  }

  async function createAnneal(draft: AnnealDraft): Promise<Anneal | null> {
    const conflict = conflictOf({
      id: '',
      kilnSlot: draft.kilnSlot,
      inAt: draft.inAt,
      outAt: draft.outAt,
      curveSeg: draft.curveSeg,
      pieceId: draft.pieceId,
    })
    if (conflict.conflict) {
      lastMessage.value = conflict.message
      return null
    }
    const stamp = nowLocalInput()
    const row: Anneal = {
      id: uuid('anneal'),
      pieceId: draft.pieceId,
      kilnSlot: draft.kilnSlot,
      curveSeg: draft.curveSeg,
      inAt: draft.inAt,
      outAt: draft.outAt,
      state: draft.state,
      createdAt: stamp,
      updatedAt: stamp,
      revision: 2,
    }
    await putAnneal(row)
    revision.value += 1
    lastMessage.value = `已分配窑位 ${row.kilnSlot}，理论时长 ${formatHours(segmentHours(row.curveSeg, wallThicknessOf(row.pieceId)))}`
    return row
  }

  async function updateAnneal(annealId: string, draft: AnnealDraft): Promise<boolean> {
    const conflict = conflictOf({
      id: annealId,
      kilnSlot: draft.kilnSlot,
      inAt: draft.inAt,
      outAt: draft.outAt,
      curveSeg: draft.curveSeg,
      pieceId: draft.pieceId,
    })
    if (conflict.conflict) {
      lastMessage.value = conflict.message
      return false
    }
    const existing = anneals.value.find((row) => row.id === annealId)
    if (existing === undefined) return false
    await putAnneal({
      ...existing,
      pieceId: draft.pieceId,
      kilnSlot: draft.kilnSlot,
      curveSeg: draft.curveSeg,
      inAt: draft.inAt,
      outAt: draft.outAt,
      state: draft.state,
    })
    revision.value += 1
    lastMessage.value = '退火编排已更新'
    return true
  }

  async function deleteAnneal(annealId: string): Promise<void> {
    await removeAnneal(annealId)
    revision.value += 1
    lastMessage.value = '退火记录已删除'
  }

  /** 推进退火状态；「已出炉」写回出炉时间并同步作品状态 */
  async function advance(annealId: string): Promise<AnnealState | null> {
    const existing = anneals.value.find((row) => row.id === annealId)
    if (existing === undefined) return null
    const index = ANNEAL_STATE_FLOW.indexOf(existing.state)
    if (index < 0 || index >= ANNEAL_STATE_FLOW.length - 1) return null
    const next = ANNEAL_STATE_FLOW[index + 1]
    await advanceAnnealState(annealId, next, nowLocalInput())
    revision.value += 1
    lastMessage.value =
      next === '已出炉' ? '已登记出炉，作品状态已回写为「已退火」' : `退火状态已推进为「${next}」`
    return next
  }

  return {
    anneals,
    pieces,
    steps,
    loading,
    ready,
    error,
    filters,
    lastMessage,
    revision,
    saveError,
    canRetrySave,
    retryingSave,
    retryLastSave,
    blockedPieces,
    schedulablePieceIds,
    kilnCodes,
    allSlots,
    occupancy,
    occupiedSlotCount,
    occupancyRate,
    visibleAnneals,
    wallThicknessOf,
    conflictOf,
    durationOf,
    loadAll,
    setFilters,
    resetFilters,
    createAnneal,
    updateAnneal,
    deleteAnneal,
    advance,
  }
})
