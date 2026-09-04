/**
 * 판독이 되는지 확인하는 스크립트. 화면 없음.
 *
 *   npm run read -- samples/            폴더 전체
 *   npm run read -- samples/a.jpg b.jpg  개별
 *
 * 파일마다 무슨 문서인지 먼저 판별하고, 읽을 것만 읽는다.
 * 같은 파일을 다시 부르면 API 를 호출하지 않고 캐시에서 읽는다.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, extname, join } from 'node:path'
import { config } from 'dotenv'

// dotenv 는 기본으로 .env 만 읽는다. .env.local 을 먼저 보게 명시한다
config({ path: ['.env.local', '.env'], quiet: true })

import { GeminiReader } from '../lib/reader/gemini.js'
import type { Source, DetectResult, ReadResult, Usage } from '../lib/reader/index.js'
import { TEMPLATES, findTemplate, type Template } from '../lib/templates/index.js'
import { checkQc } from '../lib/qc.js'
import { checkRules } from '../lib/rules.js'
import { writeWorkbook } from '../lib/export.js'

const CACHE_DIR = '.cache'

/** 확장자 → 형식. 사진 한 장으로도 되고 여러 쪽짜리 PDF 로도 된다 */
const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

/**
 * 100만 토큰당 달러. gemini-3.6-flash 도입 가격 기준.
 * 2027년 1월부터 오르므로 그때 고칠 것.
 * 무료 티어에서는 청구되지 않는다. 유료로 갈지 판단하려고 찍는다.
 */
const PRICE = { in: 0.75, out: 3.75 }
const KRW = 1400

function cached<T>(path: string, make: () => Promise<T>): Promise<T> {
  if (existsSync(path)) return Promise.resolve(JSON.parse(readFileSync(path, 'utf8')) as T)
  return make().then((v) => {
    writeFileSync(path, JSON.stringify(v, null, 2), 'utf8')
    return v
  })
}

function keyOf(bytes: Uint8Array, ...parts: string[]) {
  const h = createHash('sha256')
  h.update(bytes)
  for (const p of parts) h.update(p)
  return h.digest('hex').slice(0, 12)
}

/** 인자가 폴더면 안의 파일을 전부, 파일이면 그것만 */
function collect(args: string[]): string[] {
  const out: string[] = []
  for (const a of args) {
    if (!existsSync(a)) {
      console.error(`없는 경로: ${a}`)
      continue
    }
    if (statSync(a).isDirectory()) {
      for (const f of readdirSync(a).sort()) {
        if (MIME[extname(f).toLowerCase()]) out.push(join(a, f))
      }
    } else if (MIME[extname(a).toLowerCase()]) {
      out.push(a)
    } else {
      console.error(`읽을 수 없는 형식: ${a}`)
    }
  }
  return out
}

const money = (u: Usage) =>
  Math.round(((u.inputTokens * PRICE.in + u.outputTokens * PRICE.out) / 1_000_000) * KRW)

