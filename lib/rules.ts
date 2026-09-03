import type { Template } from './templates/index.js'
import type { ReadRow } from './reader/index.js'

/**
 * 정답지 없이 값의 타당성을 본다.
 *
 * 손글씨 일지에는 품질관리 시료가 없어 정렬을 검증할 근거가 없다.
 * 대신 물리 제약이 있다. 용존산소는 배양하면 줄고, 여지는 부유물이
 * 쌓이면 무거워진다. 이 방향이 뒤집히면 잘못 읽은 것이다.
 *
 * 이것으로 "이 값이 맞는가" 는 알 수 없다. "이 값이 가능한가" 만 안다.
 * 8.97 을 89.7 로 읽으면 걸리지만 8.91 로 읽으면 안 걸린다.
 * 원리상 못 잡는 것이 남으므로, 걸리지 않았다고 맞다고 말하면 안 된다.
 */

export type Rule =
  /** left 가 right 보다 커야 한다 */
  | { type: 'greater'; left: string; right: string; label: string }
  /** 값이 범위 안이어야 한다 */
  | { type: 'range'; column: string; min?: number; max?: number; label: string }
  /** 정해진 값 중 하나여야 한다 */
  | { type: 'oneOf'; column: string; values: string[]; label: string }
  /** 계산 결과가 범위 안이어야 한다. expr 은 열 이름과 + - * / ( ) 만 쓴다 */
  | { type: 'computed'; expr: string; min?: number; max?: number; label: string }

export type Violation = {
  row: ReadRow
  rule: Rule
  detail: string
}

function num(s: string | null | undefined): number | null {
  if (s === null || s === undefined) return null
  const m = String(s).match(/-?[0-9]*\.?[0-9]+/)
  return m ? Number(m[0]) : null
}

/**
 * 열 이름과 사칙연산만 허용하는 작은 계산기.
 * eval 을 쓰지 않는다. 템플릿은 나중에 화면에서 사용자가 만들 것이므로
 * 거기 적힌 문자열이 코드로 실행되면 안 된다.
 */
function evaluate(expr: string, cells: Record<string, string | null>): number | null {
  const tokens = expr.match(/[A-Za-z_][A-Za-z0-9_]*|[0-9]*\.?[0-9]+|[-+*/()]/g)
  if (!tokens) return null

  let i = 0
  const peek = () => tokens[i]
  const take = () => tokens[i++]

  // 항 = 인자 (* 또는 / 인자)*
  // 식 = 항 (+ 또는 - 항)*
  function factor(): number | null {
    const t = take()
    if (t === undefined) return null
    if (t === '(') {
      const v = expression()
      if (peek() === ')') take()
      return v
    }
    if (t === '-') {
      const v = factor()
      return v === null ? null : -v
    }
    if (/^[A-Za-z_]/.test(t)) return num(cells[t])
    const n = Number(t)
    return Number.isFinite(n) ? n : null
  }

  function term(): number | null {
    let v = factor()
    while (v !== null && (peek() === '*' || peek() === '/')) {
      const op = take()
      const r = factor()
      if (r === null) return null
      if (op === '/' && r === 0) return null
      v = op === '*' ? v * r : v / r
    }
    return v
  }

  function expression(): number | null {
    let v = term()
    while (v !== null && (peek() === '+' || peek() === '-')) {
      const op = take()
      const r = term()
      if (r === null) return null
      v = op === '+' ? v + r : v - r
    }
    return v
  }

  const result = expression()
  return result !== null && Number.isFinite(result) ? result : null
}

const round = (n: number) => Math.round(n * 1000) / 1000

/** 값이 비어 있는 줄은 건너뛴다. 검사하지 않은 시료라 위반이 아니다 */
function isEmpty(row: ReadRow): boolean {
  return Object.values(row.cells).every((v) => v === null || v === '' || v === '-')
}

export function checkRules(rows: ReadRow[], template: Template): Violation[] {
  const rules = (template.rules ?? []) as Rule[]
  if (!rules.length) return []

  const out: Violation[] = []

  for (const row of rows) {
    if (isEmpty(row)) continue

    for (const rule of rules) {
      switch (rule.type) {
        case 'greater': {
          const l = num(row.cells[rule.left])
          const r = num(row.cells[rule.right])
          if (l === null || r === null) break
          if (!(l > r)) out.push({ row, rule, detail: `${l} 이 ${r} 보다 크지 않다` })
          break
        }
        case 'range': {
          const v = num(row.cells[rule.column])
          if (v === null) break
          if (rule.min !== undefined && v < rule.min) out.push({ row, rule, detail: `${v} < ${rule.min}` })
          else if (rule.max !== undefined && v > rule.max) out.push({ row, rule, detail: `${v} > ${rule.max}` })
          break
        }
        case 'oneOf': {
          const raw = row.cells[rule.column]
          if (raw === null || raw === '') break
          const v = num(raw)
          const ok = rule.values.some((x) => num(x) === v)
          if (!ok) out.push({ row, rule, detail: `${raw} 는 ${rule.values.join(' · ')} 중에 없다` })
          break
        }
        case 'computed': {
          const v = evaluate(rule.expr, row.cells)
          if (v === null) break
          if (rule.min !== undefined && v < rule.min) out.push({ row, rule, detail: `${round(v)} < ${rule.min}` })
          else if (rule.max !== undefined && v > rule.max) out.push({ row, rule, detail: `${round(v)} > ${rule.max}` })
          break
        }
      }
    }
  }

  return out
}
