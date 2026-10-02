/**
 * 按角色拆分的本地数据库（吹制组库 / 排产员库）
 *
 * 背景：吹制组与窑务排产员原本共用一份 IndexedDB，保存时整行 put，
 * 晚到的一方会把对方刚填的字段（工序温度/操作人、窑位/入窑时间）整体覆盖，
 * 出现「窑位一变，工序温度与操作人回到旧值；工序重排又把入窑时间冲掉」。
 *
 * 方案：两边各持自己的库，按归属拥有各自的表与字段，互不从属：
 * - 吹制库 `gbglassblow-craft`：拥有 pieces / steps / inspects，
 *   并只读复制 furnaces / batches（工序页校验温度、显示窑炉料液用）。
 * - 排产库 `gbglassblow-schedule`：拥有 furnaces / batches / anneals，
 *   并只读复制 pieces / steps（排产员看作品名、壁厚与前序工序进度用）。
 *
 * 跨库的只读副本由 reconcileReplicas 对齐；任何一侧的保存都只写自己库内的表，
 * 事务失败按「本侧」重试，绝不回滚或覆盖对侧已确认的数据。
 * 旧版单库 `gbglassblow` 仅用于一次性迁移，迁移后不再写入。
 */
import { reactive } from 'vue'
import Dexie, { type Table } from 'dexie'
import type { Furnace } from '../types/furnace'
import type { GlassBatch } from '../types/batch'
import type { Piece, PieceState } from '../types/piece'
import type { Step } from '../types/step'
import type { Anneal } from '../types/anneal'
import type { Inspect } from '../types/inspect'
import { nowIso } from '../utils/id'

/** 存档格式版本（与旧库一致，保证 JSON 存档可互相导入） */
export const DB_SCHEMA_VERSION = 2

/** 数据行结构修订号 */
export const ROW_REVISION = 2

/** 旧版单库名（仅用于迁移） */
export const LEGACY_DB_NAME = 'gbglassblow'
/** 对外展示用的库名（存档 name 字段沿用旧名，保证备份可导入） */
export const DB_NAME = LEGACY_DB_NAME
/** 吹制组库名 */
export const CRAFT_DB_NAME = 'gbglassblow-craft'
/** 排产员库名 */
export const SCHEDULE_DB_NAME = 'gbglassblow-schedule'

/** 角色侧：craft = 吹制组，schedule = 排产员 */
export type Side = 'craft' | 'schedule'

/* ------------------------------ 吹制组库 ------------------------------ */

class CraftDatabase extends Dexie {
  furnaces!: Table<Furnace, string>
  batches!: Table<GlassBatch, string>
  pieces!: Table<Piece, string>
  steps!: Table<Step, string>
  inspects!: Table<Inspect, string>

  constructor() {
    super(CRAFT_DB_NAME)
    this.version(1).stores({
      // furnaces / batches 为只读副本（归属排产库）
      furnaces: 'id, code, type, state, fuelType, createdAt, updatedAt',
      batches: 'id, furnaceId, colorCode, meltDate, remainKg, updatedAt',
      // pieces / steps / inspects 归属吹制组
      pieces: 'id, batchId, state, artist, craft, name, updatedAt',
      steps: 'id, pieceId, [pieceId+seq], seq, state, name, updatedAt',
      inspects: 'id, pieceId, date, result, inspector, updatedAt',
    })
  }
}

/* ------------------------------ 排产员库 ------------------------------ */

class ScheduleDatabase extends Dexie {
  furnaces!: Table<Furnace, string>
  batches!: Table<GlassBatch, string>
  pieces!: Table<Piece, string>
  steps!: Table<Step, string>
  anneals!: Table<Anneal, string>

  constructor() {
    super(SCHEDULE_DB_NAME)
    this.version(1).stores({
      // furnaces / batches 归属排产员
      furnaces: 'id, code, type, state, fuelType, createdAt, updatedAt',
      batches: 'id, furnaceId, colorCode, meltDate, remainKg, updatedAt',
      // pieces / steps 为只读副本（归属吹制组）
      pieces: 'id, batchId, state, artist, craft, name, updatedAt',
      steps: 'id, pieceId, [pieceId+seq], seq, state, name, updatedAt',
      // anneals 归属排产员
      anneals: 'id, pieceId, kilnSlot, state, inAt, curveSeg, updatedAt',
    })
  }
}

