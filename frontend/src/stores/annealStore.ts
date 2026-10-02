/**
 * 退火窑位与曲线状态管理（Pinia）—— 窑务排产侧
 *
 * 写归属（仅排产库 gbglassblow-kiln）：窑位、入窑时间、曲线段、出炉时间、状态。
 * 只读归属（吹制库 gbglassblow-blow）：作品（壁厚 / 名称）、工序完成度、退火窑台账。
 *
 * - 窑位时间窗重叠时禁止提交，并指出与哪一件的记录冲突；
 * - 前序工序未做完时，作品进入「卡点」队列，排产员能看到卡在哪一件的哪一道；
 * - 任一侧保存失败只按本侧重试（见 withSideRetry），吹侧确认过的工序数据不受影响。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { Anneal, AnnealDraft, AnnealState, CurveSeg } from '../types/anneal'
import { ANNEAL_STATE_FLOW } from '../types/anneal'
import type { Piece } from '../types/piece'
import type { Step } from '../types/step'
import type { Furnace } from '../types/furnace'
import {
  KILN_DB_SCHEMA_VERSION,
  kilnDb,
  initKilnDatabase,
  putAnneal,
  removeAnneal,
  advanceAnnealState,
  blowReadonlyDb,
} from '../utils/kilnDb'
import { initBlowDatabase } from '../utils/blowDb'
import { ROW_REVISION } from '../utils/ownership'
import {
  checkSlotConflict,
  formatHours,
  kilnSlots,
  segmentHours,
  totalAnnealHours,
  type SlotConflict,
} from '../utils/thermal'
import { buildScheduleQueue, type ScheduleQueueItem } from '../utils/derivedState'
import { nowIso, nowLocalInput, uuid } from '../utils/id'

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

const EMPTY_FILTERS: AnnealFilters = { keyword: '', state: 'all', curveSeg: 'all', kilnCode: 'all' }

let kilnSubscribed = false
let blowSubscribed = false

export const useAnnealStore = defineStore('anneal', () => {
  const anneals = ref<Anneal[]>([])
  /** 吹制侧作品（只读） */
  const pieces = ref<Piece[]>([])
  /** 吹制侧工序（只读，用于卡点展示） */
  const steps = ref<Step[]>([])
  /** 吹制侧退火窑台账（只读，窑位池） */
  const annealFurnaces = ref<Furnace[]>([])
  const loading = ref(true)
  const ready = ref(false)
  const error = ref('')
  const lastMessage = ref('')
  /** 最近一次本侧保存失败信息（空串表示无失败；保存成功后清空） */
  const saveError = ref('')
  const revision = ref(0)
  const filters = reactive<AnnealFilters>({ ...EMPTY_FILTERS })

  const kilnCodes = computed<string[]>(() => {
    const fromFurnaces = annealFurnaces.value.map((row) => row.code)
    const fromAnneals = anneals.value.map((row) => row.kilnSlot.split('-').slice(0, -1).join('-'))
    const set = new Set<string>([...fromFurnaces, ...fromAnneals].filter((code) => code !== ''))
    return Array.from(set).sort()
  })

  const wallThicknessOf = (pieceId: string): number =>
    pieces.value.find((row) => row.id === pieceId)?.wallThicknessMm ?? 4

  /** 全部窑位（来自吹制侧退火窑台账，兜底 AN-01） */
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
      .sort((a, b) => a.kilnSlot.localeCompare(b.kilnSlot) || a.inAt.localeCompare(b.inAt)),
  )

  const occupiedSlotCount = computed<number>(
    () => new Set(occupancy.value.filter((row) => row.occupied).map((row) => row.kilnSlot)).size,
  )
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
   * 排产队列（跨库只读派生）：
   * 待排作品与前序卡点同列展示，排产员能直接看到卡在哪一件、哪一道。
   */
  const scheduleQueue = computed<ScheduleQueueItem[]>(() =>
    buildScheduleQueue(pieces.value, steps.value, anneals.value),
  )

  /**
   * 前序未做完的作品（卡点列表）：
   * 含尚未占窑的，也含已提前占了「待入窑」位但工序仍未完成的（需要催办 / 调整入窑时间）。
   * 已出炉的不再算卡点。
   */
  const blockedPieces = computed<ScheduleQueueItem[]>(() =>
    scheduleQueue.value.filter((item) => !item.ready && !item.finished),
  )

  /** 工序全部完成、等待窑位的作品 */
  const readyPieces = computed<ScheduleQueueItem[]>(() =>
    scheduleQueue.value.filter((item) => item.ready && !item.scheduled && !item.finished),
  )

  /** 某件作品的前序工序是否已全部完成（排产提交的硬前置） */
  function isPieceReady(pieceId: string): boolean {
    const item = scheduleQueue.value.find((row) => row.piece.id === pieceId)
    return item?.ready ?? false
  }

  /** 某件作品卡点原因（已完成返回空串） */
  function blockReasonOf(pieceId: string): string {
    const item = scheduleQueue.value.find((row) => row.piece.id === pieceId)
    return item?.blockReason ?? ''
  }

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
      const blowReady = initBlowDatabase()
      await initKilnDatabase(blowReady)

      if (!kilnSubscribed) {
        kilnSubscribed = true
        liveQuery(() => kilnDb.anneals.toArray()).subscribe({
          next: (rows) => {
            anneals.value = [...rows].sort((a, b) => a.inAt.localeCompare(b.inAt))
            loading.value = false
            ready.value = true
            error.value = ''
          },
          error: (err: unknown) => {
            error.value = err instanceof Error ? err.message : '读取排产侧退火数据失败'
            loading.value = false
          },
        })
      }

      if (!blowSubscribed) {
        blowSubscribed = true
        void blowReady.then(() => {
          liveQuery(async () => {
            const [pieceRows, stepRows, furnaceRows] = await Promise.all([
              blowReadonlyDb.pieces.toArray(),
              blowReadonlyDb.steps.toArray(),
              blowReadonlyDb.furnaces.toArray(),
            ])
            return { pieceRows, stepRows, furnaceRows }
          }).subscribe({
            next: ({ pieceRows, stepRows, furnaceRows }) => {
              pieces.value = pieceRows
              steps.value = stepRows
              annealFurnaces.value = furnaceRows.filter((row) => row.type === '退火窑')
            },
            error: () => {
              // 吹侧库暂不可用时保留上一次只读快照，不影响排产侧写入
            },
          })
        })
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : '初始化排产侧本地数据库失败'
      loading.value = false
    }
  }

  function setFilters(patch: Partial<AnnealFilters>): void {
    Object.assign(filters, patch)
  }

  function resetFilters(): void {
    Object.assign(filters, { ...EMPTY_FILTERS })
  }

  /** 排产侧写入统一收口：成功清空失败标记，失败记录本侧错误（另一侧不受影响） */
  async function persistSide(action: () => Promise<void>): Promise<boolean> {
    try {
      await action()
      saveError.value = ''
      return true
    } catch (err) {
      saveError.value = err instanceof Error ? err.message : '排产侧保存失败'
      lastMessage.value = saveError.value
      return false
    }
  }

  async function createAnneal(draft: AnnealDraft): Promise<Anneal | null> {
    // 硬前置：前序工序没做完不允许排窑位，原因精确到卡住的道次
    if (!isPieceReady(draft.pieceId)) {
      lastMessage.value = `前序工序未完成，暂不能排位：${blockReasonOf(draft.pieceId) || '吹制组尚未完成工序'}`
      saveError.value = ''
      return null
    }
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
      saveError.value = ''
      return null
    }
    const stamp = nowIso()
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
      revision: ROW_REVISION,
    }
    const ok = await persistSide(() => putAnneal(row))
    if (!ok) return null
    revision.value += 1
    lastMessage.value = `已分配窑位 ${row.kilnSlot}，理论时长 ${formatHours(
      segmentHours(row.curveSeg, wallThicknessOf(row.pieceId)),
    )}`
    return row
  }

  async function updateAnneal(annealId: string, draft: AnnealDraft): Promise<boolean> {
    // 编辑已存在的记录（如因前序未完成而推迟入窑时间）允许保存；
    // 只有新建排位才把前序完成作为硬前置。前序卡点仍由页面警告与卡点列表展示。
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
    const ok = await persistSide(() =>
      putAnneal({
        ...existing,
        pieceId: draft.pieceId,
        kilnSlot: draft.kilnSlot,
        curveSeg: draft.curveSeg,
        inAt: draft.inAt,
        outAt: draft.outAt,
        state: draft.state,
      }),
    )
    if (!ok) return false
    revision.value += 1
    lastMessage.value = '退火编排已更新（吹侧工序数据未改动）'
    return true
  }

  async function deleteAnneal(annealId: string): Promise<void> {
    const ok = await persistSide(() => removeAnneal(annealId))
    if (!ok) return
    revision.value += 1
    lastMessage.value = '退火记录已删除（排产侧）'
  }

  /** 推进退火状态；「已出炉」写回出炉时间。作品状态由吹侧读取层派生，本侧不回写作品表 */
  async function advance(annealId: string): Promise<AnnealState | null> {
    const existing = anneals.value.find((row) => row.id === annealId)
    if (existing === undefined) return null
    const index = ANNEAL_STATE_FLOW.indexOf(existing.state)
    if (index < 0 || index >= ANNEAL_STATE_FLOW.length - 1) return null
    const next = ANNEAL_STATE_FLOW[index + 1]
    const ok = await persistSide(() => advanceAnnealState(annealId, next, nowLocalInput()))
    if (!ok) return null
    revision.value += 1
    lastMessage.value = next === '已出炉' ? '已登记出炉，作品全流程状态已自动派生为「已退火」' : `退火状态已推进为「${next}」`
    return next
  }

  return {
    anneals,
    pieces,
    steps,
    annealFurnaces,
    kilnCodes,
    loading,
    ready,
    error,
    saveError,
    filters,
    lastMessage,
    revision,
    allSlots,
    occupancy,
    occupiedSlotCount,
    occupancyRate,
    visibleAnneals,
    scheduleQueue,
    blockedPieces,
    readyPieces,
    wallThicknessOf,
    conflictOf,
    durationOf,
    isPieceReady,
    blockReasonOf,
    loadAll,
    setFilters,
    resetFilters,
    createAnneal,
    updateAnneal,
    deleteAnneal,
    advance,
    schemaVersion: KILN_DB_SCHEMA_VERSION,
  }
})
