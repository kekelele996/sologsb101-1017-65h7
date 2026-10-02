/**
 * 窑务排产侧本地库（Dexie）：库名 gbglassblow-kiln
 *
 * 归属窑务排产员：仅退火窑位编排（窑位、入窑时间、曲线段、出炉时间、状态）。
 * 吹制组对本库只有只读订阅（通过同一个 Dexie 实例读取，页面层无写入入口）。
 *
 * 同时维护一条指向吹制库 gbglassblow-blow 的只读连接，供排产员查看：
 * - 作品的壁厚（决定退火时长）；
 * - 逐道工序的完成情况（前序未完成时明确卡在哪一件、哪一道）；
 * - 退火窑台账（窑位池来自吹制侧窑炉表）。
 *
 * 结构版本：v1 —— 两库拆分后的首个结构。
 */
import Dexie, { type Table } from 'dexie'
import type { Anneal } from '../types/anneal'
import type { Furnace } from '../types/furnace'
import type { Piece } from '../types/piece'
import type { Step } from '../types/step'
import { BLOW_DB_NAME, BLOW_DB_SCHEMA_VERSION, LEGACY_DB_NAME } from './blowDb'
import { ROW_REVISION, withSideRetry } from './ownership'
import { nowIso } from './id'
import { seedKilnDatabase } from './seedKiln'

/** 排产侧数据库名 */
export const KILN_DB_NAME = 'gbglassblow-kiln'

/** 排产侧数据结构版本号 */
export const KILN_DB_SCHEMA_VERSION = 1

class KilnDatabase extends Dexie {
  anneals!: Table<Anneal, string>

  constructor() {
    super(KILN_DB_NAME)
    this.version(KILN_DB_SCHEMA_VERSION).stores({
      anneals: 'id, pieceId, kilnSlot, state, inAt, curveSeg',
    })
  }
}

/**
 * 吹制库的只读连接。
 * Dexie 连接本身不设权限位，这里通过单独实例 + 仅导出查询函数来约束用法；
 * 所有写操作统一走 blowDb.ts，排产侧代码拿不到吹侧表的 put/update/delete 封装。
 */
class BlowReadonlyDatabase extends Dexie {
  furnaces!: Table<Furnace, string>
  pieces!: Table<Piece, string>
  steps!: Table<Step, string>

  constructor() {
    super(BLOW_DB_NAME)
    this.version(BLOW_DB_SCHEMA_VERSION).stores({
      furnaces: 'id, code, type, state, fuelType, createdAt, updatedAt',
      pieces: 'id, batchId, state, artist, craft, name',
      steps: 'id, pieceId, [pieceId+seq], seq, state, name',
    })
  }
}

export const kilnDb = new KilnDatabase()
export const blowReadonlyDb = new BlowReadonlyDatabase()

/* ------------------------------ 初始化 / 迁移 / 播种 ------------------------------ */

const MIGRATION_FLAG_KEY = 'gbglassblow:legacyAnnealsMigratedToV3'

let initPromise: Promise<void> | null = null

function isLegacyAnnealsMigrated(): boolean {
  try {
    return window.localStorage.getItem(MIGRATION_FLAG_KEY) === 'done'
  } catch {
    return false
  }
}

function markLegacyAnnealsMigrated(): void {
  try {
    window.localStorage.setItem(MIGRATION_FLAG_KEY, 'done')
  } catch {
    /* 隐私模式下降级：initPromise 保证本次会话只执行一次 */
  }
}

/**
 * 一次性把旧共用库 gbglassblow 中的退火编排搬到排产库。
 * 旧库保持原样不删除；吹制侧先完成迁移与播种，因此这里只搬 anneals 一张表。
 */
async function migrateLegacyAnneals(): Promise<void> {
  if (isLegacyAnnealsMigrated()) return
  const legacy = new Dexie(LEGACY_DB_NAME)
  try {
    legacy.version(2).stores({
      furnaces: 'id, code, type, state, fuelType, createdAt, updatedAt',
      batches: 'id, furnaceId, colorCode, meltDate, remainKg',
      pieces: 'id, batchId, state, artist, craft, name',
      steps: 'id, pieceId, [pieceId+seq], seq, state, name',
      anneals: 'id, pieceId, kilnSlot, state, inAt, curveSeg',
      inspects: 'id, pieceId, date, result, inspector',
    })
    await legacy.open()
    const alreadyHasData = (await kilnDb.anneals.count()) > 0
    if (!alreadyHasData) {
      const anneals = await legacy.table('anneals').toArray()
      if (anneals.length > 0) {
        await kilnDb.anneals.bulkPut(anneals as Anneal[])
      }
    }
    markLegacyAnnealsMigrated()
  } catch {
    // 旧库不存在（全新环境）：忽略，下方播种会补齐演示数据
    markLegacyAnnealsMigrated()
  } finally {
    legacy.close()
  }
}