async function main() {
  const args = process.argv.slice(2)
  if (!args.length) {
    console.error('사용법: npm run read -- <파일 또는 폴더> [...]')
    process.exit(1)
  }

  const key = process.env.GEMINI_API_KEY?.trim()
  if (!key) {
    console.error('GEMINI_API_KEY 가 비어 있습니다.')
    console.error(`  파일:  ${process.cwd()}\\.env.local`)
    process.exit(1)
  }

  const files = collect(args)
  if (!files.length) {
    console.error('읽을 파일이 없습니다.')
    process.exit(1)
  }

  const model = process.env.GEMINI_MODEL?.trim() || 'gemini-3.6-flash'
  const reader = new GeminiReader(key, model)
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true })

  console.log(`${files.length}개 파일 · ${model}\n`)

  const collected: ReadResult[] = []
  const totals: Usage = { inputTokens: 0, outputTokens: 0 }
  const add = (u?: Usage) => {
    if (!u) return
    totals.inputTokens += u.inputTokens
    totals.outputTokens += u.outputTokens
  }

  for (const file of files) {
    const bytes = new Uint8Array(readFileSync(file))
    const src: Source = { bytes, mimeType: MIME[extname(file).toLowerCase()]! }
    const tag = basename(file)

    // 1단계 · 무슨 문서인가. 출력이 짧아 값이 거의 안 붙는다
    const det = await cached<DetectResult>(
      `${CACHE_DIR}/${tag}.${keyOf(bytes, model, 'detect')}.json`,
      () => reader.detect(src, TEMPLATES),
    )
    add(det.usage)

    const template = det.templateId ? findTemplate(det.templateId) : undefined

    if (!template) {
      console.log(`■ ${tag}`)
      console.log(`  알아보지 못했습니다 — ${det.reason}\n`)
      continue
    }

    if (template.purpose === 'skip') {
      console.log(`■ ${tag}`)
      console.log(`  ${template.name} · 건너뜀\n`)
      continue
    }

    // 2단계 · 고른 템플릿의 지시문으로 정밀 판독
    const res = await cached<ReadResult>(
      `${CACHE_DIR}/${tag}.${keyOf(bytes, model, 'read', template.id)}.json`,
      () => reader.read(src, template),
    )
    add(res.usage)
    collected.push(res)

    console.log(`■ ${tag}`)
    console.log(`  ${template.name}`)
    report(res, template)
    console.log()
  }

  const outArg = args.find((a) => a.endsWith('.xlsx'))
  const outPath = outArg ?? 'out/결과.xlsx'
  if (collected.length) {
    if (!existsSync('out')) mkdirSync('out', { recursive: true })
    const written = await writeWorkbook(collected, outPath)
    if (written.length) {
      console.log('─'.repeat(72))
      console.log(`엑셀  ${outPath}`)
      console.log(`      ${written.join(' · ')}`)
    }
  }

  console.log('─'.repeat(72))
  console.log(
    `합계  입력 ${totals.inputTokens.toLocaleString()} · 출력 ${totals.outputTokens.toLocaleString()}` +
      `   유료 기준 약 ${money(totals)}원`,
  )
}

function report(res: ReadResult, template: Template) {
  const qc = checkQc(res.rows, template)
  const byRow = new Map(qc.verdicts.map((v) => [v.row, v]))
  const cols = template.columns.slice(0, 3)

  const head =
    '  ' +
    '번호'.padEnd(6) +
    '시료명'.padEnd(22) +
    cols.map((c) => c.label.padStart(11)).join('') +
    '   판정'
  console.log(head)
  console.log('  ' + '─'.repeat(70))

  for (const row of res.rows) {
    const v = byRow.get(row)
    const mark = v ? (v.ok === null ? `${v.rule.label}` : `${v.rule.label} ${v.ok ? '통과' : '어긋남'}`) : ''
    console.log(
      '  ' +
        (row.no ?? '-').padEnd(6) +
        row.name.slice(0, 20).padEnd(22) +
        cols.map((c) => (row.cells[c.key] ?? '-').slice(0, 10).padStart(11)).join('') +
        `   ${mark}`,
    )
  }

  console.log('  ' + '─'.repeat(70))
  const real = res.rows.length - qc.verdicts.length
  console.log(`  ${res.rows.length}행 · 시료 ${real} · 품질관리 ${qc.verdicts.length}`)

  const bad = checkRules(res.rows, template)
  if (bad.length) {
    console.log(`  타당성 위반 ${bad.length}건 — 확인 필요`)
    for (const v of bad) {
      const no = v.row.no ? `${v.row.no} ` : ''
      console.log(`    · ${no}${v.row.name}  ${v.rule.label}:  ${v.detail}`)
    }
  } else if ((template.rules?.length ?? 0) > 0) {
    console.log(`  타당성 규칙 ${template.rules!.length}개 전부 통과`)
  }

  if (qc.aligned === true) {
    console.log(`  정렬 확인됨 — 품질관리 시료 ${qc.checked}개가 모두 제자리`)
  } else if (qc.aligned === false) {
    console.log(`  정렬 의심 — ${qc.checked}개 중 ${qc.checked - qc.passed}개가 어긋남`)
    for (const v of qc.verdicts.filter((x) => x.ok === false)) {
      console.log(`    · ${v.row.name}  ${v.detail}`)
    }
  } else if ((template.rules?.length ?? 0) === 0) {
    // QC 도 규칙도 없으면 검증할 근거가 아무것도 없다. 그 사실을 밝혀야 한다
    console.log('  검증할 근거가 없습니다 — 품질관리 시료도 타당성 규칙도 없음')
  }

  if (res.notes.length) {
    console.log('  모델이 남긴 메모')
    for (const n of res.notes) console.log(`    · ${n}`)
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
