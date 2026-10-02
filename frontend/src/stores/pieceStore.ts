/**
 * 作品与吹制工序状态管理（Pinia）—— 吹制侧
 *
 * 写归属（仅吹制库 gbglassblow-blow）：作品登记、工序道次 / 温度 / 时长 / 操作人、
 * 工序拖拽重排、出炉检验。
 *
 * 只读归属：退火窑位编排来自排产库 gbglassblow-kiln，本 store 只订阅不写入；
 * 作品全流程状态由两侧数据在读取层即时派生（derivePieceState），
 * 因此排产侧改窑位 / 入窑时间绝不会把吹侧刚填的工序温度、操作人冲回旧值。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { Craft, Piece, PieceDraft, PieceState } from '../types/piece'
import type { Step, StepDraft } from '../types/step'
import type { Anneal } from '../types/anneal'
import type { Inspect } from '../types/inspect'
import {
  BLOW_DB_SCHEMA_VERSION,
  blowDb,
  countBlow,
  initBlowDatabase,
  putPiece,
  putStep,
  removePiece,
  removeStep,
  reorderSteps,
} from '../utils/blowDb'
import { initKilnDatabase, kilnDb } from '../utils/kilnDb'
import { ROW_REVISION } from '../utils/ownership'
import { derivePieceState } from '../utils/derivedState'
import { buildStepProgress, type StepProgress } from '../hooks/useStepProgress'
import { nowIso, uuid } from '../utils/id'

/** 作品筛选条件 */
export interface PieceFilters {
  keyword: string
  craft: Craft | 'all'
  state: PieceState | 'all'
}

const EMPTY_FILTERS: PieceFilters = { keyword: '', craft: 'all', state: 'all' }

const CURRENT_PIECE_KEY = 'gbglassblow:currentPieceId'

function readCurrentPieceId(): string | null {
  try {
    const raw = window.localStorage.getItem(CURRENT_PIECE_KEY)
    return raw === null || raw === '' ? null : raw
  } catch {
    return null
  }
}

function writeCurrentPieceId(id: string | null): void {
  try {
    window.localStorage.setItem(CURRENT_PIECE_KEY, id ?? '')
  } catch {
    /* 隐私模式下写入失败时静默降级 */
  }
}

let blowSubscribed = false
let annealSubscribed = false

