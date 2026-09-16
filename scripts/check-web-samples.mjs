import { readFile, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

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

console.log(JSON.stringify({ summary: result.summary, files: result.files }, null, 2))
console.log('warnings', result.rows.filter((row) => row.warnings.length).map((row) => ({ no: row.no, warnings: row.warnings })))
await writeFile('out/web-sample-result.xlsx', Buffer.from(result.workbookBase64, 'base64'))
