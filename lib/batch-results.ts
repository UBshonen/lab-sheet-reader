import ExcelJS from 'exceljs'
import { buildNetworkRows, createNetworkWorkbook, type NamedReadResult } from './network-results.js'
import type { ReadResult, ReadRow } from './reader/index.js'

export type SampleKind = 'dissolved' | 'total' | 'control' | 'unknown'
export type BatchMode = 'auto' | 'network' | 'review'

export type RawBatchRow = {
  id: string
  sourceId: string
  sourceFile: string
  order: string | null
  originalName: string
  tn: string | null
  tp: string | null
  uncertain: string[]
  suggestedNo: string
  suggestedName: string
  sampleKind: SampleKind
  matchReason: string
}

export type ReviewRow = RawBatchRow & {
  include: boolean
  finalNo: string
  finalSampleName: string
}

export type ReviewedRow = Pick<
  ReviewRow,
  'id' | 'sourceId' | 'sourceFile' | 'order' | 'originalName' | 'tn' | 'tp' | 'uncertain' |
  'include' | 'finalNo' | 'finalSampleName' | 'sampleKind' | 'matchReason'
>

const CONTROL = /^(?:0|STD\s*[0-9]+|W|B|RE-?ST|ZERO_?BSLN)$/i

function clean(value: string | null | undefined): string {
  return value?.trim() ?? ''
}

function fallbackKind(name: string): SampleKind {
  const compact = name.replace(/\s+/g, '')
  if (!compact || CONTROL.test(compact)) return 'control'
  if (/DTNP/i.test(compact)) return 'dissolved'
  return compact ? 'total' : 'unknown'
}

function baseSid(name: string): string {
  return name.trim().replace(/[\s_-]*DTNP\b/ig, '').trim() || name.trim()
}

export function toRawBatchRows(sourceId: string, fileName: string, result: ReadResult): RawBatchRow[] {
  return result.rows.map((row, index) => {
    const kind = row.sampleKind ?? fallbackKind(row.name)
    const base = baseSid(row.name)
    const suggestedNo = clean(row.suggestedNo) || base
    const suggestedName = clean(row.suggestedName) || suggestedNo
    return {
      id: `${sourceId}:${index}`,
      sourceId,
      sourceFile: fileName,
      order: row.no,
      originalName: row.name,
      tn: row.cells.tn ?? null,
      tp: row.cells.tp ?? null,
      uncertain: row.uncertain ?? [],
      suggestedNo,
      suggestedName,
      sampleKind: kind,
      matchReason: clean(row.matchReason) || (kind === 'dissolved'
        ? 'SID의 DTNP 표시를 용존값으로 제안'
        : kind === 'total'
          ? 'DTNP 표시가 없는 SID를 총값으로 제안'
          : '품질관리 또는 매칭 불가 행'),
    }
  })
}

function networkSid(name: string): { no: number; dissolved: boolean } | null {
  const match = name.replace(/\s+/g, '').toUpperCase().match(/^(\d{1,2})(DTNP)?$/)
  if (!match) return null
  const no = Number(match[1])
  return no >= 1 && no <= 36 ? { no, dissolved: Boolean(match[2]) } : null
}

/**
 * 숫자 1~36이 보인다는 이유만으로 측정망으로 정하지 않는다.
 * 모든 분석시료가 규칙에 맞고 DTNP/일반 쌍이 충분할 때만 자동 엑셀을 허용한다.
 * 일부 번호만 있는 측정망은 사용자가 명시적으로 측정망 모드를 선택할 수 있다.
 */
export function isNetworkBatch(rows: RawBatchRow[]): boolean {
  const samples = rows.filter((row) => fallbackKind(row.originalName) !== 'control')
  if (samples.length < 4) return false
  const parsed = samples.map((row) => networkSid(row.originalName))
  if (parsed.some((row) => row === null)) return false

  const kinds = new Map<number, Set<string>>()
  for (const item of parsed as Array<{ no: number; dissolved: boolean }>) {
    const set = kinds.get(item.no) ?? new Set<string>()
    set.add(item.dissolved ? 'd' : 't')
    kinds.set(item.no, set)
  }
  // 자동 판별은 보수적으로 한다. 적은 수의 번호 시료는 사용자가 측정망을 직접 선택한다.
  return [...kinds.values()].filter((set) => set.has('d') && set.has('t')).length >= 10
}

function hasOnlyNetworkSids(rows: RawBatchRow[]): boolean {
  const samples = rows.filter((row) => fallbackKind(row.originalName) !== 'control')
  return samples.length > 0 && samples.every((row) => networkSid(row.originalName) !== null)
}

