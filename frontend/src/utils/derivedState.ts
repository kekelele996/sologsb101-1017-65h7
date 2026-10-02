/**
 * 跨库只读派生模型
 *
 * 吹制库（工序、检验）与排产库（退火）物理分离后，作品全流程状态不能再由
 * 某一侧回写对方的表，改为在读取层把两侧数据拼起来即时派生：
 *
 *   有检验记录 → 已检验；有已出炉退火 → 已退火；有工序 → 制作中；否则设计中
 *
 * 任一侧保存都不会触碰另一侧的数据，派生结果随 liveQuery 自动刷新。
 */
import type { Piece, PieceState } from '../types/piece'
import type { Step } from '../types/step'
import type { Anneal } from '../types/anneal'
import type { Inspect } from '../types/inspect'
import { buildStepProgress, type StepProgress } from '../hooks/useStepProgress'

/**
 * 由两侧数据派生单件作品的全流程状态（纯函数）。
 */
export function derivePieceState(steps: Step[], anneals: Anneal[], inspects: Inspect[]): PieceState {
  if (inspects.length > 0) return '已检验'
  if (anneals.some((row) => row.state === '已出炉')) return '已退火'
  if (steps.length > 0) return '制作中'
  return '设计中'
}

/** 一件作品是否已有未完结（待入窑 / 退火中）的窑位编排 */
export function hasActiveAnneal(anneals: Anneal[]): boolean {
  return anneals.some((row) => row.state !== '已出炉')
}

/** 排产队列中的单件作品视图：工序进度 + 是否可排 + 卡点原因 */
export interface ScheduleQueueItem {
  piece: Piece
  progress: StepProgress
  /** 工序全部完成，可以排入窑位 */
  ready: boolean
  /** 不可排时的人读原因：卡在哪一道（可排时为空串） */
  blockReason: string
  /** 已有未出炉编排（待入窑 / 退火中） */
  scheduled: boolean
  /** 已完成且已有已出炉记录（走完全流程） */
  finished: boolean
}

/**
 * 由两侧只读数据构建排产队列：
 * - ready：前序工序全部「已完成」，等待排产员安排窑位 / 入窑时间 / 曲线段；
 * - blocked：前序未做完，明确给出卡住的道次与名称，排产员一眼看到卡在哪一件；
 *   已经提前占了「待入窑」窑位但工序仍未完成的件同样属于卡点（需要催办或调整入窑时间）；
 * - scheduled：工序完成且在窑；finished：已出炉。
 */
export function buildScheduleQueue(
  pieces: Piece[],
  steps: Step[],
  anneals: Anneal[],
): ScheduleQueueItem[] {
  return pieces
    .map((piece) => {
      const pieceSteps = steps.filter((row) => row.pieceId === piece.id)
      const pieceAnneals = anneals.filter((row) => row.pieceId === piece.id)
      const progress = buildStepProgress(piece.id, pieceSteps)
      const scheduled = hasActiveAnneal(pieceAnneals)
      const finished = !scheduled && pieceAnneals.some((row) => row.state === '已出炉')
      return {
        piece,
        progress,
        ready: progress.allDone,
        blockReason: progress.allDone ? '' : progress.blockReason,
        scheduled,
        finished,
      }
    })
    .sort((a, b) => {
      // 待排（工序完成、未占窑）→ 前序卡点（含已占待入窑位但工序未完成）→ 在窑 → 已出炉
      const rank = (item: ScheduleQueueItem): number => {
        if (item.ready && !item.scheduled && !item.finished) return 0
        if (!item.ready && !item.finished) return 1
        if (item.scheduled) return 2
        return 3
      }
      const diff = rank(a) - rank(b)
      if (diff !== 0) return diff
      return a.piece.updatedAt.localeCompare(b.piece.updatedAt)
    })
}
