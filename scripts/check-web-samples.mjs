import { readFile, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import assert from 'node:assert/strict'

const names = [
  'KakaoTalk_20260916_110221727.jpg',
  'KakaoTalk_20260916_131542288.jpg',
  'KakaoTalk_20260916_131542288_01.jpg',
  'KakaoTalk_20260916_133437360.jpg',
  'KakaoTalk_20260916_133437360_01.jpg',
]

const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.pdf': 'application/pdf' }
const files = await Promise.all(names.map(async (name) => {
  const path = join('samples', name)
  return {
    name: basename(path),
    mimeType: mime[extname(path).toLowerCase()],
    data: (await readFile(path)).toString('base64'),
  }
}))

const response = await fetch('http://localhost:3000/api/process', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ files }),
})
const result = await response.json()
if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`)

console.log(JSON.stringify({ mode: result.mode, summary: result.summary, files: result.files }, null, 2))
console.log('warnings', result.rows.filter((row) => row.warnings.length).map((row) => ({ no: row.no, warnings: row.warnings })))
if (result.mode !== 'network' || !result.workbookBase64) {
  const pairs = new Map()
  for (const row of result.rawRows) {
    const match = row.originalName.replace(/\s+/g, '').toUpperCase().match(/^(\d{1,2})(DTNP)?$/)
    if (!match) continue
    const set = pairs.get(match[1]) ?? new Set()
    set.add(match[2] ? 'd' : 't')
    pairs.set(match[1], set)
  }
  console.log('network pair count', [...pairs.values()].filter((set) => set.has('d') && set.has('t')).length)
  console.log('sample row count', result.rawRows.filter((row) => /^(?:\d{1,2})(?:DTNP)?$/i.test(row.originalName.replace(/\s+/g, ''))).length)
  console.log('non-network rows', result.rawRows
    .filter((row) => !/^(?:\d{1,2})(?:DTNP)?$/i.test(row.originalName.replace(/\s+/g, '')))
    .map((row) => ({ name: row.originalName, kind: row.sampleKind })))
  process.exitCode = 1
} else {
  assert.equal(result.summary.completeSamples, 36)
  assert.equal(result.summary.warningSamples, 1)
  assert.deepEqual(result.rows.map((row) => row.no), Array.from({ length: 36 }, (_, index) => index + 1))
  const request = async (path, body) => {
    const response = await fetch(`http://localhost:3000${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    const output = await response.json()
    assert.equal(response.status, 200, JSON.stringify(output))
    return output
  }
  const early = await request('/api/process', { files: files.slice(0, 1), mode: 'network' })
  const later = await request('/api/process', { files: files.slice(1), mode: 'review' })
  assert.equal(early.mode, 'network')
  assert.equal(early.rows.length, 36)
  assert.ok(early.summary.completeSamples < 36)
  const combined = await request('/api/finalize', {
    rawRows: [...later.rawRows, ...early.rawRows],
    mode: 'network',
  })
  assert.equal(combined.mode, 'network')
  assert.equal(combined.summary.completeSamples, 36)
  assert.deepEqual(combined.rows.map((row) => row.no), Array.from({ length: 36 }, (_, index) => index + 1))
  console.log('split and reverse-order network merge passed')
  await writeFile('out/web-sample-result.xlsx', Buffer.from(result.workbookBase64, 'base64'))
}
