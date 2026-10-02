/**
 * 旧共用库迁移测试：模拟 v2 时代的 gbglassblow 库，首次打开时按归属拆到两本库。
 */
// @ts-nocheck
import 'fake-indexeddb/auto'
import { strict as assert } from 'node:assert'
import Dexie from 'dexie'

const OLD_TIME = '2026-08-01T00:00:00.000Z'

// 1) 造一个旧版共用库（结构 v2，含全部六张表的用户数据）
const legacy = new Dexie('gbglassblow')
legacy.version(2).stores({
  furnaces: 'id, code, type, state, fuelType, createdAt, updatedAt',
  batches: 'id, furnaceId, colorCode, meltDate, remainKg',
  pieces: 'id, batchId, state, artist, craft, name',
  steps: 'id, pieceId, [pieceId+seq], seq, state, name',
  anneals: 'id, pieceId, kilnSlot, state, inAt, curveSeg',
  inspects: 'id, pieceId, date, result, inspector',
})
await legacy.table('furnaces').bulkPut([
  { id: 'f1', code: 'AN-09', type: '退火窑', maxTempC: 600, fuelType: '电', state: '运行', createdAt: OLD_TIME, updatedAt: OLD_TIME, revision: 2 },
])
await legacy.table('pieces').bulkPut([
  { id: 'p1', name: '旧库迁移瓶', batchId: '', designHeightMm: 200, wallThicknessMm: 4, craft: '吹制', artist: '旧人', state: '制作中', createdAt: OLD_TIME, updatedAt: OLD_TIME, revision: 2 },
])
await legacy.table('steps').bulkPut([
  { id: 's1', pieceId: 'p1', seq: 1, name: '取料', tempC: 1100, durationMin: 5, operator: '旧人', remark: '', state: '已完成', createdAt: OLD_TIME, updatedAt: OLD_TIME, revision: 2 },
])
await legacy.table('anneals').bulkPut([
  { id: 'a1', pieceId: 'p1', kilnSlot: 'AN-09-A1', curveSeg: '缓冷', inAt: '2026-08-02T08:00', outAt: '', state: '待入窑', createdAt: OLD_TIME, updatedAt: OLD_TIME, revision: 2 },
])
legacy.close()

// 2) 首次打开应用：吹侧先迁移，排侧随后迁移
const { initBlowDatabase, blowDb } = await import('./src/utils/blowDb.ts')
const { initKilnDatabase, kilnDb } = await import('./src/utils/kilnDb.ts')

await initBlowDatabase()
await initKilnDatabase(Promise.resolve())

const [fCount, pCount] = await Promise.all([blowDb.furnaces.count(), blowDb.pieces.count()])
const sCount = await blowDb.steps.count()
const aCount = await kilnDb.anneals.count()
const seededPiece = await blowDb.pieces.get('piece-morning-vase')
const migratedPiece = await blowDb.pieces.get('p1')
const migratedAnneal = await kilnDb.anneals.get('a1')

assert.equal(fCount, 1, '吹侧没有窑炉以外的演示窑炉（迁移数据存在时不播种）')
assert.equal(pCount, 1, '吹侧只有旧库 1 件作品（不播种）')
assert.equal(sCount, 1, '吹侧只有旧库 1 道工序')
assert.equal(aCount, 1, '排侧只有旧库 1 条退火（不播种）')
assert.equal(seededPiece, undefined, '迁移发生时不灌入演示作品')
assert.equal(migratedPiece.name, '旧库迁移瓶')
assert.equal(migratedPiece.craft, '吹制')
assert.equal(migratedAnneal.kilnSlot, 'AN-09-A1')
assert.equal(migratedAnneal.inAt, '2026-08-02T08:00')

// 3) 旧库仍然保留未被清理
const legacyCheck = new Dexie('gbglassblow')
legacyCheck.version(2).stores({
  furnaces: 'id', batches: 'id', pieces: 'id', steps: 'id', anneals: 'id', inspects: 'id',
})
await legacyCheck.open()
assert.equal(await legacyCheck.table('pieces').count(), 1, '旧库保留作回滚兜底')
legacyCheck.close()

console.log('✓ 旧共用库按归属迁移：吹侧归吹侧、排侧归排侧，旧库保留，空库才播种')
process.exit(0)
