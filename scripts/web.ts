import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { config } from 'dotenv'

config({ path: ['.env.local', '.env'], quiet: true })

import { GeminiReader } from '../lib/reader/gemini.js'
import type { DetectResult, ReadResult, Source } from '../lib/reader/index.js'
import { TEMPLATES, findTemplate } from '../lib/templates/index.js'
import { prepare } from '../lib/image.js'
import { buildNetworkRows, createNetworkWorkbook, type NamedReadResult } from '../lib/network-results.js'

const PORT = Number(process.env.PORT || 3000)
const PUBLIC_DIR = join(process.cwd(), 'web')
const CACHE_DIR = join(process.cwd(), '.cache', 'web')
const MAX_BODY = 80 * 1024 * 1024
const MAX_FILES = 20
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])

type UploadFile = {
  name: string
  mimeType: string
  data: string
}

type ProcessedFile = {
  name: string
  status: 'read' | 'skip' | 'unknown'
  document: string
  reason: string
  rows: number
}

function json(response: ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_BODY) throw new Error('파일 용량이 너무 큽니다. 한 번에 80MB까지 처리할 수 있습니다.')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

function cacheKey(bytes: Uint8Array, model: string, step: string) {
  return createHash('sha256').update(bytes).update(model).update(step).digest('hex').slice(0, 20)
}

async function cached<T>(path: string, make: () => Promise<T>): Promise<T> {
  if (existsSync(path)) return JSON.parse(await readFile(path, 'utf8')) as T
  const value = await make()
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8')
  return value
}

async function processUploads(files: UploadFile[]) {
  const apiKey = process.env.GEMINI_API_KEY?.trim()
  if (!apiKey) throw new Error('.env.local에 GEMINI_API_KEY가 없습니다.')
  if (!Array.isArray(files) || files.length === 0) throw new Error('처리할 파일을 선택해주세요.')
  if (files.length > MAX_FILES) throw new Error(`한 번에 ${MAX_FILES}개 파일까지 처리할 수 있습니다.`)

  const model = process.env.GEMINI_MODEL?.trim() || 'gemini-3.6-flash'
  const reader = new GeminiReader(apiKey, model)
  await mkdir(CACHE_DIR, { recursive: true })

  const readResults: NamedReadResult[] = []
  const processed: ProcessedFile[] = []

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

    const raw = Buffer.from(file.data, 'base64')
    if (!raw.length) {
      processed.push({
        name: file.name,
        status: 'unknown',
        document: '빈 파일',
        reason: '파일 내용을 읽을 수 없습니다.',
        rows: 0,
      })
      continue
    }

    const prepared = await prepare(new Uint8Array(raw), file.mimeType)
    const source: Source = { bytes: prepared.bytes, mimeType: prepared.mimeType }
    const detectPath = join(CACHE_DIR, `${cacheKey(raw, model, 'detect')}.detect.json`)
    const detected = await cached<DetectResult>(detectPath, () => reader.detect(source, TEMPLATES))
    const template = detected.templateId ? findTemplate(detected.templateId) : undefined

    if (!template) {
      processed.push({
        name: file.name,
        status: 'unknown',
        document: '알 수 없는 문서',
        reason: detected.reason,
        rows: 0,
      })
      continue
    }

    if (template.purpose === 'skip' || template.id !== 'tntp-result') {
      processed.push({
        name: file.name,
        status: 'skip',
        document: template.name,
        reason: template.purpose === 'skip' ? '측정값 엑셀에 필요하지 않은 문서입니다.' : 'T-N·T-P 결과표가 아닙니다.',
        rows: 0,
      })
      continue
    }

    const readPath = join(CACHE_DIR, `${cacheKey(raw, model, `read:${template.id}`)}.read.json`)
    const result = await cached<ReadResult>(readPath, () => reader.read(source, template))
    readResults.push({ fileName: file.name, result })
    processed.push({
      name: file.name,
      status: 'read',
      document: template.name,
      reason: prepared.note ? `판독 완료 · ${prepared.note}` : '판독 완료',
      rows: result.rows.length,
    })
  }

  const rows = buildNetworkRows(readResults)
  const workbook = await createNetworkWorkbook(rows)
  const now = new Date()
  const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-')

  return {
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
    workbookBase64: workbook.toString('base64'),
    workbookName: `측정망_TN_TP_${date}.xlsx`,
  }
}

const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `localhost:${PORT}`}`)

    if (request.method === 'POST' && url.pathname === '/api/process') {
      const payload = JSON.parse((await body(request)).toString('utf8')) as { files?: UploadFile[] }
      const result = await processUploads(payload.files ?? [])
      json(response, 200, result)
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/health') {
      json(response, 200, { ok: true, apiKeyConfigured: Boolean(process.env.GEMINI_API_KEY?.trim()) })
      return
    }

    const asset = request.method === 'GET' ? STATIC[url.pathname] : undefined
    if (asset) {
      const content = await readFile(join(PUBLIC_DIR, asset.file))
      response.writeHead(200, { 'content-type': asset.type, 'content-length': content.length })
      response.end(content)
      return
    }

    json(response, 404, { error: '페이지를 찾을 수 없습니다.' })
  } catch (error) {
    console.error(error)
    json(response, 500, { error: error instanceof Error ? error.message : '처리 중 오류가 발생했습니다.' })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Lab Sheet Reader  http://localhost:${PORT}`)
})
