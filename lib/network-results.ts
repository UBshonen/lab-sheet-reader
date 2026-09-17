import ExcelJS from 'exceljs'
import type { ReadResult, ReadRow } from './reader/index.js'
import riverNames from './river-names.json' with { type: 'json' }

/** 하천명.jpg에서 확인한 측정망 전용 고정 기준표. 일반 시료에는 사용하지 않는다. */
export const RIVER_NAMES: Readonly<Record<number, string>> = Object.freeze(riverNames)

if (Object.keys(RIVER_NAMES).length !== 36 ||
  Array.from({ length: 36 }, (_, index) => index + 1).some((no) => !RIVER_NAMES[no]?.trim())) {
  throw new Error('측정망 하천명 기준표는 1~36번이 모두 있어야 합니다.')
}

export type NamedReadResult = {
  fileName: string
  result: ReadResult
}

export type NetworkRow = {
  no: number
  sampleName: string
  dtn: number | null
  tn: number | null
  dtp: number | null
  tp: number | null
  warnings: string[]
  sources: string[]
}

type Found = { fileName: string; row: ReadRow }

function number(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw.trim() === '') return null
  const match = raw.match(/-?[0-9]*\.?[0-9]+/)
  if (!match) return null
  const value = Number(match[0])
  return Number.isFinite(value) ? value : null
}

