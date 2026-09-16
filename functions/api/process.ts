import { Buffer } from 'node:buffer'
import { GoogleGenAI } from '@google/genai'
import { buildNetworkRows, createNetworkWorkbook, type NamedReadResult } from '../../lib/network-results.js'
import type { ReadResult } from '../../lib/reader/index.js'

type Env = {
  GEMINI_API_KEY?: string
  GEMINI_MODEL?: string
}

type Context = {
  request: Request
  env: Env
}

type UploadFile = {
  name: string
  mimeType: string
  data: string
}

type ModelRow = {
  no: string | null
  name: string
  tn: string | null
  tp: string | null
  uncertain?: string[]
}

type ModelAnswer = {
  documentType: 'result' | 'calibration' | 'other'
  reason: string
  rows: ModelRow[]
  notes: string[]
}

const MAX_FILES = 20
const MAX_BASE64_LENGTH = 20 * 1024 * 1024
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    documentType: { type: 'string', enum: ['result', 'calibration', 'other'] },
    reason: { type: 'string' },
    rows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          no: { type: 'string', nullable: true },
          name: { type: 'string' },
          tn: { type: 'string', nullable: true },
          tp: { type: 'string', nullable: true },
          uncertain: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'tn', 'tp'],
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['documentType', 'reason', 'rows', 'notes'],
}

const PROMPT = `
이 사진 또는 PDF가 자동분석기 T-N·T-P 문서인지 판별하고 필요한 표를 읽어라.

PDF는 여러 페이지일 수 있고 결과표와 검량선이 한 파일에 함께 들어 있을 수 있다.
- 결과표 페이지가 하나라도 있으면 documentType은 result로 정하고 결과표 페이지의 행만 모두 읽어라.
- 결과표 없이 검량선 페이지만 있으면 calibration으로 정하라.
- 검량선 페이지의 그래프·OD 값은 rows에 넣지 마라.
- reason에는 전체 페이지 중 결과표와 검량선이 각각 몇 페이지인지 적어라.

문서 종류:
- result: 제목에 All Methods가 있고 표 머리가 Order / SID 또는 SIDNeedle 1 / T-NOD / T-N / T-POD / T-P인 결과표
- calibration: 제목에 Calibration과 T-N 또는 T-P가 있고 검량선 그래프가 있는 문서
- other: 위 둘이 아닌 문서

result일 때만 표의 모든 행을 위에서 아래 순서 그대로 읽어라.
- no: Order 칸. 비연속이어도 보이는 번호 그대로
- name: SID 또는 SIDNeedle 1 칸. 공백을 포함해 보이는 그대로
- tn: T-N 칸의 값. T-NOD를 읽지 마라
- tp: T-P 칸의 값. T-POD를 읽지 마라
- uncertain: 글씨가 흐려 확인이 필요한 값의 키. T-N이면 "tn", T-P이면 "tp"

1DTNP와 1처럼 두 행이 한 시료여도 여기서 합치지 말고 각각 별도 행으로 읽어라.
STD, W, B, RE-ST 행도 생략하지 말고 모두 읽어라.
calibration이나 other이면 rows는 빈 배열로 두어라.
읽을 수 없는 값은 null로 두고 숫자를 추측하거나 수정하지 마라.
`.trim()

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function asReadResult(answer: ModelAnswer): ReadResult {
  return {
    templateId: 'tntp-result',
    notes: answer.notes ?? [],
    rows: answer.rows.map((row) => ({
      no: row.no,
      name: row.name,
      cells: { tn: row.tn, tp: row.tp, tnTarget: null, tpTarget: null },
      uncertain: row.uncertain ?? [],
    })),
  }
}

async function analyze(ai: GoogleGenAI, model: string, file: UploadFile): Promise<ModelAnswer> {
  const result = await ai.models.generateContent({
    model,
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: file.mimeType, data: file.data } },
          { text: PROMPT },
        ],
      },
    ],
    config: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA as never,
      temperature: 0,
      thinkingConfig: { thinkingLevel: 'LOW' as never },
    },
  })
  if (!result.text) throw new Error(`${file.name}: AI 응답이 비어 있습니다.`)
  return JSON.parse(result.text) as ModelAnswer
}

