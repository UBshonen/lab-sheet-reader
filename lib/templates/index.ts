import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * 양식 정의. 코드가 아니라 데이터다.
 *
 * 새 기기가 들어오면 JSON 파일 하나만 추가하면 되고 코드는 건드리지 않는다.
 * 나중에 화면에서 등록할 수 있게 하려고 함수를 넣지 않았다.
 */
export type Template = {
  id: string
  name: string
  /** read = 판독한다, skip = 알아보되 읽지 않는다 (검량선 등) */
  purpose: 'read' | 'skip'
  /** 이 문서를 알아보는 단서. 판별 단계에서 모델에게 보여준다 */
  hint: string
  columns: { key: string; label: string }[]
  /** 판독 지시문. 줄 단위로 적고 합쳐서 쓴다 */
  instruction: string[]
  /** 이 문서의 어느 열이 어느 검사 항목이 되는지 */
  maps: { item: string; from: string }[]
  qc: QcRule[]
}

export type QcRule = {
  /** 시료명이 이 정규식에 걸리면 품질관리 시료로 본다 */
  match: string
  /** null 이면 "품질관리용이니 내보내지 말라"는 표시만 하고 값은 검사하지 않는다 */
  expect: QcExpect | null
  label: string
}

export type QcExpect = {
  /** 이 값 이하여야 한다. 세척수·바탕시료 */
  max?: number
  /** 이 값 근처여야 한다. 표준품 */
  near?: number
  tol?: number
  /** 같은 줄의 다른 열에 적힌 기준값과 맞춰본다. 문서에 정답이 인쇄된 경우 */
  againstColumn?: string
  /** 어느 열을 볼지. 비우면 기본 열 */
  column?: string
}

const here = dirname(fileURLToPath(import.meta.url))

export const TEMPLATES: Template[] = readdirSync(here)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(here, f), 'utf8')) as Template)
  .sort((a, b) => a.id.localeCompare(b.id))

export function findTemplate(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id)
}