export const craftDb = new CraftDatabase()
export const scheduleDb = new ScheduleDatabase()

/* ------------------------------ 旧版单库（迁移用） ------------------------------ */

class LegacyDatabase extends Dexie {
  furnaces!: Table<Furnace, string>
  batches!: Table<GlassBatch, string>
  pieces!: Table<Piece, string>
  steps!: Table<Step, string>
  anneals!: Table<Anneal, string>
  inspects!: Table<Inspect, string>

  constructor() {
    super(LEGACY_DB_NAME)
    this.version(DB_SCHEMA_VERSION).stores({
      furnaces: 'id, code, type, state, fuelType, createdAt, updatedAt',
      batches: 'id, furnaceId, colorCode, meltDate, remainKg, updatedAt',
      pieces: 'id, batchId, state, artist, craft, name, updatedAt',
      steps: 'id, pieceId, [pieceId+seq], seq, state, name, updatedAt',
      anneals: 'id, pieceId, kilnSlot, state, inAt, curveSeg, updatedAt',
      inspects: 'id, pieceId, date, result, inspector, updatedAt',
    })
  }
}

export const legacyDb = new LegacyDatabase()

/* --------------------------- 各侧保存失败与重试状态 --------------------------- */

export interface SideSaveState {
  /** 最近一次保存失败信息（已自动重试过仍失败）；空串表示无失败 */
  error: string
  /** 是否存在可手动重试的失败保存 */
  canRetry: boolean
  /** 是否正在手动重试 */
  retrying: boolean
}

/** 两侧独立的保存状态：一侧失败不影响另一侧已确认的数据 */
export const saveState = reactive<Record<Side, SideSaveState>>({
  craft: { error: '', canRetry: false, retrying: false },
  schedule: { error: '', canRetry: false, retrying: false },
})

interface PendingRetry {
  label: string
  run: () => Promise<void>
}

/** 各侧最近一次失败的保存（闭包重放同一个 put / delete），用于「按本侧重试」 */
const pendingRetry: Record<Side, PendingRetry | null> = { craft: null, schedule: null }

const MAX_ATTEMPTS = 3
const RETRY_BACKOFF_MS = 120

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * 按侧重试执行一个持久化操作。
 * - 只操作「本侧库」，事务失败自动重试 MAX_ATTEMPTS 次；
 * - 全部失败后把失败信息记入该侧 saveState 并保留重放闭包，供 UI「按本侧重试」；
 * - 绝不触碰对侧库，因此对侧已确认的数据不会被回滚或覆盖。
 */
async function withRetry<T>(side: Side, label: string, operation: () => Promise<T>): Promise<T> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const result = await operation()
      saveState[side].error = ''
      saveState[side].canRetry = false
      pendingRetry[side] = null
      return result
    } catch (err) {
      lastErr = err
      if (attempt < MAX_ATTEMPTS) await delay(RETRY_BACKOFF_MS * attempt)
    }
  }
  saveState[side].error = `${label}失败（已重试 ${MAX_ATTEMPTS} 次）：${describeError(lastErr)}`
  saveState[side].canRetry = true
  pendingRetry[side] = {
    label,
    run: async (): Promise<void> => {
      await withRetry(side, label, operation)
    },
  }
  throw lastErr
}

/** 手动重试某一侧最近一次失败的保存；成功后对齐一次只读副本 */
export async function retrySave(side: Side): Promise<void> {
  const pending = pendingRetry[side]
  if (pending === null) return
  saveState[side].retrying = true
  try {
    await pending.run()
    requestReconcile()
  } finally {
    saveState[side].retrying = false
  }
}

/** 新增 / 覆盖一行（按侧写入归属表，自动补 updatedAt / revision） */
export function saveOwned<T extends { id: string }>(
  side: Side,
  table: Table<T, string>,
  row: T,
  label: string,
): Promise<void> {
  const stamped = { ...row, updatedAt: nowIso(), revision: ROW_REVISION } as T
  return withRetry(side, label, async () => {
    await table.put(stamped)
  })
}

/** 删除一行（按侧） */
export function removeOwned<T>(side: Side, table: Table<T, string>, id: string, label: string): Promise<void> {
  return withRetry(side, label, async () => {
    await table.delete(id)
  })
}

