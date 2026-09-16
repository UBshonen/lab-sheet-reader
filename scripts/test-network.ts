import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import { buildNetworkRows, createNetworkWorkbook } from '../lib/network-results.js'
import type { ReadResult, ReadRow } from '../lib/reader/index.js'

const row = (name: string, tn: string, tp: string): ReadRow => ({
  no: null,
  name,
  cells: { tn, tp, tnTarget: null, tpTarget: null },
})

const result = (rows: ReadRow[]): ReadResult => ({
  templateId: 'tntp-result',
  rows,
  notes: [],
})

const rows = buildNetworkRows([
  { fileName: 'page1.jpg', result: result([row('1DTNP', '4.037', '0.044'), row('W', '0', '0')]) },
  { fileName: 'page2.jpg', result: result([row('1', '4.143', '0.048'), row('2DTNP', '3.0004', '0.0504')]) },
  { fileName: 'other-run.jpg', result: result([row('2', '2.9999', '0.0499')]) },
])

assert.equal(rows.length, 36)
assert.deepEqual(
  { no: rows[0]!.no, name: rows[0]!.sampleName, dtn: rows[0]!.dtn, tn: rows[0]!.tn, dtp: rows[0]!.dtp, tp: rows[0]!.tp },
  { no: 1, name: '석문동천2', dtn: 4.037, tn: 4.143, dtp: 0.044, tp: 0.048 },
)
assert.equal(rows[0]!.warnings.length, 0)
assert.ok(rows[1]!.warnings.some((warning) => warning.startsWith('DTN(')))
assert.ok(rows[1]!.warnings.some((warning) => warning.startsWith('DTP(')))
assert.ok(rows[2]!.warnings.some((warning) => warning.includes('3DTNP 행이 없습니다')))

const buffer = await createNetworkWorkbook(rows)
const workbook = new ExcelJS.Workbook()
await workbook.xlsx.load(buffer as never)
const sheet = workbook.getWorksheet('측정결과')!
assert.deepEqual((sheet.getRow(1).values as unknown[]).slice(1), ['No', '시료명', 'DTN', 'TN', 'DTP', 'TP'])
assert.equal(sheet.getCell('C2').value, 4.037)
assert.equal(sheet.getCell('C2').numFmt, '0.000')
assert.ok(workbook.getWorksheet('검토사항'))

console.log('network result tests passed')
