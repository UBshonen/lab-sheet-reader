/**
 * 판독이 되는지만 확인하는 스크립트. 화면 없음.
 *
 *   npm run read -- samples/toc.pdf
 *
 * 같은 파일을 다시 부르면 API 를 호출하지 않고 캐시에서 읽는다.
 * 개발 중에 같은 스캔본을 수십 번 돌리게 되므로 이게 비용의 대부분을 막는다.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, extname } from 'node:path'
import 'dotenv/config'

import { GeminiReader } from '../lib/reader/gemini.js'
import type { ReadResult } from '../lib/reader/index.js'
import template from '../lib/templates/toc-result.json' with { type: 'json' }

const CACHE_DIR = '.cache'

/** 확장자 → 형식. 사진 한 장으로도 되고 여러 쪽짜리 PDF 로도 된다 */
const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

const INSTRUCTION = `
이 문서는 수질 시험 기기가 출력한 표다. 표의 모든 줄을 위에서 아래 순서 그대로 읽어라.

각 줄에서 뽑을 것:
  no      맨 왼쪽에 인쇄된 번호. 비어 있으면 null
  name    시료명 칸의 글자를 보이는 그대로. 해석하거나 고치지 마라
  cells.dilu    희석(Manual Dilu) 칸의 값
  cells.result  결과(Result) 칸의 값을 통째로. 예: "NPOC:2.550mg/L"

지켜야 할 것:
  - 번호는 비연속일 수 있다. 순서를 임의로 메우지 마라
  - 시료명이 "유출" 처럼 짧아도 앞줄에서 추측해 채우지 마라. 보이는 대로 적어라
  - 값이 어느 줄에 속하는지 애매하면 notes 에 그 줄 번호와 이유를 적어라
  - 읽을 수 없는 칸은 null 로 두어라. 그럴듯한 값을 지어내지 마라
`.trim()

function cacheKey(bytes: Uint8Array, model: string) {
  const h = createHash('sha256')
  h.update(bytes)
  h.update(model)
  h.update(INSTRUCTION)
  return h.digest('hex').slice(0, 16)
}

async function main() {
  const file = process.argv[2]
  if (!file) {
    console.error('사용법: npm run read -- <파일경로>')
    process.exit(1)
  }
  if (!existsSync(file)) {
    console.error(`파일이 없습니다: ${file}`)
    process.exit(1)
  }

  const key = process.env.GEMINI_API_KEY
  if (!key) {
    console.error('GEMINI_API_KEY 가 없습니다. .env.local 을 만들고 키를 넣으세요.')
    process.exit(1)
  }

  const model = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'
  const bytes = new Uint8Array(readFileSync(file))

  const mimeType = MIME[extname(file).toLowerCase()]
  if (!mimeType) {
    console.error(`읽을 수 없는 형식입니다: ${extname(file)}`)
    console.error(`쓸 수 있는 것: ${Object.keys(MIME).join(' ')}`)
    process.exit(1)
  }

  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true })
  const cachePath = `${CACHE_DIR}/${basename(file)}.${cacheKey(bytes, model)}.json`

  let result: ReadResult
  if (existsSync(cachePath)) {
    console.log(`캐시에서 읽음  ${cachePath}\n`)
    result = JSON.parse(readFileSync(cachePath, 'utf8')) as ReadResult
  } else {
    console.log(`판독 중  ${file}  (${model})\n`)
    const started = Date.now()
    result = await new GeminiReader(key, model).read({ bytes, mimeType, instruction: INSTRUCTION })
    console.log(`${((Date.now() - started) / 1000).toFixed(1)}초\n`)
    writeFileSync(cachePath, JSON.stringify(result, null, 2), 'utf8')
  }

  report(result)
}

/** QC 시료가 제자리에 있는지로 정렬이 맞는지 판정한다. */
function report(result: ReadResult) {
  const num = (s: string | null | undefined) => {
    if (!s) return null
    const m = s.match(/[0-9]*\.?[0-9]+/)
    return m ? Number(m[0]) : null
  }

  console.log(`${'번호'.padEnd(6)}${'시료명'.padEnd(24)}${'결과'.padStart(12)}   판정`)
  console.log('─'.repeat(64))

  let qcTotal = 0
  let qcPass = 0

  for (const row of result.rows) {
    const value = num(row.cells.result)
    const rule = template.qc.find((q) => new RegExp(q.match).test(row.name.trim()))

    let verdict = ''
    if (rule?.expect) {
      qcTotal++
      const e = rule.expect as { max?: number; near?: number; tol?: number }
      const ok =
        value !== null &&
        (e.max !== undefined
          ? value <= e.max
          : e.near !== undefined && Math.abs(value - e.near) <= (e.tol ?? 0))
      if (ok) qcPass++
      verdict = `${rule.label} ${ok ? '통과' : '어긋남'}`
    } else if (rule) {
      verdict = rule.label
    }

    console.log(
      `${(row.no ?? '-').padEnd(6)}${row.name.slice(0, 22).padEnd(24)}${(row.cells.result ?? '-').padStart(12)}   ${verdict}`,
    )
  }

  console.log('─'.repeat(64))
  console.log(`${result.rows.length}행 읽음`)

  if (qcTotal === 0) {
    console.log('품질관리 시료를 못 찾았습니다. 정렬을 검증할 근거가 없습니다.')
  } else if (qcPass === qcTotal) {
    console.log(`정렬 확인됨 — 품질관리 시료 ${qcTotal}개가 모두 제자리`)
  } else {
    console.log(`정렬 의심 — 품질관리 시료 ${qcTotal}개 중 ${qcTotal - qcPass}개가 어긋남`)
  }

  if (result.notes.length) {
    console.log('\n모델이 남긴 메모')
    for (const n of result.notes) console.log(`  · ${n}`)
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
