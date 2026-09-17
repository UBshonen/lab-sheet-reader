import { Buffer } from 'node:buffer'
import { finalizeBatch, type BatchMode, type RawBatchRow } from '../../lib/batch-results.js'

type Context = { request: Request }

export async function onRequestPost(context: Context): Promise<Response> {
  try {
    const payload = await context.request.json() as { rawRows?: RawBatchRow[]; mode?: BatchMode }
    const rawRows = Array.isArray(payload.rawRows) ? payload.rawRows : []
    const finalized = await finalizeBatch(rawRows, payload.mode)
    const date = new Date().toISOString().slice(0, 10)
    return Response.json({
      mode: finalized.mode,
      rows: finalized.rows,
      reviewRows: finalized.reviewRows,
      summary: finalized.summary,
      workbookBase64: finalized.workbook ? Buffer.from(finalized.workbook).toString('base64') : null,
      workbookName: finalized.workbook ? `측정망_TN_TP_${date}.xlsx` : null,
    }, { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : '결과를 다시 구성하지 못했습니다.' },
      { status: 500, headers: { 'cache-control': 'no-store' } },
    )
  }
}
