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
].join('\n')

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
      // 생각하는 토큰도 과금되므로 함께 센다
      outputTokens: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0),
    }
  }

  async #call(src: Source, prompt: string, schema: unknown) {
    const res = await this.#ai.models.generateContent({
      model: this.#model,
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: src.mimeType, data: Buffer.from(src.bytes).toString('base64') } },
            { text: prompt },
          ],
        },
      ],
      config: { responseMimeType: 'application/json', responseSchema: schema as never, temperature: 0 },
    })
    if (!res.text) throw new Error('응답이 비어 있습니다')
    return { text: res.text, usage: this.#usage(res.usageMetadata) }
  }

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

    const { text, usage } = await this.#call(src, prompt, DETECT_SCHEMA)
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

    const { text, usage } = await this.#call(src, prompt, readSchema(template))
    const parsed = JSON.parse(text) as { rows: ReadResult['rows']; notes: string[] }

    return { templateId: template.id, rows: parsed.rows, notes: parsed.notes ?? [], usage }
  }
}