/* ------------------------------ 跨库副本对齐 ------------------------------ */

let reconcileTimer: ReturnType<typeof setTimeout> | null = null

/** 防抖触发副本对齐（一次保存后调用，把归属表的增量同步到对侧只读副本） */
export function requestReconcile(): void {
  if (reconcileTimer !== null) clearTimeout(reconcileTimer)
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null
    void reconcileReplicas().catch(() => undefined)
  }, 80)
}

/**
 * 全量对齐只读副本：把归属表的行原样复制到对侧副本表，
 * 并删除对侧副本中已不存在的行（传播删除）。
 * 副本表只由本函数写入，业务代码不直接改副本，因此不会出现双向覆盖。
 */
async function reconcilePair<T extends { id: string }>(src: Table<T, string>, dst: Table<T, string>): Promise<void> {
  const rows = await src.toArray()
  const ids = new Set(rows.map((row) => row.id))
  await dst.db.transaction('rw', dst, async () => {
    await dst.bulkPut(rows)
    const existing = await dst.toArray()
    const stale = existing.filter((row) => !ids.has(row.id)).map((row) => row.id)
    if (stale.length > 0) await dst.bulkDelete(stale)
  })
}

/** 对齐全部只读副本（吹制 → 排产：pieces / steps；排产 → 吹制：furnaces / batches） */
export async function reconcileReplicas(): Promise<void> {
  await Promise.all([
    reconcilePair(craftDb.pieces, scheduleDb.pieces),
    reconcilePair(craftDb.steps, scheduleDb.steps),
    reconcilePair(scheduleDb.furnaces, craftDb.furnaces),
    reconcilePair(scheduleDb.batches, craftDb.batches),
  ])
}

/* ------------------------------ 初始化 / 迁移 / 播种 ------------------------------ */

let initPromise: Promise<void> | null = null
const MIGRATED_FLAG = 'gbglassblow:split-v1'

function readMigratedFlag(): boolean {
  try {
    return window.localStorage.getItem(MIGRATED_FLAG) === '1'
  } catch {
    return false
  }
}

function writeMigratedFlag(): void {
  try {
    window.localStorage.setItem(MIGRATED_FLAG, '1')
  } catch {
    /* 隐私模式下静默降级 */
  }
}

/** 打开两侧库；首次运行时把旧单库数据按归属迁移到两边，或播种演示数据；随后对齐副本 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await Promise.all([craftDb.open(), scheduleDb.open(), legacyDb.open()])
      if (!readMigratedFlag()) {
        const legacyCount = await legacyDb.furnaces.count()
        if (legacyCount > 0) {
          await migrateLegacy()
        } else if ((await craftDb.pieces.count()) === 0 && (await scheduleDb.anneals.count()) === 0) {
          await seedRoleDatabases()
        }
        writeMigratedFlag()
      }
      await reconcileReplicas()
    })()
  }
  return initPromise
}

/** 旧单库数据按归属迁移到两边（幂等：仅在首次检测到旧库数据时执行） */
async function migrateLegacy(): Promise<void> {
  const [furnaces, batches, pieces, steps, anneals, inspects] = await Promise.all([
    legacyDb.furnaces.toArray(),
    legacyDb.batches.toArray(),
    legacyDb.pieces.toArray(),
    legacyDb.steps.toArray(),
    legacyDb.anneals.toArray(),
    legacyDb.inspects.toArray(),
  ])

  // 排产员归属：窑炉、料液、退火
  await withRetry('schedule', '旧数据迁移（排产侧）', async () => {
    await scheduleDb.transaction('rw', [scheduleDb.furnaces, scheduleDb.batches, scheduleDb.anneals], async () => {
      await scheduleDb.furnaces.bulkPut(furnaces)
      await scheduleDb.batches.bulkPut(batches)
      await scheduleDb.anneals.bulkPut(anneals)
    })
  })
  // 吹制组归属：作品、工序、检验
  await withRetry('craft', '旧数据迁移（吹制侧）', async () => {
    await craftDb.transaction('rw', [craftDb.pieces, craftDb.steps, craftDb.inspects], async () => {
      await craftDb.pieces.bulkPut(pieces)
      await craftDb.steps.bulkPut(steps)
      await craftDb.inspects.bulkPut(inspects)
    })
  })

  await reconcileReplicas()
}