export const usePieceStore = defineStore('piece', () => {
  const pieces = ref<Piece[]>([])
  const steps = ref<Step[]>([])
  const inspects = ref<Inspect[]>([])
  /** 排产侧退火记录（只读，跨库订阅） */
  const anneals = ref<Anneal[]>([])
  const loading = ref(true)
  const ready = ref(false)
  const error = ref('')
  const counts = ref<Record<string, number>>({})
  const lastMessage = ref('')
  const revision = ref(0)
  const currentPieceId = ref<string | null>(readCurrentPieceId())
  const filters = reactive<PieceFilters>({ ...EMPTY_FILTERS })

  /* ---------- 跨库只读派生 ---------- */

  function annealsOf(pieceId: string): Anneal[] {
    return anneals.value.filter((row) => row.pieceId === pieceId)
  }

  function inspectsOf(pieceId: string): Inspect[] {
    return inspects.value.filter((row) => row.pieceId === pieceId)
  }

  /**
   * 作品全流程状态（跨库即时派生）：
   * 检验（吹侧）→ 已出炉退火（排侧）→ 有工序（吹侧）→ 设计中。
   */
  function stateOf(pieceId: string): PieceState {
    return derivePieceState(stepsOf(pieceId), annealsOf(pieceId), inspectsOf(pieceId))
  }

  /** pieceId → 派生状态的映射，供表格 / 标签批量渲染 */
  const stateMap = computed<Record<string, PieceState>>(() => {
    const result: Record<string, PieceState> = {}
    pieces.value.forEach((piece) => {
      result[piece.id] = stateOf(piece.id)
    })
    return result
  })

  const currentPiece = computed<Piece | null>(
    () => pieces.value.find((row) => row.id === currentPieceId.value) ?? null
  )

  /** 附带派生状态的作品视图（列表渲染统一用它，不再读 row.state 旧快照） */
  const decoratedPieces = computed(() =>
    pieces.value.map((piece) => ({ ...piece, state: stateOf(piece.id) })),
  )

  const visiblePieces = computed(() => {
    const keyword = filters.keyword.trim().toLowerCase()
    return decoratedPieces.value.filter((piece) => {
      if (filters.craft !== 'all' && piece.craft !== filters.craft) return false
      if (filters.state !== 'all' && piece.state !== filters.state) return false
      if (keyword === '') return true
      return (
        piece.name.toLowerCase().includes(keyword) ||
        piece.artist.toLowerCase().includes(keyword) ||
        piece.craft.toLowerCase().includes(keyword)
      )
    })
  })

  function stepsOf(pieceId: string): Step[] {
    return steps.value.filter((row) => row.pieceId === pieceId).sort((a, b) => a.seq - b.seq)
  }

  function progressOf(pieceId: string): StepProgress {
    return buildStepProgress(pieceId, steps.value)
  }

  const inProgressCount = computed<number>(
    () => decoratedPieces.value.filter((row) => row.state === '设计中' || row.state === '制作中').length
  )

  async function loadAll(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      const blowReady = initBlowDatabase()
      await blowReady
      // 排产库仅用于只读订阅退火记录；它打不开不阻断吹侧功能
      await initKilnDatabase(blowReady).catch(() => undefined)

      if (!blowSubscribed) {
        blowSubscribed = true
        liveQuery(async () => {
          const [pieceRows, stepRows, inspectRows] = await Promise.all([
            blowDb.pieces.toArray(),
            blowDb.steps.toArray(),
            blowDb.inspects.toArray(),
          ])
          return { pieceRows, stepRows, inspectRows }
        }).subscribe({
          next: ({ pieceRows, stepRows, inspectRows }) => {
            const sorted = [...pieceRows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            pieces.value = sorted
            steps.value = [...stepRows].sort(
              (a, b) => a.pieceId.localeCompare(b.pieceId) || a.seq - b.seq,
            )
            inspects.value = [...inspectRows].sort((a, b) => b.date.localeCompare(a.date))
            loading.value = false
            ready.value = true
            error.value = ''
            const stillExists =
              currentPieceId.value !== null && sorted.some((row) => row.id === currentPieceId.value)
            if (!stillExists) {
              selectPiece(sorted.length > 0 ? sorted[0].id : null)
            }
          },
          error: (err: unknown) => {
            error.value = err instanceof Error ? err.message : '读取吹制侧作品数据失败'
            loading.value = false
          },
        })
      }

      if (!annealSubscribed) {
        annealSubscribed = true
        liveQuery(() => kilnDb.anneals.toArray()).subscribe({
          next: (rows) => {
            anneals.value = rows
          },
          error: () => {
            // 排产库暂不可用时吹侧功能保持可用，退火状态显示为无记录
            anneals.value = []
          },
        })
      }

      await refreshCounts()
    } catch (err) {
      error.value = err instanceof Error ? err.message : '初始化吹制侧本地数据库失败'
      loading.value = false
    }
  }

  function selectPiece(pieceId: string | null): void {
    currentPieceId.value = pieceId
    writeCurrentPieceId(pieceId)
  }

  function setFilters(patch: Partial<PieceFilters>): void {
    Object.assign(filters, patch)
  }

  function resetFilters(): void {
    Object.assign(filters, { ...EMPTY_FILTERS })
  }

  /* ------------------------------ 作品（吹侧写） ------------------------------ */

  async function createPiece(draft: PieceDraft): Promise<Piece> {
    const stamp = nowIso()
    const row: Piece = {
      id: uuid('piece'),
      name: draft.name.trim() || '未命名作品',
      batchId: draft.batchId,
      designHeightMm: draft.designHeightMm,
      wallThicknessMm: draft.wallThicknessMm,
      craft: draft.craft,
      artist: draft.artist.trim(),
      state: draft.state,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await putPiece(row)
    selectPiece(row.id)
    revision.value += 1
    lastMessage.value = `已登记作品「${row.name}」，可继续录入吹制工序`
    return row
  }

  async function updatePiece(pieceId: string, draft: PieceDraft): Promise<void> {
    const existing = pieces.value.find((row) => row.id === pieceId)
    if (existing === undefined) return
    await putPiece({
      ...existing,
      name: draft.name.trim() || existing.name,
      batchId: draft.batchId,
      designHeightMm: draft.designHeightMm,
      wallThicknessMm: draft.wallThicknessMm,
      craft: draft.craft,
      artist: draft.artist.trim(),
      // 登记时允许手工选择阶段；跨侧推进（退火 / 检验）不再回写覆盖该字段
      state: draft.state,
    })
    revision.value += 1
  }

  async function deletePiece(pieceId: string): Promise<void> {
    await removePiece(pieceId)
    if (currentPieceId.value === pieceId) selectPiece(null)
    await refreshCounts()
    revision.value += 1
    lastMessage.value = '作品及其吹制工序、检验记录已删除（排产侧窑位编排归排产员，未被删除）'
  }

  /* ------------------------------ 工序（吹侧写） ------------------------------ */

  async function createStep(draft: StepDraft): Promise<Step> {
    const stamp = nowIso()
    const row: Step = {
      id: uuid('step'),
      pieceId: draft.pieceId,
      seq: draft.seq,
      name: draft.name,
      tempC: draft.tempC,
      durationMin: draft.durationMin,
      operator: draft.operator.trim(),
      remark: draft.remark.trim(),
      state: draft.state,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await putStep(row)
    revision.value += 1
    return row
  }

  async function updateStep(stepId: string, draft: StepDraft): Promise<void> {
    const existing = steps.value.find((row) => row.id === stepId)
    if (existing === undefined) return
    await putStep({
      ...existing,
      seq: draft.seq,
      name: draft.name,
      tempC: draft.tempC,
      durationMin: draft.durationMin,
      operator: draft.operator.trim(),
      remark: draft.remark.trim(),
      state: draft.state,
    })
    revision.value += 1
  }

  async function deleteStep(stepId: string): Promise<void> {
    await removeStep(stepId)
    revision.value += 1
    lastMessage.value = '工序已删除（仅吹制侧）'
  }

  /** 推进工序状态：未开始 → 进行中 → 已完成 */
  async function advanceStep(stepId: string): Promise<void> {
    const existing = steps.value.find((row) => row.id === stepId)
    if (existing === undefined) return
    const flow: Step['state'][] = ['未开始', '进行中', '已完成']
    const index = flow.indexOf(existing.state)
    if (index < 0 || index >= flow.length - 1) {
      lastMessage.value = '该工序已处于「已完成」状态'
      return
    }
    const next = flow[index + 1]
    await putStep({ ...existing, state: next })
    revision.value += 1
    const piece = pieces.value.find((row) => row.id === existing.pieceId)
    lastMessage.value = `第 ${existing.seq} 道「${existing.name}」已推进为「${next}」${
      piece === undefined ? '' : `（作品：${piece.name}）`
    }`
  }

  /** 拖拽排序：把 fromId 移动到 toId 之前；只重写吹侧工序序号，不触碰排产侧入窑时间 */
  async function moveStepBefore(pieceId: string, fromId: string, toId: string): Promise<void> {
    if (fromId === toId) return
    const list = stepsOf(pieceId)
    const fromIndex = list.findIndex((row) => row.id === fromId)
    const toIndex = list.findIndex((row) => row.id === toId)
    if (fromIndex < 0 || toIndex < 0) return
    const [moved] = list.splice(fromIndex, 1)
    list.splice(toIndex, 0, moved)
    await reorderSteps(list.map((row) => row.id))
    revision.value += 1
    lastMessage.value = `已调整工序顺序：「${moved.name}」移动到第 ${toIndex + 1} 道（排产侧入窑时间不受影响）`
  }

  /** 按序号升序重排（拖拽置顶/置底等场景） */
  async function moveStepToIndex(pieceId: string, stepId: string, targetIndex: number): Promise<void> {
    const list = stepsOf(pieceId)
    const fromIndex = list.findIndex((row) => row.id === stepId)
    if (fromIndex < 0) return
    const [moved] = list.splice(fromIndex, 1)
    const index = Math.max(0, Math.min(list.length, targetIndex))
    list.splice(index, 0, moved)
    await reorderSteps(list.map((row) => row.id))
    revision.value += 1
    lastMessage.value = `已把「${moved.name}」调整到第 ${index + 1} 道`
  }

  async function refreshCounts(): Promise<void> {
    const result = await countBlow()
    counts.value = { ...result, schemaVersion: BLOW_DB_SCHEMA_VERSION }
  }

  return {
    pieces,
    decoratedPieces,
    steps,
    inspects,
    anneals,
    loading,
    ready,
    error,
    counts,
    filters,
    lastMessage,
    revision,
    currentPieceId,
    currentPiece,
    visiblePieces,
    inProgressCount,
    stateMap,
    stateOf,
    annealsOf,
    inspectsOf,
    stepsOf,
    progressOf,
    loadAll,
    selectPiece,
    setFilters,
    resetFilters,
    createPiece,
    updatePiece,
    deletePiece,
    createStep,
    updateStep,
    deleteStep,
    advanceStep,
    moveStepBefore,
    moveStepToIndex,
    refreshCounts,
  }
})
