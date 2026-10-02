/**
 * 导出工具：吹侧 / 排侧各自的 JSON 存档、窑务排产 CSV、工序卡片文本
 * 全部在浏览器本地完成，不经过任何服务端。
 *
 * 两库拆分后存档也按归属分开：吹侧存档只含吹制数据，排侧存档只含退火编排，
 * 任一侧导入都不会覆盖另一侧已确认的数据。
 */
import type { BlowSnapshot } from './blowDb'
import type { KilnSnapshot } from './kilnDb'
import { BLOW_DB_NAME, BLOW_DB_SCHEMA_VERSION } from './blowDb'
import { KILN_DB_NAME, KILN_DB_SCHEMA_VERSION } from './kilnDb'
import type { Furnace } from '../types/furnace'
import type { GlassBatch } from '../types/batch'
import type { Piece } from '../types/piece'
import type { Step } from '../types/step'
import type { Anneal } from '../types/anneal'
import type { Inspect } from '../types/inspect'
import { stampSuffix } from './id'
import { formatHours, isLowRemain, segmentHours, totalAnnealHours } from './thermal'

/** 联合存档（仅用于导出文件下载与展示；两侧各自独立导入） */
export type SideSnapshot = BlowSnapshot | KilnSnapshot

/** 触发浏览器下载 */
export function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

/** CSV 单元格转义 */
export function csvCell(value: string | number): string {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** 导出吹侧 JSON 存档，返回文件名 */
export function exportBlowSnapshotJson(snapshot: BlowSnapshot): string {
  const filename = `${BLOW_DB_NAME}-backup-${stampSuffix()}.json`
  download(filename, JSON.stringify(snapshot, null, 2), 'application/json;charset=utf-8')
  return filename
}

/** 导出排产侧 JSON 存档，返回文件名 */
export function exportKilnSnapshotJson(snapshot: KilnSnapshot): string {
  const filename = `${KILN_DB_NAME}-backup-${stampSuffix()}.json`
  download(filename, JSON.stringify(snapshot, null, 2), 'application/json;charset=utf-8')
  return filename
}

export interface SnapshotParseResult {
  ok: boolean
  message: string
  /** 归属侧：blow / kiln；无法识别为 null */
  side: 'blow' | 'kiln' | null
  snapshot: SideSnapshot | null
}

/** 解析并校验导入的 JSON 存档（按 name 字段判定归属侧） */
export function parseSnapshot(text: string): SnapshotParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, message: 'JSON 解析失败，请确认文件内容完整。', side: null, snapshot: null }
  }
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, message: '存档格式不正确：顶层必须是对象。', side: null, snapshot: null }
  }
  const data = raw as Record<string, unknown>

  // 兼容旧版整库存档（name = gbglassblow）：提示用户先在旧版本迁移
  if (data.name === 'gbglassblow') {
    return {
      ok: false,
      message:
        '这是拆库前的旧版整库存档（gbglassblow）。当前版本会在首次打开时自动把旧库数据按归属迁移到两本库；如需恢复旧档，请先用旧版本导入后再升级。',
      side: null,
      snapshot: null,
    }
  }

  if (data.name === BLOW_DB_NAME) {
    if (typeof data.schemaVersion !== 'number' || data.schemaVersion > BLOW_DB_SCHEMA_VERSION) {
      return {
        ok: false,
        message: `吹侧存档数据结构版本不兼容：当前支持 ≤ v${BLOW_DB_SCHEMA_VERSION}，实际为 v${String(data.schemaVersion)}。`,
        side: null,
        snapshot: null,
      }
    }
    const keys: Array<keyof BlowSnapshot> = ['furnaces', 'batches', 'pieces', 'steps', 'inspects']
    for (const key of keys) {
      if (!Array.isArray(data[key])) {
        return { ok: false, message: `吹侧存档缺少 ${String(key)} 数组。`, side: null, snapshot: null }
      }
    }
    return { ok: true, side: 'blow', message: '吹侧存档校验通过：导入将只覆盖吹制组自己的数据，不影响排产侧窑位编排。', snapshot: data as unknown as BlowSnapshot }
  }

  if (data.name === KILN_DB_NAME) {
    if (typeof data.schemaVersion !== 'number' || data.schemaVersion > KILN_DB_SCHEMA_VERSION) {
      return {
        ok: false,
        message: `排侧存档数据结构版本不兼容：当前支持 ≤ v${KILN_DB_SCHEMA_VERSION}，实际为 v${String(data.schemaVersion)}。`,
        side: null,
        snapshot: null,
      }
    }
    if (!Array.isArray(data.anneals)) {
      return { ok: false, message: '排侧存档缺少 anneals 数组。', side: null, snapshot: null }
    }
    return { ok: true, side: 'kiln', message: '排侧存档校验通过：导入将只覆盖窑位编排，不影响吹制组的工序数据。', snapshot: data as unknown as KilnSnapshot }
  }

  return {
    ok: false,
    message: `存档不属于本项目：期望 name = ${BLOW_DB_NAME} 或 ${KILN_DB_NAME}，实际为 ${String(data.name)}。`,
    side: null,
    snapshot: null,
  }
}