/* -------------------------------- 窑炉 -------------------------------- */

export async function listFurnaces(): Promise<Furnace[]> {
  const rows = await scheduleDb.furnaces.toArray()
  return rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
}

export function putFurnace(row: Furnace): Promise<void> {
  return saveOwned('schedule', scheduleDb.furnaces, row, '窑炉保存').then(requestReconcile)
}

/** 删除窑炉：级联清理该窑下的料液批次（排产侧事务） */
export async function removeFurnace(id: string): Promise<void> {
  await withRetry('schedule', '窑炉删除', async () => {
    await scheduleDb.transaction('rw', [scheduleDb.furnaces, scheduleDb.batches], async () => {
      await scheduleDb.batches.where('furnaceId').equals(id).delete()
      await scheduleDb.furnaces.delete(id)
    })
  })
  requestReconcile()
}

/* ------------------------------ 料液批次 ------------------------------ */

export async function listBatches(): Promise<GlassBatch[]> {
  const rows = await scheduleDb.batches.toArray()
  return rows.sort((a, b) => b.meltDate.localeCompare(a.meltDate))
}

export function putBatch(row: GlassBatch): Promise<void> {
  return saveOwned('schedule', scheduleDb.batches, row, '料液批次保存').then(requestReconcile)
}

export function removeBatch(id: string): Promise<void> {
  return removeOwned('schedule', scheduleDb.batches, id, '料液批次删除').then(requestReconcile)
}

/** 取料：按剩余量扣减（不足时扣到 0 并返回实际扣减量） */
export async function consumeBatch(batchId: string, kg: number): Promise<number> {
  const batch = await scheduleDb.batches.get(batchId)
  if (!batch) return 0
  const actual = Math.max(0, Math.min(batch.remainKg, kg))
  await withRetry('schedule', '取料扣减', async () => {
    await scheduleDb.batches.update(batchId, {
      remainKg: Math.round((batch.remainKg - actual) * 10) / 10,
      updatedAt: nowIso(),
    })
  })
  requestReconcile()
  return actual
}

/* -------------------------------- 作品 -------------------------------- */

