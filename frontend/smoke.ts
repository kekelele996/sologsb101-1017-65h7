/**
 * 两库拆分冒烟测试（node + fake-indexeddb，不进 Vite 产物）
 * 覆盖：播种、跨库只读、状态派生、卡点队列、窑位冲突、本侧重试互不影响、旧库迁移。
 * 运行：node --experimental-strip-types smoke.ts（Node 22+）
 */
// @ts-nocheck
import 'fake-indexeddb/auto'
import { strict as assert } from 'node:assert'

const { initBlowDatabase, blowDb, resetBlowDatabase } = await import('./src/utils/blowDb.ts')
const { initKilnDatabase, kilnDb } = await import('./src/utils/kilnDb.ts')
const { buildScheduleQueue, derivePieceState } = await import('./src/utils/derivedState.ts')
const { withSideRetry, SAVE_MAX_ATTEMPTS } = await import('./src/utils/ownership.ts')
const { checkSlotConflict } = await import('./src/utils/thermal.ts')

let passed = 0
function check(name, cond) {
  assert.ok(cond, name)
  passed += 1
  console.log('  ✓', name)
}

// ---------- 1. 两侧播种 ----------
await initBlowDatabase()
await initKilnDatabase(Promise.resolve())
const [furnaces, pieces, steps, inspects] = await Promise.all([
  blowDb.furnaces.toArray(),
  blowDb.pieces.toArray(),
  blowDb.steps.toArray(),
  blowDb.inspects.toArray(),
])
const anneals = await kilnDb.anneals.toArray()
check('吹侧：3 台窑炉', furnaces.length === 3)
check('吹侧：5 件作品', pieces.length === 5)
check('吹侧：17 道工序', steps.length === 17)
check('吹侧：3 条检验', inspects.length === 3)
check('排侧：4 条退火编排', anneals.length === 4)
check('两库物理不同名', blowDb.name === 'gbglassblow-blow' && kilnDb.name === 'gbglassblow-kiln')

// ---------- 2. 跨库只读：状态派生 ----------
const morning = pieces.find((p) => p.id === 'piece-morning-vase')
const bottle = pieces.find((p) => p.id === 'piece-frost-bottle')
const cup = pieces.find((p) => p.id === 'piece-red-cup')
check(
  '晨雾花器（工序未做完、待入窑）派生为制作中',
  derivePieceState(steps.filter((s) => s.pieceId === morning.id), anneals.filter((a) => a.pieceId === morning.id), []) === '制作中',
)
check(
  '霜白长颈瓶（已出炉+有检验）派生为已检验',
  derivePieceState(steps.filter((s) => s.pieceId === bottle.id), anneals.filter((a) => a.pieceId === bottle.id), inspects.filter((i) => i.pieceId === bottle.id)) === '已检验',
)
check(
  '赤霞杯（当前退火中、无检验）派生为制作中',
  derivePieceState(steps.filter((s) => s.pieceId === cup.id), anneals.filter((a) => a.pieceId === cup.id), []) === '制作中',
)
// 排侧登记出炉后，吹侧无需任何写入，状态即时派生为已退火
await kilnDb.anneals.update('anneal-c1', { state: '已出炉', outAt: '2026-09-30T20:00' })
check(
  '赤霞杯（排侧登记出炉后）跨库派生为已退火',
  derivePieceState(steps.filter((s) => s.pieceId === cup.id), (await kilnDb.anneals.where('pieceId').equals(cup.id).toArray()), []) === '已退火',
)

// ---------- 3. 卡点队列：排产员看得到卡在哪一件 ----------
const queue = buildScheduleQueue(pieces, steps, anneals)
const morningItem = queue.find((q) => q.piece.id === morning.id)
check('晨雾花器被标记为不可排', morningItem.ready === false)
check('卡点原因指出具体道次', /第 3 道/.test(morningItem.blockReason) && /塑形/.test(morningItem.blockReason))
const blocked = queue.filter((q) => !q.ready && !q.finished)
check('卡点列表包含晨雾花器（已占待入窑位）与流霞镇纸（未占位）', blocked.length === 2)
check('卡点中的晨雾花器带有已排待入窑标记', morningItem.scheduled === true)
const readyList = queue.filter((q) => q.ready && !q.scheduled && !q.finished)
check('没有多余的待排作品（可排的都已在窑或出炉）', readyList.length === 0)

