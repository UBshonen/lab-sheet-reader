import ExcelJS from 'exceljs'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { ReadResult, ReadRow } from './reader/index.js'
import { findTemplate } from './templates/index.js'
import { isQc } from './qc.js'
import { checkRules } from './rules.js'

/**
 * 판독 결과를 결과정리 엑셀에 붙여넣을 형태로 뱉는다.
 *
 * 항목마다 시트를 나눈다. 시스템 입력 화면이 항목별로 따로 있고,
 * 엑셀에서도 항목별로 블록을 잡아 복사하기 때문이다.
 *
 * 수식 열(결과값 · 차이 · 농도 · 성적용)은 뱉지 않는다.
 * 그건 엑셀이 계산하는 칸이라 값을 넣으면 수식을 덮어쓴다.
 */

type LayoutColumn = { label: string; from?: string; default?: string }
type LayoutItem = { item: string; range: string; columns: LayoutColumn[] }

const here = dirname(fileURLToPath(import.meta.url))
const LAYOUT = JSON.parse(readFileSync(join(here, 'heis-layout.json'), 'utf8')) as {
  items: LayoutItem[]
}

/** 시료명을 견주기 위해 공백과 괄호를 지운다. 이름을 바꾸는 게 아니라 비교용이다 */
function normalize(name: string): string {
  return name.replace(/[\s()（）]/g, '').trim()
}

/** "NPOC:2.550mg/L" 에서 2.550 만 꺼낸다 */
function pickNumber(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === '') return null
  const m = String(raw).match(/-?[0-9]*\.?[0-9]+/)
  return m ? m[0] : null
}

/** 시료 하나. 여러 문서에서 온 값이 여기 모인다 */
export type Sample = {
  /** 화면에 보일 이름. 처음 만난 문서의 이름을 쓴다 */
  name: string
  /** 템플릿id → 그 문서에서 읽은 줄 */
  rows: Map<string, ReadRow>
  /**
   * 타당성 검사에 걸린 이유. 어느 열이 걸렸는지도 함께 남긴다.
   * 한 시료가 여러 항목을 가지므로, BOD 위반을 SS 시트에 띄우면 안 된다.
   */
  warnings: { columns: string[]; text: string }[]
}

/**
 * 여러 문서의 판독 결과를 시료 단위로 합친다.
 *
 * 이름이 문서마다 다르므로 완전히 합쳐지지는 않는다. 공백과 괄호를 지워
 * 같아지는 것만 합치고, 나머지는 각자 남는다. 자동으로 억지로 붙이지 않는다.
 * 짝을 확정하는 것은 사람의 몫이고, 확정한 짝을 기억하는 기능은 아직 없다.
 */
export function collect(results: ReadResult[]): Sample[] {
  const samples: Sample[] = []
  const byKey = new Map<string, Sample>()

  for (const res of results) {
    const template = findTemplate(res.templateId)
    if (!template) continue

    // 타당성에 걸린 줄을 미리 모아둔다. 걸린 값은 엑셀에서 표시해야 한다.
    // 규칙이 어느 열을 봤는지도 함께 남겨서, 그 열을 쓰는 시트에만 띄운다
    const badByRow = new Map<ReadRow, Sample['warnings']>()
    for (const v of checkRules(res.rows, template)) {
      const r = v.rule as { type: string; left?: string; right?: string; column?: string; expr?: string }
      const columns =
        r.type === 'greater'
          ? [r.left!, r.right!]
          : r.type === 'computed'
            ? (r.expr!.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])
            : [r.column!]

      const list = badByRow.get(v.row) ?? []
      list.push({ columns, text: `${v.rule.label}: ${v.detail}` })
      badByRow.set(v.row, list)
    }

    for (const row of res.rows) {
      const name = row.name.trim()
      if (!name) continue
      if (isQc(name, template)) continue // 품질관리 시료는 내보내지 않는다

      const key = normalize(name)
      const found = byKey.get(key)

      // 같은 이름이 한 문서 안에서 여러 번 나올 수 있다.
      // 자동분석기 출력의 "유출" 처럼 지명이 생략된 경우가 그렇다.
      // 합쳐버리면 값이 서로를 덮어쓰므로 별도 행으로 남긴다.
      const warn = badByRow.get(row) ?? []

      if (found && !found.rows.has(res.templateId)) {
        found.rows.set(res.templateId, row)
        found.warnings.push(...warn)
        continue
      }

      const s: Sample = { name, rows: new Map([[res.templateId, row]]), warnings: [...warn] }
      samples.push(s)
      // 같은 이름이 또 오면 이번 것에 붙게 한다. 앞의 것은 이미 채워져 있다
      byKey.set(key, s)
    }
  }

  return samples
}

/** 한 시료에서 layout 이 가리키는 값을 꺼낸다 */
function cellValue(sample: Sample, col: LayoutColumn): string | null {
  if (col.from) {
    const [templateId, key] = col.from.split('.')
    const row = sample.rows.get(templateId!)
    const raw = row?.cells[key!]
    const v = pickNumber(raw)
    if (v !== null) return v
  }
  return col.default ?? null
}

/** 이 시료에 이 항목의 값이 하나라도 있나 */
function hasAny(sample: Sample, item: LayoutItem): boolean {
  return item.columns.some((c) => {
    if (!c.from) return false
    const [templateId, key] = c.from.split('.')
    const row = sample.rows.get(templateId!)
    return pickNumber(row?.cells[key!]) !== null
  })
}

export async function writeWorkbook(results: ReadResult[], outPath: string): Promise<string[]> {
  const samples = collect(results)
  const wb = new ExcelJS.Workbook()
  const written: string[] = []

  for (const item of LAYOUT.items) {
    const rows = samples.filter((s) => hasAny(s, item))
    if (!rows.length) continue

    const ws = wb.addWorksheet(item.item)

    // 어디에 붙여넣는지를 시트 안에 적어둔다. 나중에 열어도 헷갈리지 않게
    ws.addRow([`결과정리 엑셀의 ${item.range} 열에 붙여넣습니다. 시료명 열은 참고용이니 빼고 복사하세요.`])
    ws.getRow(1).font = { size: 9, color: { argb: 'FF888888' } }
    ws.addRow([])

    ws.addRow(['시료명', ...item.columns.map((c) => c.label)])
    const head = ws.getRow(3)
    head.font = { bold: true }
    head.eachCell((c) => {
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEEEEE' } }
    })

    // 이 시트가 쓰는 판독 열들. 이 열을 본 경고만 여기 띄운다
    const used = new Set(item.columns.flatMap((c) => (c.from ? [c.from.split('.')[1]!] : [])))

    let warned = 0
    for (const s of rows) {
      const cells = item.columns.map((c) => {
        const v = cellValue(s, c)
        return v === null ? null : Number(v)
      })
      const r = ws.addRow([s.name, ...cells])

      const mine = s.warnings.filter((w) => w.columns.some((c) => used.has(c)))

      // 걸린 줄은 노랗게 칠하고 이유를 메모로 남긴다.
      // 값을 지우지는 않는다. 판독이 틀렸는지 원래 그런지 도구는 모른다
      if (mine.length) {
        warned++
        r.eachCell((c) => {
          c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3C4' } }
        })
        r.getCell(1).note = mine.map((w) => w.text).join('\n')
      }
    }

    ws.getColumn(1).width = 22
    for (let i = 2; i <= item.columns.length + 1; i++) ws.getColumn(i).width = 11

    written.push(`${item.item} ${rows.length}행${warned ? ` (확인 ${warned})` : ''}`)
  }

  if (!written.length) return []
  await wb.xlsx.writeFile(outPath)
  return written
}
