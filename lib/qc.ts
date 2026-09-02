import type { Template, QcRule } from './templates/index.js'
import type { ReadRow } from './reader/index.js'

/**
 * 품질관리 시료로 정렬이 맞는지 판정한다.
 *
 * 표가 한 줄 밀려 읽히면 모든 값이 엉뚱한 시료에 붙는데, 값 자체는 전부
 * 정상 범위라 어떤 규칙에도 안 걸린다. 가장 위험한 실패다.
 *
 * 그런데 실험 배치에는 답이 정해진 시료가 원래 들어 있다. 세척수는 0 근처,
 * 표준품은 알려진 농도 근처여야 한다. 그 자리 값을 보면 정렬이 맞는지
 * 즉시 판정된다. 성적서도 기록부도 없이 문서 하나로 스스로 확인하는 셈이다.
 */

export type QcVerdict = {
  row: ReadRow
  rule: QcRule
  /** null 이면 값을 검사하지 않는 표시용 규칙 */
  ok: boolean | null
  detail: string
}

export type QcSummary = {
  verdicts: QcVerdict[]
  checked: number
  passed: number
  /** 정렬을 믿어도 되는가 */
  aligned: boolean | null
}

function toNumber(s: string | null | undefined): number | null {
  if (!s) return null
  const m = s.match(/-?[0-9]*\.?[0-9]+/)
  return m ? Number(m[0]) : null
}

/** 템플릿의 기본 값 열. maps 의 첫 항목이 가리키는 열을 쓴다 */
function defaultColumn(t: Template): string {
  return t.maps[0]?.from ?? t.columns[0]?.key ?? ''
}

export function checkQc(rows: ReadRow[], template: Template): QcSummary {
  const verdicts: QcVerdict[] = []

  for (const row of rows) {
    const name = row.name.trim()
    const rule = template.qc.find((q) => new RegExp(q.match).test(name))
    if (!rule) continue

    if (!rule.expect) {
      verdicts.push({ row, rule, ok: null, detail: '값 검사 없음' })
      continue
    }

    const e = rule.expect
    const col = e.column ?? defaultColumn(template)
    const value = toNumber(row.cells[col])

    if (value === null) {
      verdicts.push({ row, rule, ok: false, detail: '값을 못 읽음' })
      continue
    }

    if (e.againstColumn !== undefined) {
      // 문서에 정답이 인쇄된 경우. 측정값과 기준값을 맞춰본다
      const target = toNumber(row.cells[e.againstColumn])
      if (target === null) {
        verdicts.push({ row, rule, ok: null, detail: '기준값 없음' })
        continue
      }
      // 기준 대비 15% 안이면 통과. 표준품은 이 정도 오차가 정상이다
      const ok = Math.abs(value - target) <= Math.max(Math.abs(target) * 0.15, 0.05)
      verdicts.push({ row, rule, ok, detail: `${value} vs 기준 ${target}` })
      continue
    }

    if (e.max !== undefined) {
      verdicts.push({ row, rule, ok: value <= e.max, detail: `${value} ≤ ${e.max}` })
      continue
    }

    if (e.near !== undefined) {
      const tol = e.tol ?? 0
      verdicts.push({
        row,
        rule,
        ok: Math.abs(value - e.near) <= tol,
        detail: `${value} ≈ ${e.near}±${tol}`,
      })
      continue
    }

    verdicts.push({ row, rule, ok: null, detail: '검사 규칙 없음' })
  }

  const checkable = verdicts.filter((v) => v.ok !== null)
  const passed = checkable.filter((v) => v.ok).length

  return {
    verdicts,
    checked: checkable.length,
    passed,
    aligned: checkable.length === 0 ? null : passed === checkable.length,
  }
}

/** 품질관리 시료인가. 내보내기에서 빼야 한다 */
export function isQc(name: string, template: Template): boolean {
  return template.qc.some((q) => new RegExp(q.match).test(name.trim()))
}
