/**
 * 吹制侧本地库（Dexie）：库名 gbglassblow-blow
 *
 * 归属吹制组：窑炉 / 料液批次 / 作品 / 吹制工序 / 出炉检验。
 * 窑务排产员对本库只有只读权限（见 kilnDb.ts 里的只读 Dexie 连接）。
 *
 * 结构版本：
 * - v1：两库拆分后的首个结构（索引与旧库 v2 对齐，字段按归属迁移）。
 */
import Dexie, { type Table } from 'dexie'
import type { Furnace } from '../types/furnace'
import type { GlassBatch } from '../types/batch'
import type { Piece } from '../types/piece'
import type { Step } from '../types/step'
import type { Inspect } from '../types/inspect'
import { ROW_REVISION, withSideRetry } from './ownership'
import { nowIso } from './id'
import { seedBlowDatabase } from './seedBlow'

/** 吹制侧数据库名 */
export const BLOW_DB_NAME = 'gbglassblow-blow'

/** 吹制侧数据结构版本号 */
export const BLOW_DB_SCHEMA_VERSION = 1

/** 旧版共用库名（仅用于一次性按归属迁移，不再写入） */
export const LEGACY_DB_NAME = 'gbglassblow'

class BlowDatabase extends Dexie {
  furnaces!: Table<Furnace, string>
  batches!: Table<GlassBatch, string>
  pieces!: Table<Piece, string>
  steps!: Table<Step, string>
  inspects!: Table<Inspect, string>

  constructor() {
    super(BLOW_DB_NAME)
    this.version(BLOW_DB_SCHEMA_VERSION).stores({
      furnaces: 'id, code, type, state, fuelType, createdAt, updatedAt',
      batches: 'id, furnaceId, colorCode, meltDate, remainKg',
      pieces: 'id, batchId, state, artist, craft, name',
      steps: 'id, pieceId, [pieceId+seq], seq, state, name',
      inspects: 'id, pieceId, date, result, inspector',
    })
  }
}

export const blowDb = new BlowDatabase()

/* ------------------------------ 初始化 / 迁移 / 播种 ------------------------------ */

const MIGRATION_FLAG_KEY = 'gbglassblow:legacyMigratedToV3'

let initPromise: Promise<void> | null = null

/** 旧共用库是否已经完成按归属迁移（localStorage 幂等标记） */
function isLegacyMigrated(): boolean {
  try {
    return window.localStorage.getItem(MIGRATION_FLAG_KEY) === 'done'
  } catch {
    return false
  }
}

function markLegacyMigrated(): void {
  try {
    window.localStorage.setItem(MIGRATION_FLAG_KEY, 'done')
  } catch {
    /* 隐私模式下降级：本次会话仍只执行一次（initPromise 兜底） */
  }
}

/**
 * 一次性把旧共用库 gbglassblow 中属于吹制侧的表搬到本库。
 * 旧库保持原样不删除，作为回滚兜底；只复制不清理。
 */
async function migrateLegacyBlowTables(): Promise<void> {
  if (isLegacyMigrated()) return
  const legacy = new Dexie(LEGACY_DB_NAME)
  let legacyVersion = 0
  try {
    // 旧库 v1 / v2 的表集合相同，直接按最新已知结构声明以只读方式打开
    legacy.version(2).stores({
      furnaces: 'id, code, type, state, fuelType, createdAt, updatedAt',
      batches: 'id, furnaceId, colorCode, meltDate, remainKg',
      pieces: 'id, batchId, state, artist, craft, name',
      steps: 'id, pieceId, [pieceId+seq], seq, state, name',
      anneals: 'id, pieceId, kilnSlot, state, inAt, curveSeg',
      inspects: 'id, pieceId, date, result, inspector',
    })
    await legacy.open()
    legacyVersion = legacy.verno
    const alreadyHasData = (await blowDb.pieces.count()) > 0 || (await blowDb.furnaces.count()) > 0
    if (!alreadyHasData && legacyVersion > 0) {
      const [furnaces, batches, pieces, steps, inspects] = await Promise.all([
        legacy.table('furnaces').toArray(),
        legacy.table('batches').toArray(),
        legacy.table('pieces').toArray(),
        legacy.table('steps').toArray(),
        legacy.table('inspects').toArray(),
      ])
      await blowDb.transaction(
        'rw',
        [blowDb.furnaces, blowDb.batches, blowDb.pieces, blowDb.steps, blowDb.inspects],
        async () => {
          await blowDb.furnaces.bulkPut(furnaces as Furnace[])
          await blowDb.batches.bulkPut(batches as GlassBatch[])
          await blowDb.pieces.bulkPut(pieces as Piece[])
          await blowDb.steps.bulkPut(steps as Step[])
          await blowDb.inspects.bulkPut(inspects as Inspect[])
        },
      )
    }
    markLegacyMigrated()
  } catch {
    // 旧库不存在（首次使用）或无法打开：无需迁移，继续走播种流程
    markLegacyMigrated()
  } finally {
    legacy.close()
  }
}