function distinct(entries: Found[]): Found[] {
  const seen = new Set<string>()
  return entries.filter((entry) => {
    const key = `${entry.fileName}\u0000${entry.row.no}\u0000${entry.row.name}\u0000${entry.row.cells.tn}\u0000${entry.row.cells.tp}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * 여러 페이지와 여러 측정 회차를 하나로 모은다.
 * 파일 순서가 아니라 SID의 번호를 기준으로 하므로 페이지 경계의 18DTNP/18도 연결된다.
 */
export function buildNetworkRows(inputs: NamedReadResult[]): NetworkRow[] {
  const dissolved = new Map<number, Found[]>()
  const total = new Map<number, Found[]>()

  for (const input of inputs) {
    for (const row of input.result.rows) {
      const sid = row.name.replace(/\s+/g, '').toUpperCase()
      const match = sid.match(/^(\d{1,2})(DTNP)?$/)
      if (!match) continue

      const no = Number(match[1])
      if (no < 1 || no > 36) continue
      const target = match[2] ? dissolved : total
      const list = target.get(no) ?? []
      list.push({ fileName: input.fileName, row })
      target.set(no, list)
    }
  }

  return Array.from({ length: 36 }, (_, index) => {
    const no = index + 1
    const dRows = distinct(dissolved.get(no) ?? [])
    const tRows = distinct(total.get(no) ?? [])
    const d = dRows[0]
    const t = tRows[0]
    const warnings: string[] = []

    if (!d) warnings.push(`${no}DTNP 행이 없습니다`)
    if (!t) warnings.push(`${no} 행이 없습니다`)
    if (dRows.length > 1) warnings.push(`${no}DTNP 행이 ${dRows.length}개입니다`)
    if (tRows.length > 1) warnings.push(`${no} 행이 ${tRows.length}개입니다`)

    const rawDtn = number(d?.row.cells.tn)
    const rawTn = number(t?.row.cells.tn)
    const rawDtp = number(d?.row.cells.tp)
    const rawTp = number(t?.row.cells.tp)

    if (d && rawDtn === null) warnings.push(`${no}DTNP 행의 T-N 값을 읽지 못했습니다`)
    if (t && rawTn === null) warnings.push(`${no} 행의 T-N 값을 읽지 못했습니다`)
    if (d && rawDtp === null) warnings.push(`${no}DTNP 행의 T-P 값을 읽지 못했습니다`)
    if (t && rawTp === null) warnings.push(`${no} 행의 T-P 값을 읽지 못했습니다`)

    if (rawDtn !== null && rawTn !== null && rawDtn > rawTn) {
      warnings.push(`DTN(${rawDtn})이 TN(${rawTn})보다 큽니다`)
    }
    if (rawDtp !== null && rawTp !== null && rawDtp > rawTp) {
      warnings.push(`DTP(${rawDtp})가 TP(${rawTp})보다 큽니다`)
    }
    for (const [label, value] of [
      ['DTN', rawDtn],
      ['TN', rawTn],
      ['DTP', rawDtp],
      ['TP', rawTp],
    ] as const) {
      if (value !== null && value < 0) warnings.push(`${label} 값이 음수입니다`)
    }

    const uncertain = new Set<string>()
    for (const entry of [...dRows, ...tRows]) {
      for (const key of entry.row.uncertain ?? []) uncertain.add(key)
    }
    if (uncertain.has('tn')) warnings.push('T-N 글씨가 흐려 판독 확인이 필요합니다')
    if (uncertain.has('tp')) warnings.push('T-P 글씨가 흐려 판독 확인이 필요합니다')

    return {
      no,
      sampleName: RIVER_NAMES[no],
      // 값은 절대 보정하지 않는다. 엑셀에서 보이는 자릿수만 0.000 형식으로 제한한다.
      dtn: rawDtn,
      tn: rawTn,
      dtp: rawDtp,
      tp: rawTp,
      warnings,
      sources: [...new Set([...dRows, ...tRows].map((entry) => entry.fileName))],
    }
  })
}

const COLORS = {
  navy: 'FF16324F',
  blue: 'FF2B6F92',
  paleBlue: 'FFEAF3F8',
  line: 'FFD8E1E8',
  text: 'FF1F2937',
  muted: 'FF667085',
  warning: 'FFFFF3CD',
  warningText: 'FF8A5A00',
  white: 'FFFFFFFF',
}

/** 정보시스템 입력용 6열과 사람이 확인할 검토사항 시트를 함께 만든다. */
export async function createNetworkWorkbook(rows: NetworkRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Lab Sheet Reader'
  workbook.created = new Date()

  const sheet = workbook.addWorksheet('측정결과', {
    views: [{ state: 'frozen', ySplit: 1 }],
    properties: { tabColor: { argb: COLORS.blue } },
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  })

  sheet.columns = [
    { header: 'No', key: 'no', width: 8 },
    { header: '시료명', key: 'sampleName', width: 20 },
    { header: 'DTN', key: 'dtn', width: 12 },
    { header: 'TN', key: 'tn', width: 12 },
    { header: 'DTP', key: 'dtp', width: 12 },
    { header: 'TP', key: 'tp', width: 12 },
  ]

  for (const item of rows) {
    const row = sheet.addRow({
      no: item.no,
      sampleName: item.sampleName,
      dtn: item.dtn,
      tn: item.tn,
      dtp: item.dtp,
      tp: item.tp,
    })
    row.height = 22
    if (item.warnings.length) {
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.warning } }
      })
      row.getCell(1).note = item.warnings.join('\n')
    } else if (item.no % 2 === 0) {
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7FAFC' } }
      })
    }
  }

  const header = sheet.getRow(1)
  header.height = 28
  header.font = { name: '맑은 고딕', size: 10, bold: true, color: { argb: COLORS.white } }
  header.alignment = { horizontal: 'center', vertical: 'middle' }
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.navy } }
  })

  for (const row of sheet.getRows(2, 36) ?? []) {
    row.font = { name: '맑은 고딕', size: 10, color: { argb: COLORS.text } }
    row.alignment = { vertical: 'middle' }
    row.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' }
    row.getCell(2).alignment = { horizontal: 'left', vertical: 'middle' }
    for (let column = 3; column <= 6; column++) {
      row.getCell(column).alignment = { horizontal: 'right', vertical: 'middle' }
      row.getCell(column).numFmt = '0.000'
    }
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.border = { bottom: { style: 'thin', color: { argb: COLORS.line } } }
    })
  }
  sheet.autoFilter = { from: 'A1', to: 'F37' }

  const flagged = rows.filter((row) => row.warnings.length)
  if (flagged.length) {
    const review = workbook.addWorksheet('검토사항', {
      views: [{ state: 'frozen', ySplit: 1 }],
      properties: { tabColor: { argb: 'FFF0B429' } },
    })
    review.columns = [
      { header: 'No', key: 'no', width: 8 },
      { header: '시료명', key: 'sampleName', width: 20 },
      { header: '확인사항', key: 'warning', width: 64 },
      { header: '원본 파일', key: 'sources', width: 42 },
    ]
    for (const item of flagged) {
      review.addRow({
        no: item.no,
        sampleName: item.sampleName,
        warning: item.warnings.join(' / '),
        sources: item.sources.join(', '),
      })
    }
    const reviewHeader = review.getRow(1)
    reviewHeader.height = 28
    reviewHeader.font = { name: '맑은 고딕', size: 10, bold: true, color: { argb: COLORS.white } }
    reviewHeader.alignment = { horizontal: 'center', vertical: 'middle' }
    reviewHeader.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.warningText } }
    })
    for (const row of review.getRows(2, flagged.length) ?? []) {
      row.font = { name: '맑은 고딕', size: 10, color: { argb: COLORS.text } }
      row.alignment = { vertical: 'top', wrapText: true }
      row.height = 32
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.border = { bottom: { style: 'thin', color: { argb: COLORS.line } } }
      })
    }
    review.autoFilter = { from: 'A1', to: `D${flagged.length + 1}` }
  }

  return Buffer.from(await workbook.xlsx.writeBuffer())
}
