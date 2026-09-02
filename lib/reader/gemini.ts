import { GoogleGenAI } from '@google/genai'
import type { Reader, ReadRequest, ReadResult } from './index.js'

/**
 * 응답을 정해둔 모양으로만 나오게 강제한다.
 * 이렇게 하지 않으면 설명 문장이 섞여 나와 파싱이 흔들린다.
 */
const SCHEMA = {
  type: 'object',
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          no: { type: 'string', nullable: true },
          name: { type: 'string' },
          cells: {
            type: 'object',
            properties: {
              dilu: { type: 'string', nullable: true },
              result: { type: 'string', nullable: true },
            },
          },
        },
        required: ['name', 'cells'],
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['rows', 'notes'],
}

export class GeminiReader implements Reader {
  readonly id: string
  #ai: GoogleGenAI
  #model: string

  constructor(apiKey: string, model = 'gemini-3.6-flash') {
    this.#ai = new GoogleGenAI({ apiKey })
    this.#model = model
    this.id = `gemini:${model}`
  }

  async read(req: ReadRequest): Promise<ReadResult> {
    const res = await this.#ai.models.generateContent({
      model: this.#model,
      contents: [
        {
          role: 'user',
          parts: [
            {
              inlineData: {
                mimeType: req.mimeType,
                data: Buffer.from(req.bytes).toString('base64'),
              },
            },
            { text: req.instruction },
          ],
        },
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: SCHEMA as never,
        temperature: 0,
      },
    })

    const raw = res.text
    if (!raw) throw new Error('응답이 비어 있습니다')

    const parsed = JSON.parse(raw) as {
      rows: ReadResult['rows']
      notes: string[]
    }

    const u = res.usageMetadata
    return {
      templateId: 'toc-result',
      rows: parsed.rows,
      notes: parsed.notes,
      usage: {
        inputTokens: u?.promptTokenCount ?? 0,
        // 생각하는 토큰도 과금되므로 함께 센다
        outputTokens: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0),
      },
    }
  }
}