/**
 * 打开吹制侧数据库：先按归属迁移旧库数据，空库则播种演示数据。
 * 必须早于 kilnDb 的初始化完成（排产侧播种需要作品 id）。
 */
export function initBlowDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await blowDb.open()
      await migrateLegacyBlowTables()
      const empty = (await blowDb.furnaces.count()) === 0 && (await blowDb.pieces.count()) === 0
      if (empty) await seedBlowDatabase()
    })()
  }
  return initPromise
}

/* -------------------------------- 窑炉 -------------------------------- */

export async function listFurnaces(): Promise<Furnace[]> {
  const rows = await blowDb.furnaces.toArray()
  return rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
}

export async function putFurnace(row: Furnace): Promise<void> {
  await withSideRetry(async () => {
    await blowDb.furnaces.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
  }, '窑炉台账保存')
}

/** 删除窑炉：级联清理该窑下的料液批次（仅吹制侧表） */
export async function removeFurnace(id: string): Promise<void> {
  await withSideRetry(async () => {
    await blowDb.transaction('rw', blowDb.furnaces, blowDb.batches, async () => {
      await blowDb.batches.where('furnaceId').equals(id).delete()
      await blowDb.furnaces.delete(id)
    })
  }, '窑炉删除')
}

/* ------------------------------ 料液批次 ------------------------------ */

export async function listBatches(): Promise<GlassBatch[]> {
  const rows = await blowDb.batches.toArray()
  return rows.sort((a, b) => b.meltDate.localeCompare(a.meltDate))
}

export async function putBatch(row: GlassBatch): Promise<void> {
  await withSideRetry(async () => {
    await blowDb.batches.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
  }, '料液批次保存')
}

export async function removeBatch(id: string): Promise<void> {
  await withSideRetry(async () => {
    await blowDb.batches.delete(id)
  }, '料液批次删除')
}

/** 取料：按剩余量扣减（不足时扣到 0 并返回实际扣减量） */
export async function consumeBatch(batchId: string, kg: number): Promise<number> {
  return withSideRetry(async () => {
    const batch = await blowDb.batches.get(batchId)
    if (!batch) return 0
    const actual = Math.max(0, Math.min(batch.remainKg, kg))
    await blowDb.batches.update(batchId, {
      remainKg: Math.round((batch.remainKg - actual) * 10) / 10,
      updatedAt: nowIso(),
    })
    return actual
  }, '取料扣减')
}

/* -------------------------------- 作品 -------------------------------- */