/** 生成窑务排产汇总 CSV（一件作品一行） */
export function buildScheduleCsv(
  furnaces: Furnace[],
  batches: GlassBatch[],
  pieces: Piece[],
  steps: Step[],
  anneals: Anneal[],
  inspects: Inspect[],
  /** 由调用方（读取层）传入的跨库派生状态 */
  stateOf: (pieceId: string) => string,
): string {
  const header = [
    '作品名',
    '工艺',
    '创作者',
    '状态',
    '设计高度(mm)',
    '壁厚(mm)',
    '料液色号',
    '所属窑炉',
    '工序数',
    '已完成工序',
    '累计工时(分钟)',
    '退火记录数',
    '退火窑位',
    '退火状态',
    '理论退火时长',
    '检验次数',
    '最近检验结果',
  ]
  const lines: string[] = [header.map(csvCell).join(',')]
  pieces.forEach((piece) => {
    const batch = batches.find((row) => row.id === piece.batchId)
    const furnace = furnaces.find((row) => row.id === batch?.furnaceId)
    const pieceSteps = steps.filter((row) => row.pieceId === piece.id).sort((a, b) => a.seq - b.seq)
    const pieceAnneals = anneals.filter((row) => row.pieceId === piece.id)
    const latestAnneal = pieceAnneals.length > 0 ? pieceAnneals[pieceAnneals.length - 1] : null
    const pieceInspects = inspects.filter((row) => row.pieceId === piece.id).sort((a, b) => a.date.localeCompare(b.date))
    const latestInspect = pieceInspects.length > 0 ? pieceInspects[pieceInspects.length - 1] : null
    lines.push(
      [
        piece.name,
        piece.craft,
        piece.artist,
        stateOf(piece.id),
        piece.designHeightMm,
        piece.wallThicknessMm,
        batch?.colorCode ?? '—',
        furnace?.code ?? '—',
        pieceSteps.length,
        pieceSteps.filter((row) => row.state === '已完成').length,
        Math.round(pieceSteps.reduce((acc, row) => acc + row.durationMin, 0) * 10) / 10,
        pieceAnneals.length,
        latestAnneal?.kilnSlot ?? '—',
        latestAnneal?.state ?? '—',
        formatHours(totalAnnealHours(piece.wallThicknessMm)),
        pieceInspects.length,
        latestInspect?.result ?? '—',
      ]
        .map(csvCell)
        .join(','),
    )
  })
  return `${'﻿'}${lines.join('\n')}`
}

/** 导出窑务排产汇总 CSV 文件 */
export function exportScheduleCsvFile(
  furnaces: Furnace[],
  batches: GlassBatch[],
  pieces: Piece[],
  steps: Step[],
  anneals: Anneal[],
  inspects: Inspect[],
  stateOf: (pieceId: string) => string,
): string {
  const filename = `玻璃窑务排产汇总-${stampSuffix()}.csv`
  download(filename, buildScheduleCsv(furnaces, batches, pieces, steps, anneals, inspects, stateOf), 'text/csv;charset=utf-8')
  return filename
}

/** 复制文本到剪贴板 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    return false
  }
  return false
}

/** 生成某件作品的工序卡片纯文本 */
export function buildStepCardText(
  piece: Piece,
  batch: GlassBatch | undefined,
  furnace: Furnace | undefined,
  steps: Step[],
  anneals: Anneal[],
  /** 跨库派生状态；未传时退回作品登记阶段 */
  derivedState?: string,
): string {
  const lines: string[] = []
  lines.push(`【工序卡片】${piece.name}（${piece.craft} · ${piece.artist} · ${derivedState ?? piece.state}）`)
  lines.push(`设计尺寸：高 ${piece.designHeightMm} mm / 壁厚 ${piece.wallThicknessMm} mm`)
  lines.push(`料液：${batch === undefined ? '未关联' : `${batch.colorCode}（${batch.recipe}）`} · 窑炉 ${furnace?.code ?? '—'}`)
  lines.push(
    `理论退火时长：${formatHours(totalAnnealHours(piece.wallThicknessMm))}（升温 ${formatHours(
      segmentHours('升温', piece.wallThicknessMm),
    )} / 保温 ${formatHours(segmentHours('保温', piece.wallThicknessMm))} / 缓冷 ${formatHours(
      segmentHours('缓冷', piece.wallThicknessMm),
    )}）`,
  )
  lines.push('工序：')
  steps
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .forEach((row) => {
      lines.push(
        `  ${row.seq}. ${row.name} · ${row.tempC} ℃ · ${row.durationMin} 分钟 · ${row.operator} · ${
          row.state
        }${row.remark === '' ? '' : ` · ${row.remark}`}`,
      )
    })
  if (anneals.length > 0) {
    lines.push('退火（只读，归排产侧维护）：')
    anneals.forEach((row) => {
      lines.push(`  ${row.kilnSlot} · ${row.curveSeg} · ${row.inAt} → ${row.outAt || '未出炉'} · ${row.state}`)
    })
  }
  return lines.join('\n')
}

/** 生成补料提醒纯文本 */
export function buildRefillText(batches: GlassBatch[], furnaces: Furnace[]): string {
  const low = batches.filter((row) => isLowRemain(row.remainKg))
  if (low.length === 0) return '当前所有料液批次剩余量均在阈值以上，无需补料。'
  const lines: string[] = [`【补料提醒】以下 ${low.length} 个料液批次剩余量偏低：`]
  low.forEach((row) => {
    const furnace = furnaces.find((item) => item.id === row.furnaceId)
    lines.push(`· ${row.colorCode}（${furnace?.code ?? '未知窑炉'}）剩余 ${row.remainKg} kg —— ${row.recipe}`)
  })
  return lines.join('\n')
}