export async function onRequestPost(context: Context): Promise<Response> {
  try {
    const key = context.env.GEMINI_API_KEY?.trim()
    if (!key) return response({ error: 'Cloudflare에 GEMINI_API_KEY Secret이 설정되지 않았습니다.' }, 500)

    const payload = await context.request.json() as { files?: UploadFile[] }
    const files = payload.files ?? []
    if (!files.length) return response({ error: '처리할 파일을 선택해주세요.' }, 400)
    if (files.length > MAX_FILES) return response({ error: `한 번에 ${MAX_FILES}개 파일까지 처리할 수 있습니다.` }, 400)

    const model = context.env.GEMINI_MODEL?.trim() || 'gemini-3.6-flash'
    const ai = new GoogleGenAI({ apiKey: key })
    const readResults: NamedReadResult[] = []
    const processed: Array<{
      name: string
      status: 'read' | 'skip' | 'unknown'
      document: string
      reason: string
      rows: number
    }> = []

    // 무료 API 한도와 재시도 폭주를 피하려고 한 장씩 처리한다.
    for (const file of files) {
      if (!file.name || !ALLOWED_MIME.has(file.mimeType)) {
        processed.push({
          name: file.name || '이름 없는 파일',
          status: 'unknown',
          document: '지원하지 않는 파일',
          reason: 'JPG, PNG, WebP, PDF만 사용할 수 있습니다.',
          rows: 0,
        })
        continue
      }
      if (!file.data || file.data.length > MAX_BASE64_LENGTH) {
        processed.push({
          name: file.name,
          status: 'unknown',
          document: '파일 용량 초과',
          reason: '한 파일의 전송 크기는 15MB 이하여야 합니다.',
          rows: 0,
        })
        continue
      }

      const answer = await analyze(ai, model, file)
      if (answer.documentType === 'result') {
        readResults.push({ fileName: file.name, result: asReadResult(answer) })
        processed.push({
          name: file.name,
          status: 'read',
          document: '자동분석기 T-N · T-P 결과표',
          reason: answer.reason || '판독 완료',
          rows: answer.rows.length,
        })
      } else if (answer.documentType === 'calibration') {
        processed.push({
          name: file.name,
          status: 'skip',
          document: '자동분석기 검량선',
          reason: '측정값 엑셀에 필요하지 않은 문서입니다.',
          rows: 0,
        })
      } else {
        processed.push({
          name: file.name,
          status: 'unknown',
          document: '알 수 없는 문서',
          reason: answer.reason || 'T-N·T-P 결과표가 아닙니다.',
          rows: 0,
        })
      }
    }

    const rows = buildNetworkRows(readResults)
    const workbook = await createNetworkWorkbook(rows)
    const now = new Date()
    const date = [now.getUTCFullYear(), String(now.getUTCMonth() + 1).padStart(2, '0'), String(now.getUTCDate()).padStart(2, '0')].join('-')

    return response({
      model,
      files: processed,
      rows,
      summary: {
        readFiles: processed.filter((file) => file.status === 'read').length,
        skippedFiles: processed.filter((file) => file.status === 'skip').length,
        unknownFiles: processed.filter((file) => file.status === 'unknown').length,
        completeSamples: rows.filter((row) => row.dtn !== null && row.tn !== null && row.dtp !== null && row.tp !== null).length,
        warningSamples: rows.filter((row) => row.warnings.length > 0).length,
      },
      workbookBase64: Buffer.from(workbook).toString('base64'),
      workbookName: `측정망_TN_TP_${date}.xlsx`,
    })
  } catch (error) {
    console.error(error)
    return response({ error: error instanceof Error ? error.message : '처리 중 오류가 발생했습니다.' }, 500)
  }
}
