import { GoogleGenAI } from '@google/genai'
import type { Reader, Source, DetectResult, ReadResult, Usage } from './index.js'
import type { Template } from '../templates/index.js'

/** 응답을 정해둔 모양으로만 나오게 강제한다. 안 하면 설명 문장이 섞여 파싱이 흔들린다 */
const DETECT_SCHEMA = {
  type: 'object',
  properties: {
    templateId: { type: 'string', nullable: true },
    reason: { type: 'string' },
  },
  required: ['templateId', 'reason'],
}

function readSchema(t: Template) {
  const cellProps: Record<string, unknown> = {}
  for (const c of t.columns) cellProps[c.key] = { type: 'string', nullable: true }

  return {
    type: 'object',
    properties: {
      rows: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            no: { type: 'string', nullable: true },
            name: { type: 'string' },
            cells: { type: 'object', properties: cellProps },
            uncertain: { type: 'array', items: { type: 'string' } },
          },
          required: ['name', 'cells'],
        },
      },
      notes: { type: 'array', items: { type: 'string' } },
    },
    required: ['rows', 'notes'],
  }
}

const COMMON_RULES = [
  '',
  '지켜야 할 것:',
  '  - 번호는 비연속일 수 있다. 순서를 임의로 메우지 마라',
  '  - 읽을 수 없는 칸은 null 로 두어라. 그럴듯한 값을 지어내지 마라',
  '  - 값이 어느 줄에 속하는지 애매하면 notes 에 그 줄 번호와 이유를 적어라',
  '  - 시료명을 해석하거나 고치지 마라. 보이는 글자 그대로 적어라',
  '  - 글씨가 흐리거나 두 값 사이에서 헷갈리는 칸이 있으면,',
  '    그 줄의 uncertain 에 열 이름을 적어라. 예: ["d1", "w2"]',
  '    값은 그래도 가장 그럴듯한 것으로 채워라. 비우지 마라',
].join('\n')

/**
 * 생각 수준. MINIMAL · LOW · MEDIUM · HIGH.
 * 손글씨 판독에서 생각 토큰이 답보다 네 배 넘게 나와 시간을 다 먹었다.
 * 같은 사진으로 재보니 기본값은 3분 34초에 출력 12,211 토큰,
 * LOW 는 1분 32초에 2,625 토큰이었고 결과는 같았다.
 * 표를 읽는 일은 추론이 아니라 보고 옮기는 일이라 생각이 별로 필요 없다.
 * 그래서 LOW 를 기본으로 둔다.
 */
const THINKING = process.env.GEMINI_THINKING?.trim() || 'LOW'

export class GeminiReader implements Reader {
  readonly id: string
  #ai: GoogleGenAI
  #model: string

  constructor(apiKey: string, model = 'gemini-3.6-flash') {
    this.#ai = new GoogleGenAI({ apiKey })
    this.#model = model
    this.id = `gemini:${model}`
  }

  #usage(u: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number } | undefined): Usage {
    return {
      inputTokens: u?.promptTokenCount ?? 0,
      // 생각하는 토큰도 과금되므로 함께 센다. 다만 따로도 남긴다.
      // 생각이 답보다 훨씬 클 때가 있고, 그게 곧 느린 이유다
      outputTokens: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0),
      answerTokens: u?.candidatesTokenCount ?? 0,
      thinkingTokens: u?.thoughtsTokenCount ?? 0,
    }
  }

  /**
   * 잠깐 뒤에 다시 하면 되는 실패인가.
   *
   * 503 은 모델이 붐빈다는 뜻이고 429 는 분당 한도를 넘겼다는 뜻이다.
   * 무료 티어는 우선순위가 낮아 둘 다 자주 겪는다. 네트워크가 끊긴 것도
   * 대개 일시적이다. 반면 400 · 401 · 404 는 다시 해도 똑같으니 바로 포기한다.
   */
  #retryable(e: unknown): boolean {
    const s = e instanceof Error ? e.message : String(e)
    return /\b(429|500|502|503|504)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|fetch failed|ECONNRESET|ETIMEDOUT/i.test(s)
  }

  async #call(src: Source, prompt: string, schema: unknown, onWait?: (sec: number, tries: number) => void) {
    const data = Buffer.from(src.bytes).toString('base64')
    let lastError: unknown

    // 2초 · 6초 · 14초. 붐비는 건 대개 이 안에 풀린다
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) {
        const wait = 2 * 2 ** attempt - 2
        onWait?.(wait, attempt)
        await new Promise((r) => setTimeout(r, wait * 1000))
      }
      try {
        const res = await this.#ai.models.generateContent({
          model: this.#model,
          contents: [
            { role: 'user', parts: [{ inlineData: { mimeType: src.mimeType, data } }, { text: prompt }] },
          ],
          config: {
            responseMimeType: 'application/json',
            responseSchema: schema as never,
            temperature: 0,
            ...(THINKING ? { thinkingConfig: { thinkingLevel: THINKING as never } } : {}),
          },
        })
        if (!res.text) throw new Error('응답이 비어 있습니다')
        return { text: res.text, usage: this.#usage(res.usageMetadata) }
      } catch (e) {
        lastError = e
        if (!this.#retryable(e)) throw e
      }
    }
    throw lastError
  }

  /** 재시도할 때 알려준다. 기다리는 동안 화면이 멈춘 것처럼 보이지 않게 */
  onRetry?: (sec: number, tries: number) => void

  async detect(src: Source, candidates: Template[]): Promise<DetectResult> {
    const list = candidates.map((t) => `  ${t.id}\n    ${t.name} — ${t.hint}`).join('\n')

    const prompt = [
      '이 문서가 아래 후보 중 어느 것인지 고르라.',
      '',
      list,
      '',
      '어느 것에도 확실히 맞지 않으면 templateId 를 null 로 두어라.',
      '비슷해 보인다고 억지로 고르지 마라. 틀린 규칙으로 읽으면 조용히 잘못된 값이 나온다.',
      'reason 에는 무엇을 보고 그렇게 판단했는지 한 문장으로 적어라.',
    ].join('\n')

    const { text, usage } = await this.#call(src, prompt, DETECT_SCHEMA, this.onRetry)
    const parsed = JSON.parse(text) as { templateId: string | null; reason: string }

    // 모델이 없는 id 를 지어냈을 수 있다
    const valid = parsed.templateId && candidates.some((t) => t.id === parsed.templateId)
    return {
      templateId: valid ? parsed.templateId : null,
      reason: valid ? parsed.reason : `알 수 없는 응답: ${parsed.templateId ?? 'null'} — ${parsed.reason}`,
      usage,
    }
  }

  async read(src: Source, template: Template): Promise<ReadResult> {
    const prompt = [
      `이 문서는 "${template.name}" 이다.`,
      ...template.instruction,
      COMMON_RULES,
    ].join('\n')

    const { text, usage } = await this.#call(src, prompt, readSchema(template), this.onRetry)
    const parsed = JSON.parse(text) as { rows: ReadResult['rows']; notes: string[] }

    return { templateId: template.id, rows: parsed.rows, notes: parsed.notes ?? [], usage }
  }
}
