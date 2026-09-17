import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import { buildNetworkRows, createNetworkWorkbook } from '../lib/network-results.js'
import { createReviewedWorkbook, finalizeBatch, isNetworkBatch, toRawBatchRows } from '../lib/batch-results.js'
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

const knownRaw = [
  ...toRawBatchRows('a', 'page-a.jpg', result([
    row('1DTNP', '4.037', '0.044'), row('1', '4.143', '0.048'),
    row('2DTNP', '3.000', '0.050'), row('2', '3.100', '0.060'),
  ])),
]
assert.equal(isNetworkBatch(knownRaw), false, '일부 숫자 시료만으로 측정망이라고 자동 확정하지 않아야 한다')
const knownFinal = await finalizeBatch(knownRaw, 'network')
assert.equal(knownFinal.mode, 'network')
assert.equal(knownFinal.rows.length, 36)
assert.equal(knownFinal.rows[0]?.sampleName, '석문동천2')
assert.equal(knownFinal.rows[2]?.dtn, null, '아직 넣지 않은 번호는 빈 행이어야 한다')

const shuffledRaw = toRawBatchRows('shuffled', 'shuffled.jpg', result([
  row('36', '1.900', '0.090'), row('2', '3.100', '0.060'),
  row('36DTNP', '1.800', '0.080'), row('1', '4.143', '0.048'),
  row('2DTNP', '3.000', '0.050'), row('1DTNP', '4.037', '0.044'),
]))
const shuffledFinal = await finalizeBatch(shuffledRaw, 'network')
assert.equal(shuffledFinal.rows[0]?.no, 1)
assert.equal(shuffledFinal.rows[0]?.dtn, 4.037)
assert.equal(shuffledFinal.rows[1]?.no, 2)
assert.equal(shuffledFinal.rows[35]?.no, 36)
assert.equal(shuffledFinal.rows[35]?.tn, 1.9)

const otherRaw = toRawBatchRows('b', 'other.jpg', result([
  row('민원A-DTNP', '1.100', '0.010'),
  row('민원A', '1.300', '0.020'),
  row('민원B-DTNP', '2.100', '0.030'),
  row('민원B', '2.400', '0.040'),
  row('STD 1', '0.100', '0.001'),
]))
assert.equal(isNetworkBatch(otherRaw), false, '기타 시료를 측정망 1~36으로 강제하면 안 된다')
const otherFinal = await finalizeBatch(otherRaw)
assert.equal(otherFinal.mode, 'review')
assert.equal(otherFinal.reviewRows.find((item) => item.originalName === 'STD 1')?.include, false)

const reviewed = otherFinal.reviewRows.map((item) => ({
  ...item,
  finalNo: item.originalName.includes('민원A') ? 'A' : item.originalName.includes('민원B') ? 'B' : '',
  finalSampleName: item.originalName.includes('민원A') ? '민원시료 A' : item.originalName.includes('민원B') ? '민원시료 B' : '',
}))
const reviewedWorkbook = await createReviewedWorkbook(reviewed)
const loadedReviewed = new ExcelJS.Workbook()
await loadedReviewed.xlsx.load(reviewedWorkbook.buffer as never)
assert.deepEqual((loadedReviewed.getWorksheet('측정결과')!.getRow(1).values as unknown[]).slice(1), ['No', '시료명', 'DTN', 'TN', 'DTP', 'TP'])
assert.equal(loadedReviewed.getWorksheet('측정결과')!.getCell('A2').value, 'A')
assert.equal(loadedReviewed.getWorksheet('측정결과')!.getCell('C2').value, 1.1)
assert.ok(loadedReviewed.getWorksheet('원본매칭'))
await assert.rejects(
  createReviewedWorkbook(reviewed.map((item) => item.originalName === '민원A' ? { ...item, finalNo: '' } : item)),
  /최종 No와 시료명/,
)
await assert.rejects(
  createReviewedWorkbook(reviewed.map((item) => item.originalName === '민원A' ? { ...item, sampleKind: 'unknown' as const } : item)),
  /시료 구분/,
)
await assert.rejects(
  createReviewedWorkbook([...reviewed, { ...reviewed[0]!, id: 'duplicate' }]),
  /중복/,
)

console.log('network result tests passed')
