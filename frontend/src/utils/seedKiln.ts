/**
 * 排产侧演示数据播种（幂等）
 * 只播种退火窑位编排；作品 / 工序由吹制侧库提供（固定 id 直接引用）。
 * 必须在吹制侧播种完成之后执行（见 kilnDb.initKilnDatabase）。
 */
import { kilnDb } from './kilnDb'
import { ROW_REVISION } from './ownership'
import type { Anneal } from '../types/anneal'
import { SEED_IDS } from './seedBlow'

const SEED_TIME = '2026-09-01T02:00:00.000Z'

function wrap(row: Omit<Anneal, 'createdAt' | 'updatedAt' | 'revision'>): Anneal {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION }
}

export async function seedKilnDatabase(): Promise<void> {
  const exists = await kilnDb.anneals.count()
  if (exists > 0) return

  // 4 条退火记录，窑位 A1/A2/A3/B1 互不冲突，覆盖已出炉 / 退火中 / 待入窑：
  // - 晨雾花器工序未做完，仍排在待入窑（用于演示排产页的前序卡点）
  const anneals: Anneal[] = [
    wrap({ id: 'anneal-g1', pieceId: SEED_IDS.pieceGreen, kilnSlot: 'AN-01-A1', curveSeg: '缓冷', inAt: '2026-09-20T09:00', outAt: '2026-09-21T09:00', state: '已出炉' }),
    wrap({ id: 'anneal-b1', pieceId: SEED_IDS.pieceBottle, kilnSlot: 'AN-01-A2', curveSeg: '缓冷', inAt: '2026-09-26T08:00', outAt: '2026-09-27T08:00', state: '已出炉' }),
    wrap({ id: 'anneal-c1', pieceId: SEED_IDS.pieceCup, kilnSlot: 'AN-01-A3', curveSeg: '升温', inAt: '2026-09-29T14:00', outAt: '', state: '退火中' }),
    wrap({ id: 'anneal-m1', pieceId: SEED_IDS.pieceMorning, kilnSlot: 'AN-01-B1', curveSeg: '保温', inAt: '2026-10-02T10:00', outAt: '', state: '待入窑' }),
  ]

  await kilnDb.anneals.bulkPut(anneals)
}