export function toReviewRows(rows: RawBatchRow[]): ReviewRow[] {
  return rows.map((row) => ({
    ...row,
    include: row.sampleKind !== 'control',
    finalNo: row.sampleKind === 'control' ? '' : row.suggestedNo,
    finalSampleName: row.sampleKind === 'control' ? '' : row.suggestedName,
  }))
}

function asNamedResults(rows: RawBatchRow[]): NamedReadResult[] {
  const groups = new Map<string, RawBatchRow[]>()
  for (const row of rows) {
    const list = groups.get(row.sourceFile) ?? []
    list.push(row)
    groups.set(row.sourceFile, list)
  }
  return [...groups].map(([fileName, entries]) => ({
    fileName,
    result: {
      templateId: 'tntp-result',
      notes: [],
      rows: entries.map((entry): ReadRow => ({
        no: entry.order,
        name: entry.originalName,
        cells: { tn: entry.tn, tp: entry.tp, tnTarget: null, tpTarget: null },
        uncertain: entry.uncertain,
      })),
    },
  }))
}

export async function finalizeBatch(rows: RawBatchRow[], requestedMode: BatchMode = 'auto') {
  // 사용자가 측정망을 골랐어도 다른 분석 시료가 섞였다면 잘못된 1~36 엑셀 대신 검토 화면으로 보낸다.
  if ((requestedMode === 'network' && hasOnlyNetworkSids(rows)) || (requestedMode === 'auto' && isNetworkBatch(rows))) {
    const networkRows = buildNetworkRows(asNamedResults(rows))
    return {
      mode: 'network' as const,
      rows: networkRows,
      reviewRows: [] as ReviewRow[],
      workbook: await createNetworkWorkbook(networkRows),
      summary: {
        completeSamples: networkRows.filter((row) => row.dtn !== null && row.tn !== null && row.dtp !== null && row.tp !== null).length,
        warningSamples: networkRows.filter((row) => row.warnings.length > 0).length,
      },
    }
  }

  const reviewRows = toReviewRows(rows)
  return {
    mode: 'review' as const,
    rows: [],
    reviewRows,
    workbook: null,
    summary: {
      completeSamples: 0,
      warningSamples: reviewRows.filter((row) => row.sampleKind === 'unknown' || row.uncertain.length > 0).length,
    },
  }
}

function value(raw: string | null | undefined): number | null {
  if (!raw?.trim()) return null
  const match = raw.match(/-?[0-9]*\.?[0-9]+/)
  if (!match) return null
  const parsed = Number(match[0])
  return Number.isFinite(parsed) ? parsed : null
}

type OutputRow = {
  no: string
  sampleName: string
  dtn: number | null
  tn: number | null
  dtp: number | null
  tp: number | null
  warnings: string[]
  sources: string[]
}

function reviewedOutput(rows: ReviewedRow[]): OutputRow[] {
  const included = rows.filter((row) => row.include)
  const groups = new Map<string, ReviewedRow[]>()
  for (const row of included) {
    if (row.sampleKind === 'unknown' || row.sampleKind === 'control') {
      throw new Error(`'${row.originalName}' 행의 시료 구분을 확인하거나 포함을 해제해주세요.`)
    }
    const no = clean(row.finalNo)
    const name = clean(row.finalSampleName)
    if (!no || !name) throw new Error(`'${row.originalName}' 행의 최종 No와 시료명을 모두 입력해주세요.`)
    const key = no
    const list = groups.get(key) ?? []
    list.push(row)
    groups.set(key, list)
  }

  return [...groups].map(([key, entries]) => {
    const dissolved = entries.filter((row) => row.sampleKind === 'dissolved')
    const total = entries.filter((row) => row.sampleKind === 'total')
    const d = dissolved[0]
    const t = total[0]
    const warnings: string[] = []
    if (!d) warnings.push('DTNP(용존) 행이 없습니다')
    if (!t) warnings.push('일반(총) 행이 없습니다')
    if (new Set(entries.map((row) => clean(row.finalSampleName))).size > 1) {
      throw new Error(`No '${key}'에 서로 다른 시료명이 지정됐습니다. 매칭을 확인해주세요.`)
    }
    if (dissolved.length > 1 || total.length > 1) {
      throw new Error(`No '${key}'에 같은 구분의 행이 중복됐습니다. 사용할 행만 포함해주세요.`)
    }

    const dtn = value(d?.tn)
    const tn = value(t?.tn)
    const dtp = value(d?.tp)
    const tp = value(t?.tp)
    if (d && dtn === null) warnings.push('DTN 값을 읽지 못했습니다')
    if (t && tn === null) warnings.push('TN 값을 읽지 못했습니다')
    if (d && dtp === null) warnings.push('DTP 값을 읽지 못했습니다')
    if (t && tp === null) warnings.push('TP 값을 읽지 못했습니다')
    if (dtn !== null && tn !== null && dtn > tn) warnings.push(`DTN(${dtn})이 TN(${tn})보다 큽니다`)
    if (dtp !== null && tp !== null && dtp > tp) warnings.push(`DTP(${dtp})가 TP(${tp})보다 큽니다`)
    if (entries.some((row) => row.uncertain.length > 0)) warnings.push('AI가 흐린 글씨로 표시한 값이 있습니다')

    return {
      no: clean(entries[0]?.finalNo) || key,
      sampleName: clean(entries.find((row) => clean(row.finalSampleName))?.finalSampleName) || key,
      dtn,
      tn,
      dtp,
      tp,
      warnings,
      sources: [...new Set(entries.map((row) => row.sourceFile))],
    }
  })
}