export async function listPieces(): Promise<Piece[]> {
  const rows = await blowDb.pieces.toArray()
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function putPiece(row: Piece): Promise<void> {
  await withSideRetry(async () => {
    await blowDb.pieces.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
  }, '作品保存')
}

/**
 * 删除作品：只级联清理吹制侧的工序与检验记录。
 * 排产侧的退火编排归排产员所有，本侧无权删除，删除后那边显示「（作品已删除）」占位。
 */
export async function removePiece(id: string): Promise<void> {
  await withSideRetry(async () => {
    await blowDb.transaction('rw', blowDb.pieces, blowDb.steps, blowDb.inspects, async () => {
      await blowDb.steps.where('pieceId').equals(id).delete()
      await blowDb.inspects.where('pieceId').equals(id).delete()
      await blowDb.pieces.delete(id)
    })
  }, '作品删除')
}

/* -------------------------------- 工序 -------------------------------- */

export async function listSteps(): Promise<Step[]> {
  const rows = await blowDb.steps.toArray()
  return rows.sort((a, b) => a.pieceId.localeCompare(b.pieceId) || a.seq - b.seq)
}

export async function listStepsByPiece(pieceId: string): Promise<Step[]> {
  const rows = await blowDb.steps.where('pieceId').equals(pieceId).toArray()
  return rows.sort((a, b) => a.seq - b.seq)
}

export async function putStep(row: Step): Promise<void> {
  await withSideRetry(async () => {
    await blowDb.steps.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
  }, '吹制工序保存')
}

export async function removeStep(id: string): Promise<void> {
  await withSideRetry(async () => {
    await blowDb.steps.delete(id)
  }, '吹制工序删除')
}

/** 按给定 id 顺序重写工序序号（拖拽排序后调用）；只动吹制侧工序表 */
export async function reorderSteps(orderedIds: string[]): Promise<void> {
  await withSideRetry(async () => {
    await blowDb.transaction('rw', blowDb.steps, async () => {
      for (let index = 0; index < orderedIds.length; index += 1) {
        await blowDb.steps.update(orderedIds[index], { seq: index + 1, updatedAt: nowIso() })
      }
    })
  }, '工序重排')
}

/* ------------------------------ 出炉检验 ------------------------------ */

export async function listInspects(): Promise<Inspect[]> {
  const rows = await blowDb.inspects.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function listInspectsByPiece(pieceId: string): Promise<Inspect[]> {
  const rows = await blowDb.inspects.where('pieceId').equals(pieceId).toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function putInspect(row: Inspect): Promise<void> {
  await withSideRetry(async () => {
    await blowDb.inspects.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
  }, '出炉检验保存')
}

export async function removeInspect(id: string): Promise<void> {
  await withSideRetry(async () => {
    await blowDb.inspects.delete(id)
  }, '出炉检验删除')
}

/* ------------------------------ 本侧快照 / 重置 ------------------------------ */

export interface BlowSnapshot {
  name: string
  schemaVersion: number
  exportedAt: string
  furnaces: Furnace[]
  batches: GlassBatch[]
  pieces: Piece[]
  steps: Step[]
  inspects: Inspect[]
}

export async function exportBlowSnapshot(): Promise<BlowSnapshot> {
  const [furnaces, batches, pieces, steps, inspects] = await Promise.all([
    blowDb.furnaces.toArray(),
    blowDb.batches.toArray(),
    blowDb.pieces.toArray(),
    blowDb.steps.toArray(),
    blowDb.inspects.toArray(),
  ])
  return {
    name: BLOW_DB_NAME,
    schemaVersion: BLOW_DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    furnaces,
    batches,
    pieces,
    steps,
    inspects,
  }
}

export async function importBlowSnapshot(snapshot: BlowSnapshot): Promise<void> {
  await withSideRetry(async () => {
    await blowDb.transaction(
      'rw',
      [blowDb.furnaces, blowDb.batches, blowDb.pieces, blowDb.steps, blowDb.inspects],
      async () => {
        await Promise.all([
          blowDb.furnaces.clear(),
          blowDb.batches.clear(),
          blowDb.pieces.clear(),
          blowDb.steps.clear(),
          blowDb.inspects.clear(),
        ])
        await blowDb.furnaces.bulkPut(snapshot.furnaces.map((row) => ({ ...row, revision: ROW_REVISION })))
        await blowDb.batches.bulkPut(snapshot.batches.map((row) => ({ ...row, revision: ROW_REVISION })))
        await blowDb.pieces.bulkPut(snapshot.pieces.map((row) => ({ ...row, revision: ROW_REVISION })))
        await blowDb.steps.bulkPut(snapshot.steps.map((row) => ({ ...row, revision: ROW_REVISION })))
        await blowDb.inspects.bulkPut(snapshot.inspects.map((row) => ({ ...row, revision: ROW_REVISION })))
      },
    )
  }, '吹制侧存档导入')
}

export async function resetBlowDatabase(): Promise<void> {
  await withSideRetry(async () => {
    await blowDb.transaction(
      'rw',
      [blowDb.furnaces, blowDb.batches, blowDb.pieces, blowDb.steps, blowDb.inspects],
      async () => {
        await Promise.all([
          blowDb.furnaces.clear(),
          blowDb.batches.clear(),
          blowDb.pieces.clear(),
          blowDb.steps.clear(),
          blowDb.inspects.clear(),
        ])
      },
    )
  }, '吹制侧重置')
  await seedBlowDatabase()
}

export async function countBlow(): Promise<Record<string, number>> {
  const [furnaces, batches, pieces, steps, inspects] = await Promise.all([
    blowDb.furnaces.count(),
    blowDb.batches.count(),
    blowDb.pieces.count(),
    blowDb.steps.count(),
    blowDb.inspects.count(),
  ])
  return { furnaces, batches, pieces, steps, inspects }
}
