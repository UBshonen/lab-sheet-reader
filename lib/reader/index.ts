/**
 * 판독기 공통 인터페이스.
 *
 * 나머지 코드는 어느 회사 API 를 쓰는지 몰라야 한다.
 * 새 후보를 추가하려면 이 인터페이스를 구현한 파일 하나만 더 만들면 되고,
 * 그러면 같은 스캔본을 여러 곳에 돌려 정확도를 비교하는 일이 설정 한 줄이 된다.
 */

/** 표 한 줄. 원본 어디서 왔는지를 반드시 함께 남긴다. */
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

export type ReadResult = {
  /** 어떤 템플릿으로 읽었는지 */
  templateId: string
  rows: ReadRow[]
  /** 모델이 스스로 애매하다고 표시한 것 */
  notes: string[]
  usage?: Usage
}

export type ReadRequest = {
  /** PDF 또는 이미지 파일의 바이트 */
  bytes: Uint8Array
  mimeType: string
  /** 몇 쪽만 읽을지. 비우면 전체 */
  pages?: number[]
  /** 어떤 열을 뽑을지 알려주는 지시문 */
  instruction: string
}

export interface Reader {
  /** 사람이 읽을 이름. 로그와 비교표에 쓴다 */
  readonly id: string
  read(req: ReadRequest): Promise<ReadResult>
}
