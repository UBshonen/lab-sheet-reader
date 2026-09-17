import { Buffer } from 'node:buffer'
import { createReviewedWorkbook, type ReviewedRow } from '../../lib/batch-results.js'

type Context = { request: Request }

export async function onRequestPost(context: Context): Promise<Response> {
  try {
    const payload = await context.request.json() as { rows?: ReviewedRow[] }
    if (!Array.isArray(payload.rows)) {
      return Response.json({ error: '검토한 시료 정보가 없습니다.' }, { status: 400 })
    }
    const result = await createReviewedWorkbook(payload.rows)
    const date = new Date().toISOString().slice(0, 10)
    return Response.json({
      workbookBase64: Buffer.from(result.buffer).toString('base64'),
      workbookName: `기타시료_TN_TP_${date}.xlsx`,
      rows: result.rows,
    }, { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : '엑셀을 만들지 못했습니다.' },
      { status: 500, headers: { 'cache-control': 'no-store' } },
    )
  }
}