/**
 * 打开排产侧数据库与吹制侧只读连接。
 * 必须先 await initBlowDatabase()（吹侧迁移与播种先行，退火记录引用的作品 id 才存在）。
 */
export async function initKilnDatabase(blowReady: Promise<void>): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await blowReady
      await Promise.all([kilnDb.open(), blowReadonlyDb.open()])
      await migrateLegacyAnneals()
      if ((await kilnDb.anneals.count()) === 0) {
        await seedKilnDatabase()
      }
    })()
  }
  return initPromise
}

/* --------------------------- 吹制库只读查询（跨库） --------------------------- */

/** 只读：全部作品（排产员需要名称 / 工艺 / 壁厚来编排曲线） */
export async function readPieces(): Promise<Piece[]> {
  return blowReadonlyDb.pieces.toArray()
}

/** 只读：全部工序（用于前序完成度判定与卡点展示） */
export async function readSteps(): Promise<Step[]> {
  return blowReadonlyDb.steps.toArray()
}

/** 只读：退火窑台账（窑位池） */
export async function readAnnealFurnaces(): Promise<Furnace[]> {
  const rows = await blowReadonlyDb.furnaces.toArray()
  return rows.filter((row) => row.type === '退火窑')
}

/* -------------------------------- 退火（本侧写入） -------------------------------- */

export async function listAnneals(): Promise<Anneal[]> {
  const rows = await kilnDb.anneals.toArray()
  return rows.sort((a, b) => a.inAt.localeCompare(b.inAt))
}

export async function listAnnealsByPiece(pieceId: string): Promise<Anneal[]> {
  return kilnDb.anneals.where('pieceId').equals(pieceId).toArray()
}

export async function putAnneal(row: Anneal): Promise<void> {
  await withSideRetry(async () => {
    await kilnDb.anneals.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
  }, '窑位编排保存')
}

export async function removeAnneal(id: string): Promise<void> {
  await withSideRetry(async () => {
    await kilnDb.anneals.delete(id)
  }, '窑位编排删除')
}

/** 推进退火状态；「已出炉」时写回出炉时间。作品状态由吹侧跨库只读派生，本侧不回写作品。 */
export async function advanceAnnealState(annealId: string, next: Anneal['state'], outAt: string): Promise<void> {
  await withSideRetry(async () => {
    const row = await kilnDb.anneals.get(annealId)
    if (!row) return
    await kilnDb.anneals.update(annealId, {
      state: next,
      outAt: next === '已出炉' ? outAt : row.outAt,
      updatedAt: nowIso(),
    })
  }, '退火状态推进')
}

/* ------------------------------ 本侧快照 / 重置 ------------------------------ */

export interface KilnSnapshot {
  name: string
  schemaVersion: number
  exportedAt: string
  anneals: Anneal[]
}

export async function exportKilnSnapshot(): Promise<KilnSnapshot> {
  const anneals = await kilnDb.anneals.toArray()
  return { name: KILN_DB_NAME, schemaVersion: KILN_DB_SCHEMA_VERSION, exportedAt: nowIso(), anneals }
}

export async function importKilnSnapshot(snapshot: KilnSnapshot): Promise<void> {
  await withSideRetry(async () => {
    await kilnDb.transaction('rw', kilnDb.anneals, async () => {
      await kilnDb.anneals.clear()
      await kilnDb.anneals.bulkPut(snapshot.anneals.map((row) => ({ ...row, revision: ROW_REVISION })))
    })
  }, '排产侧存档导入')
}

export async function resetKilnDatabase(): Promise<void> {
  await withSideRetry(async () => {
    await kilnDb.anneals.clear()
  }, '排产侧重置')
  await seedKilnDatabase()
}

export async function countKiln(): Promise<Record<string, number>> {
  const anneals = await kilnDb.anneals.count()
  return { anneals }
}