export async function listPieces(): Promise<Piece[]> {
  const rows = await craftDb.pieces.toArray()
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function putPiece(row: Piece): Promise<void> {
  return saveOwned('craft', craftDb.pieces, row, '作品保存').then(requestReconcile)
}

/** 删除作品：级联清理本侧工序/检验与排产侧退火记录 */
export async function removePiece(id: string): Promise<void> {
  await withRetry('craft', '作品删除', async () => {
    await craftDb.transaction('rw', [craftDb.pieces, craftDb.steps, craftDb.inspects], async () => {
      await craftDb.steps.where('pieceId').equals(id).delete()
      await craftDb.inspects.where('pieceId').equals(id).delete()
      await craftDb.pieces.delete(id)
    })
  })
  // 排产侧退火记录随作品一并清理（失败不影响吹制侧已确认的删除结果）
  try {
    await withRetry('schedule', '作品退火记录清理', async () => {
      await scheduleDb.anneals.where('pieceId').equals(id).delete()
    })
  } catch {
    /* 排产侧清理失败时保留副本，界面以「作品已删除」兜底展示 */
  }
  requestReconcile()
}

/**
 * 依工序（吹制库）、退火（排产库）、检验（吹制库）推导并回写作品状态。
 * 规则：有检验记录 → 已检验；有已出炉退火 → 已退火；有工序记录 → 制作中；否则设计中。
 * 状态是派生字段，回写失败不向上抛，避免影响排产侧保存结果（错误已记在吹制侧）。
 */
export async function syncPieceState(pieceId: string): Promise<PieceState | null> {
  const piece = await craftDb.pieces.get(pieceId)
  if (!piece) return null
  const [steps, anneals, inspects] = await Promise.all([
    craftDb.steps.where('pieceId').equals(pieceId).toArray(),
    scheduleDb.anneals.where('pieceId').equals(pieceId).toArray(),
    craftDb.inspects.where('pieceId').equals(pieceId).toArray(),
  ])

  let next: PieceState = '设计中'
  if (steps.length > 0) next = '制作中'
  if (anneals.some((row) => row.state === '已出炉')) next = '已退火'
  if (inspects.length > 0) next = '已检验'

  if (next !== piece.state) {
    try {
      await withRetry('craft', '作品状态回写', async () => {
        await craftDb.pieces.update(pieceId, { state: next, updatedAt: nowIso() })
      })
    } catch {
      /* saveState.craft 已记录，不向排产侧保存流程抛错 */
    }
    requestReconcile()
  }
  return next
}

/* -------------------------------- 工序 -------------------------------- */

export async function listSteps(): Promise<Step[]> {
  const rows = await craftDb.steps.toArray()
  return rows.sort((a, b) => a.pieceId.localeCompare(b.pieceId) || a.seq - b.seq)
}

export async function listStepsByPiece(pieceId: string): Promise<Step[]> {
  const rows = await craftDb.steps.where('pieceId').equals(pieceId).toArray()
  return rows.sort((a, b) => a.seq - b.seq)
}

export async function putStep(row: Step): Promise<void> {
  await saveOwned('craft', craftDb.steps, row, '吹制工序保存')
  await syncPieceState(row.pieceId)
  requestReconcile()
}

export async function removeStep(id: string): Promise<void> {
  const step = await craftDb.steps.get(id)
  if (!step) return
  await removeOwned('craft', craftDb.steps, id, '吹制工序删除')
  await syncPieceState(step.pieceId)
  requestReconcile()
}

/** 按给定 id 顺序重写工序序号（拖拽排序后调用；仅写吹制库） */
export async function reorderSteps(orderedIds: string[]): Promise<void> {
  await withRetry('craft', '工序顺序调整', async () => {
    await craftDb.transaction('rw', craftDb.steps, async () => {
      for (let index = 0; index < orderedIds.length; index += 1) {
        await craftDb.steps.update(orderedIds[index], { seq: index + 1, updatedAt: nowIso() })
      }
    })
  })
  requestReconcile()
}

/* -------------------------------- 退火 -------------------------------- */

export async function listAnneals(): Promise<Anneal[]> {
  const rows = await scheduleDb.anneals.toArray()
  return rows.sort((a, b) => a.inAt.localeCompare(b.inAt))
}

export async function listAnnealsByPiece(pieceId: string): Promise<Anneal[]> {
  return scheduleDb.anneals.where('pieceId').equals(pieceId).toArray()
}

export async function putAnneal(row: Anneal): Promise<void> {
  await saveOwned('schedule', scheduleDb.anneals, row, '退火编排保存')
  await syncPieceState(row.pieceId)
  requestReconcile()
}

export async function removeAnneal(id: string): Promise<void> {
  const row = await scheduleDb.anneals.get(id)
  if (!row) return
  await removeOwned('schedule', scheduleDb.anneals, id, '退火记录删除')
  await syncPieceState(row.pieceId)
  requestReconcile()
}

/** 推进退火状态；「已出炉」时写回出炉时间并同步作品状态 */
export async function advanceAnnealState(annealId: string, next: Anneal['state'], outAt: string): Promise<void> {
  const row = await scheduleDb.anneals.get(annealId)
  if (!row) return
  await withRetry('schedule', '退火状态推进', async () => {
    await scheduleDb.anneals.update(annealId, {
      state: next,
      outAt: next === '已出炉' ? outAt : row.outAt,
      updatedAt: nowIso(),
    })
  })
  await syncPieceState(row.pieceId)
  requestReconcile()
}

/* ------------------------------ 出炉检验 ------------------------------ */

export async function listInspects(): Promise<Inspect[]> {
  const rows = await craftDb.inspects.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function listInspectsByPiece(pieceId: string): Promise<Inspect[]> {
  const rows = await craftDb.inspects.where('pieceId').equals(pieceId).toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function putInspect(row: Inspect): Promise<void> {
  await saveOwned('craft', craftDb.inspects, row, '出炉检验保存')
  await syncPieceState(row.pieceId)
  requestReconcile()
}

export async function removeInspect(id: string): Promise<void> {
  const row = await craftDb.inspects.get(id)
  if (!row) return
  await removeOwned('craft', craftDb.inspects, id, '出炉检验删除')
  await syncPieceState(row.pieceId)
  requestReconcile()
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string
  schemaVersion: number
  exportedAt: string
  furnaces: Furnace[]
  batches: GlassBatch[]
  pieces: Piece[]
  steps: Step[]
  anneals: Anneal[]
  inspects: Inspect[]
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [furnaces, batches, pieces, steps, anneals, inspects] = await Promise.all([
    scheduleDb.furnaces.toArray(),
    scheduleDb.batches.toArray(),
    craftDb.pieces.toArray(),
    craftDb.steps.toArray(),
    scheduleDb.anneals.toArray(),
    craftDb.inspects.toArray(),
  ])
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    furnaces,
    batches,
    pieces,
    steps,
    anneals,
    inspects,
  }
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await withRetry('schedule', '整库导入（排产侧）', async () => {
    await scheduleDb.transaction('rw', [scheduleDb.furnaces, scheduleDb.batches, scheduleDb.anneals], async () => {
      await scheduleDb.furnaces.clear()
      await scheduleDb.batches.clear()
      await scheduleDb.anneals.clear()
      await scheduleDb.furnaces.bulkPut(snapshot.furnaces.map((row) => ({ ...row, revision: ROW_REVISION })))
      await scheduleDb.batches.bulkPut(snapshot.batches.map((row) => ({ ...row, revision: ROW_REVISION })))
      await scheduleDb.anneals.bulkPut(snapshot.anneals.map((row) => ({ ...row, revision: ROW_REVISION })))
    })
  })
  await withRetry('craft', '整库导入（吹制侧）', async () => {
    await craftDb.transaction('rw', [craftDb.pieces, craftDb.steps, craftDb.inspects], async () => {
      await craftDb.pieces.clear()
      await craftDb.steps.clear()
      await craftDb.inspects.clear()
      await craftDb.pieces.bulkPut(snapshot.pieces.map((row) => ({ ...row, revision: ROW_REVISION })))
      await craftDb.steps.bulkPut(snapshot.steps.map((row) => ({ ...row, revision: ROW_REVISION })))
      await craftDb.inspects.bulkPut(snapshot.inspects.map((row) => ({ ...row, revision: ROW_REVISION })))
    })
  })
  await reconcileReplicas()
}

export async function resetDatabase(): Promise<void> {
  await withRetry('schedule', '重置演示数据（排产侧）', async () => {
    await scheduleDb.transaction('rw', [scheduleDb.furnaces, scheduleDb.batches, scheduleDb.anneals], async () => {
      await Promise.all([scheduleDb.furnaces.clear(), scheduleDb.batches.clear(), scheduleDb.anneals.clear()])
    })
  })
  await withRetry('craft', '重置演示数据（吹制侧）', async () => {
    await craftDb.transaction('rw', [craftDb.pieces, craftDb.steps, craftDb.inspects], async () => {
      await Promise.all([craftDb.pieces.clear(), craftDb.steps.clear(), craftDb.inspects.clear()])
    })
  })
  await seedRoleDatabases()
  await reconcileReplicas()
}

export async function countAll(): Promise<Record<string, number>> {
  const [furnaces, batches, pieces, steps, anneals, inspects] = await Promise.all([
    scheduleDb.furnaces.count(),
    scheduleDb.batches.count(),
    craftDb.pieces.count(),
    craftDb.steps.count(),
    scheduleDb.anneals.count(),
    craftDb.inspects.count(),
  ])
  return { furnaces, batches, pieces, steps, anneals, inspects }
}

/* ------------------------------ 演示数据播种 ------------------------------ */

/** 播种演示数据到两侧归属表（副本随后由 reconcileReplicas 对齐） */
async function seedRoleDatabases(): Promise<void> {
  const { buildSeedData } = await import('../utils/seed')
  const { furnaces, batches, pieces, steps, anneals, inspects } = buildSeedData()

  await withRetry('schedule', '演示数据播种（排产侧）', async () => {
    await scheduleDb.transaction('rw', [scheduleDb.furnaces, scheduleDb.batches, scheduleDb.anneals], async () => {
      await scheduleDb.furnaces.bulkPut(furnaces)
      await scheduleDb.batches.bulkPut(batches)
      await scheduleDb.anneals.bulkPut(anneals)
    })
  })
  await withRetry('craft', '演示数据播种（吹制侧）', async () => {
    await craftDb.transaction('rw', [craftDb.pieces, craftDb.steps, craftDb.inspects], async () => {
      await craftDb.pieces.bulkPut(pieces)
      await craftDb.steps.bulkPut(steps)
      await craftDb.inspects.bulkPut(inspects)
    })
  })
}
