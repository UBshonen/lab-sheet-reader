/**
 * 판독기 공통 인터페이스.
 *
 * 나머지 코드는 어느 회사 API 를 쓰는지 몰라야 한다.
 * 새 후보를 추가하려면 이 인터페이스를 구현한 파일 하나만 더 만들면 되고,
 * 그러면 같은 스캔본을 여러 곳에 돌려 정확도를 비교하는 일이 설정 한 줄이 된다.
 */
import type { Template } from '../templates/index.js'

/** 판독할 원본 */
export type Source = {
  bytes: Uint8Array
  mimeType: string
}

/** 표 한 줄. 원본 어디서 왔는지를 반드시 함께 남긴다 */
export type ReadRow = {
  /** 문서에 인쇄된 번호. 비연속일 수 있으므로 배열 순서와 다르다 */
  no: string | null
  /** 시료명. 읽은 그대로. 별칭 해석은 나중 단계에서 한다 */
  name: string
  /** 열 이름 → 값. 템플릿의 columns 를 따른다 */
  cells: Record<string, string | null>
}

/** 실제로 얼마나 썼는지. 유료 전환 판단의 근거가 된다 */
export type Usage = {
  inputTokens: number
  outputTokens: number
}

/** 이 문서가 무엇인지 */
export type DetectResult = {
  /** 후보 중 어느 것인지. 못 알아보면 null */
  templateId: string | null
  reason: string
  usage?: Usage
}

export type ReadResult = {
  templateId: string
  rows: ReadRow[]
  /** 모델이 스스로 애매하다고 표시한 것 */
  notes: string[]
  usage?: Usage
}

export interface Reader {
  /** 사람이 읽을 이름. 로그와 비교표에 쓴다 */
  readonly id: string
  /** 후보 목록을 주고 어느 것인지 고르게 한다. 출력이 짧아 값이 거의 안 붙는다 */
  detect(src: Source, candidates: Template[]): Promise<DetectResult>
  /** 고른 템플릿의 지시문으로 정밀 판독한다 */
  read(src: Source, template: Template): Promise<ReadResult>
}