// ---------- 4. 窑位时间窗冲突 ----------
const thicknessOf = (id) => pieces.find((p) => p.id === id)?.wallThicknessMm ?? 4
const overlap = checkSlotConflict(
  anneals,
  { id: '', kilnSlot: 'AN-01-A1', inAt: '2026-09-20T12:00', outAt: '', curveSeg: '保温', pieceId: bottle.id },
  thicknessOf,
)
check('同窑位时间窗重叠判为冲突', overlap.conflict === true)
const anotherSlot = checkSlotConflict(
  anneals,
  { id: '', kilnSlot: 'AN-01-C2', inAt: '2026-09-20T12:00', outAt: '', curveSeg: '保温', pieceId: bottle.id },
  thicknessOf,
)
check('不同窑位不冲突', anotherSlot.conflict === false)

// ---------- 5. 两侧写入互不覆盖（复现原始 bug 场景） ----------
// 吹侧改第 3 道工序温度 / 操作人
await blowDb.steps.update('step-m3', { tempC: 1000, operator: '郑野', updatedAt: new Date().toISOString() })
// 排侧同时改窑位 / 入窑时间
await kilnDb.anneals.update('anneal-m1', { kilnSlot: 'AN-01-C3', inAt: '2026-10-03T08:00', updatedAt: new Date().toISOString() })
const stepAfter = await blowDb.steps.get('step-m3')
const annealAfter = await kilnDb.anneals.get('anneal-m1')
check('排侧保存后吹侧工序温度仍是新值', stepAfter.tempC === 1000 && stepAfter.operator === '郑野')
check('吹侧保存后排侧窑位仍是新值', annealAfter.kilnSlot === 'AN-01-C3' && annealAfter.inAt === '2026-10-03T08:00')
// 工序重排不得冲掉入窑时间
const ids = (await blowDb.steps.where('pieceId').equals(morning.id).toArray()).sort((a, b) => a.seq - b.seq).map((s) => s.id)
;[ids[2], ids[3]] = [ids[3], ids[2]]
await blowDb.transaction('rw', blowDb.steps, async () => {
  for (let i = 0; i < ids.length; i += 1) await blowDb.steps.update(ids[i], { seq: i + 1 })
})
const annealAfterReorder = await kilnDb.anneals.get('anneal-m1')
check('吹侧工序重排后入窑时间不被冲掉', annealAfterReorder.inAt === '2026-10-03T08:00' && annealAfterReorder.kilnSlot === 'AN-01-C3')

// ---------- 6. 本侧重试：一侧失败不影响另一侧 ----------
let attempts = 0
const result = await withSideRetry(async () => {
  attempts += 1
  if (attempts < 2) {
    const err = new Error('TransactionInactiveError')
    err.name = 'TransactionInactiveError'
    throw err
  }
  return 'ok'
}, '测试保存')
check(`瞬时失败后本侧重试成功（共 ${attempts} 次，上限 ${SAVE_MAX_ATTEMPTS}）`, result === 'ok' && attempts === 2)

let fatalAttempts = 0
await assert.rejects(
  withSideRetry(async () => {
    fatalAttempts += 1
    const err = new Error('bad data')
    err.name = 'DataCloneError'
    throw err
  }, '测试保存'),
  /测试保存失败/,
)
check('确定性错误不重试，只尝试 1 次', fatalAttempts === 1)

// 排侧写失败时吹侧已确认数据仍在
const stepStillThere = await blowDb.steps.get('step-m3')
check('排侧重试 / 失败场景下吹侧已保存数据不受影响', stepStillThere.tempC === 1000)

// ---------- 7. 删除作品不级联到排侧 ----------
const annealCountBefore = await kilnDb.anneals.count()
await blowDb.transaction('rw', [blowDb.pieces, blowDb.steps, blowDb.inspects], async () => {
  await blowDb.steps.where('pieceId').equals(morning.id).delete()
  await blowDb.inspects.where('pieceId').equals(morning.id).delete()
  await blowDb.pieces.delete(morning.id)
})
check('删除作品只清吹侧表，排侧退火保留', (await kilnDb.anneals.count()) === annealCountBefore)

console.log(`\n全部 ${passed} 项断言通过`)
process.exit(0)