const COLORS = {
  navy: 'FF16324F',
  line: 'FFD8E1E8',
  text: 'FF1F2937',
  warning: 'FFFFF3CD',
  warningText: 'FF8A5A00',
  white: 'FFFFFFFF',
}

export async function createReviewedWorkbook(reviewed: ReviewedRow[]): Promise<{ buffer: Buffer; rows: OutputRow[] }> {
  const rows = reviewedOutput(reviewed)
  if (!rows.length) throw new Error('엑셀로 내보낼 시료가 없습니다. 포함 여부와 최종 No를 확인해주세요.')

  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Lab Sheet Reader'
  workbook.created = new Date()
  const sheet = workbook.addWorksheet('측정결과', { views: [{ state: 'frozen', ySplit: 1 }] })
  sheet.columns = [
    { header: 'No', key: 'no', width: 14 },
    { header: '시료명', key: 'sampleName', width: 24 },
    { header: 'DTN', key: 'dtn', width: 12 },
    { header: 'TN', key: 'tn', width: 12 },
    { header: 'DTP', key: 'dtp', width: 12 },
    { header: 'TP', key: 'tp', width: 12 },
  ]
  for (const item of rows) {
    const row = sheet.addRow(item)
    row.height = 22
    if (item.warnings.length) row.eachCell({ includeEmpty: true }, (cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.warning } }
    })
  }
  const header = sheet.getRow(1)
  header.height = 28
  header.font = { name: '맑은 고딕', size: 10, bold: true, color: { argb: COLORS.white } }
  header.alignment = { horizontal: 'center', vertical: 'middle' }
  header.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.navy } } })
  for (const row of sheet.getRows(2, rows.length) ?? []) {
    row.font = { name: '맑은 고딕', size: 10, color: { argb: COLORS.text } }
    for (let column = 3; column <= 6; column++) row.getCell(column).numFmt = '0.000'
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.border = { bottom: { style: 'thin', color: { argb: COLORS.line } } }
    })
  }
  sheet.autoFilter = { from: 'A1', to: `F${rows.length + 1}` }

  const audit = workbook.addWorksheet('원본매칭', { views: [{ state: 'frozen', ySplit: 1 }] })
  audit.columns = [
    { header: '포함', key: 'include', width: 9 },
    { header: '원본 SID', key: 'originalName', width: 22 },
    { header: '구분', key: 'kind', width: 12 },
    { header: '최종 No', key: 'no', width: 16 },
    { header: '최종 시료명', key: 'name', width: 24 },
    { header: '원본 T-N', key: 'tn', width: 14 },
    { header: '원본 T-P', key: 'tp', width: 14 },
    { header: '원본 파일', key: 'source', width: 42 },
    { header: '매칭 근거', key: 'reason', width: 48 },
  ]
  for (const row of reviewed) audit.addRow({
    include: row.include ? '사용' : '제외', originalName: row.originalName, kind: row.sampleKind,
    no: row.finalNo, name: row.finalSampleName, tn: row.tn, tp: row.tp,
    source: row.sourceFile, reason: row.matchReason,
  })
  const auditHeader = audit.getRow(1)
  auditHeader.font = { name: '맑은 고딕', size: 10, bold: true, color: { argb: COLORS.white } }
  auditHeader.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.navy } } })

  const flagged = rows.filter((row) => row.warnings.length)
  if (flagged.length) {
    const review = workbook.addWorksheet('검토사항')
    review.columns = [
      { header: 'No', key: 'no', width: 14 },
      { header: '시료명', key: 'sampleName', width: 24 },
      { header: '확인사항', key: 'warning', width: 64 },
      { header: '원본 파일', key: 'sources', width: 42 },
    ]
    for (const item of flagged) review.addRow({ no: item.no, sampleName: item.sampleName, warning: item.warnings.join(' / '), sources: item.sources.join(', ') })
    const h = review.getRow(1)
    h.font = { name: '맑은 고딕', size: 10, bold: true, color: { argb: COLORS.white } }
    h.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.warningText } } })
  }

  return { buffer: Buffer.from(await workbook.xlsx.writeBuffer()), rows }
}
