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
  /**
   * 확신이 서지 않는 칸의 열 이름들.
   * 모델이 스스로 신고한 것이라, 값은 넣되 사람이 봐야 한다는 표시다.
   */
  uncertain?: string[]
  /** T-N·T-P 결과표에서 AI가 제안한 시료 묶음. 최종 확정은 사용자가 한다. */
  suggestedNo?: string | null
  suggestedName?: string | null
  sampleKind?: 'dissolved' | 'total' | 'control' | 'unknown'
  matchReason?: string | null
}

/** 실제로 얼마나 썼는지. 유료 전환 판단의 근거가 된다 */
export type Usage = {
  inputTokens: number
  /** 답 + 생각. 과금 기준 */
  outputTokens: number
  /** 실제 답만 */
  answerTokens?: number
  /** 생각. 이게 크면 느리다 */
  thinkingTokens?: number
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
