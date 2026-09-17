const input = document.querySelector('#fileInput')
const dropzone = document.querySelector('#dropzone')
const selectedArea = document.querySelector('#selectedArea')
const fileList = document.querySelector('#fileList')
const fileCount = document.querySelector('#fileCount')
const totalSize = document.querySelector('#totalSize')
const clearButton = document.querySelector('#clearButton')
const processButton = document.querySelector('#processButton')
const processButtonLabel = processButton.querySelector('span')
const progressCard = document.querySelector('#progressCard')
const errorCard = document.querySelector('#errorCard')
const errorMessage = document.querySelector('#errorMessage')
const results = document.querySelector('#results')
const resultBody = document.querySelector('#resultBody')
const documentList = document.querySelector('#documentList')
const downloadButton = document.querySelector('#downloadButton')
const reviewResults = document.querySelector('#reviewResults')
const reviewBody = document.querySelector('#reviewBody')
const reviewDocumentList = document.querySelector('#reviewDocumentList')
const reviewExportButton = document.querySelector('#reviewExportButton')
const reviewConfirm = document.querySelector('#reviewConfirm')
const retryCard = document.querySelector('#retryCard')
const retryTitle = document.querySelector('#retryTitle')
const retryButton = document.querySelector('#retryButton')
const failedMessage = document.querySelector('#failedMessage')
const connection = document.querySelector('#connection')
const batchMode = document.querySelector('#batchMode')
const networkTab = document.querySelector('#networkTab')
const reviewTab = document.querySelector('#reviewTab')
const workflowTitle = document.querySelector('#workflowTitle')
const workflowDescription = document.querySelector('#workflowDescription')

let files = []
let workbook = null
let reviewRows = []
let analysis = { rawRows: [], documents: [] }

const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
const maxFileBytes = 15 * 1024 * 1024
const maxTotalBytes = 50 * 1024 * 1024

function fileId(file) {
  return `${file.name}:${file.size}:${file.lastModified}`
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function extension(name) {
  return name.split('.').pop()?.slice(0, 4) || 'file'
}

function addFiles(next) {
  const rejected = []
  for (const file of next) {
    if (!allowed.has(file.type)) continue
    if (file.size > maxFileBytes) {
      rejected.push(file.name)
      continue
    }
    if (!files.some((item) => fileId(item) === fileId(file))) files.push(file)
  }
  files = files.slice(0, 20)
  renderFiles()
  if (rejected.length) showError(`파일당 15MB 이하만 사용할 수 있습니다: ${rejected.join(', ')}`)
}

function clearAnalysis() {
  analysis = { rawRows: [], documents: [] }
  reviewRows = []
  reviewConfirm.checked = false
  workbook = null
  results.classList.add('hidden')
  reviewResults.classList.add('hidden')
  retryCard.classList.add('hidden')
}

function renderFiles() {
  fileList.replaceChildren()
  files.forEach((file, index) => {
    const item = document.createElement('li')
    item.className = 'file-item'
    const icon = document.createElement('span')
    icon.className = 'file-icon'
    icon.textContent = extension(file.name)
    const meta = document.createElement('div')
    meta.className = 'file-meta'
    const name = document.createElement('strong')
    name.textContent = file.name
    const size = document.createElement('span')
    size.textContent = formatBytes(file.size)
    meta.append(name, size)
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'remove-file'
    remove.setAttribute('aria-label', `${file.name} 삭제`)
    remove.textContent = '×'
    remove.addEventListener('click', () => {
      files.splice(index, 1)
      clearAnalysis()
      renderFiles()
    })
    item.append(icon, meta, remove)
    fileList.append(item)
  })
  const hasFiles = files.length > 0
  selectedArea.classList.toggle('hidden', !hasFiles)
  processButton.disabled = !hasFiles
  const processedIds = new Set(analysis.documents.map((document) => document.id))
  processButtonLabel.textContent = analysis.documents.length && files.some((file) => !processedIds.has(fileId(file)))
    ? '새 파일을 기존 결과에 추가'
    : '판독하고 결과 확인'
  fileCount.textContent = String(files.length)
  totalSize.textContent = `총 ${formatBytes(files.reduce((sum, file) => sum + file.size, 0))}`
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  return btoa(binary)
}

async function prepareUpload(file) {
  if (!file.type.startsWith('image/') || file.size < 1_200_000) return { mimeType: file.type, data: await blobToBase64(file) }
  const image = await createImageBitmap(file, { imageOrientation: 'from-image' })
  const scale = Math.min(1, 2048 / Math.max(image.width, image.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.width * scale))
  canvas.height = Math.max(1, Math.round(image.height * scale))
  const context = canvas.getContext('2d')
  if (!context) throw new Error(`${file.name}: 이미지를 줄일 수 없습니다.`)
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  image.close()
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error(`${file.name}: 이미지를 변환할 수 없습니다.`)), 'image/jpeg', 0.88)
  })
  return { mimeType: 'image/jpeg', data: await blobToBase64(blob) }
}

function setBusy(busy) {
  processButton.disabled = busy || files.length === 0
  clearButton.disabled = busy
  input.disabled = busy
  batchMode.disabled = busy
  networkTab.disabled = busy
  reviewTab.disabled = busy
  retryButton.disabled = busy
  reviewExportButton.disabled = busy || !reviewConfirm.checked || analysis.documents.some((file) => file.status === 'failed')
  downloadButton.disabled = busy || !workbook || analysis.documents.some((file) => file.status === 'failed')
  progressCard.classList.toggle('hidden', !busy)
}

function showError(message) {
  errorMessage.textContent = message
  errorCard.classList.remove('hidden')
}

function apiError(data, fallback) {
  if (typeof data?.error === 'string') return data.error
  if (typeof data?.error?.message === 'string') return data.error.message
  return fallback
}

async function postJson(url, payload) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
  const data = await response.json()
  if (!response.ok) throw new Error(apiError(data, '처리 중 오류가 발생했습니다.'))
  return data
}

function cell(text, className) {
  const element = document.createElement('td')
  element.textContent = text
  if (className) element.className = className
  return element
}

function displayNumber(value) {
  return value === null ? '—' : Number(value).toFixed(3)
}

function statusText(file) {
  if (file.status === 'read') return '결과표 사용'
  if (file.status === 'skip') return '제외'
  if (file.status === 'failed') return '판독 실패'
  return '확인 필요'
}

function renderDocuments(documents, target) {
  target.replaceChildren()
  for (const file of documents) {
    const row = document.createElement('div')
    row.className = 'document-row'
    const name = document.createElement('span')
    name.className = 'document-name'
    name.textContent = file.name
    const status = document.createElement('span')
    status.className = `status-chip ${file.status === 'failed' ? 'unknown' : file.status}`
    status.textContent = statusText(file)
    const reason = document.createElement('span')
    reason.className = 'document-reason'
    reason.textContent = `${file.document} · ${file.reason}`
    row.append(name, status, reason)
    target.append(row)
  }
}

function renderNetwork(data) {
  workbook = data.workbookBase64 ? { base64: data.workbookBase64, name: data.workbookName } : null
  downloadButton.disabled = !workbook || analysis.documents.some((file) => file.status === 'failed')
  document.querySelector('#readFiles').textContent = data.summary.readFiles ?? analysis.documents.filter((file) => file.status === 'read').length
  document.querySelector('#completeSamples').textContent = data.summary.completeSamples
  document.querySelector('#warningSamples').textContent = data.summary.warningSamples
  renderDocuments(analysis.documents, documentList)
  resultBody.replaceChildren()
  for (const item of data.rows) {
    const row = document.createElement('tr')
    if (item.warnings.length) row.className = 'warning-row'
    row.append(
      cell(String(item.no)), cell(item.sampleName),
      cell(displayNumber(item.dtn), item.dtn === null ? 'value-missing' : ''),
      cell(displayNumber(item.tn), item.tn === null ? 'value-missing' : ''),
      cell(displayNumber(item.dtp), item.dtp === null ? 'value-missing' : ''),
      cell(displayNumber(item.tp), item.tp === null ? 'value-missing' : ''),
      cell(item.warnings.length ? item.warnings.join(' · ') : '확인됨', item.warnings.length ? 'warning-label' : 'ok-label'),
    )
    resultBody.append(row)
  }
  results.classList.remove('hidden')
  reviewResults.classList.add('hidden')
  results.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function textInput(value, label, onChange) {
  const element = document.createElement('input')
  element.type = 'text'
  element.value = value
  element.setAttribute('aria-label', label)
  element.addEventListener('input', () => onChange(element.value))
  return element
}

function renderReview(data) {
  workbook = null
  reviewConfirm.checked = false
  reviewExportButton.disabled = true
  const invalidNetwork = batchMode.value === 'network'
  document.querySelector('#reviewNoticeTitle').textContent = invalidNetwork
    ? '측정망 1~36 자료로 확인되지 않았습니다.'
    : 'AI 매칭 제안을 확인해주세요.'
  document.querySelector('#reviewNoticeText').textContent = invalidNetwork
    ? '다른 시료가 섞였거나 일부 파일이 실패했을 수 있습니다. 실패 파일을 재시도하거나 일반 시료 화면에서 매칭을 확인하세요.'
    : 'AI 제안은 확정값이 아닙니다. 원본과 비교해 포함 여부·구분·최종 No·시료명을 확정하세요.'
  const previous = new Map(reviewRows.map((row) => [row.id, row]))
  reviewRows = data.reviewRows.map((row) => {
    const prior = previous.get(row.id)
    return prior ? {
      ...row,
      include: prior.include,
      finalNo: prior.finalNo,
      finalSampleName: prior.finalSampleName,
      sampleKind: prior.sampleKind,
    } : { ...row }
  })
  document.querySelector('#reviewRowCount').textContent = String(reviewRows.length)
  document.querySelector('#reviewNeedCount').textContent = String(reviewRows.filter((row) => row.sampleKind === 'unknown' || row.uncertain.length).length)
  renderDocuments(analysis.documents, reviewDocumentList)
  reviewBody.replaceChildren()
  for (const item of reviewRows) {
    const row = document.createElement('tr')
    if (item.sampleKind === 'unknown' || item.uncertain.length) row.className = 'review-warning'
    const includeCell = document.createElement('td')
    const include = document.createElement('input')
    include.type = 'checkbox'
    include.checked = item.include
    include.setAttribute('aria-label', `${item.originalName} 포함`)
    include.addEventListener('change', () => { item.include = include.checked; reviewConfirm.checked = false; reviewExportButton.disabled = true })
    includeCell.append(include)

    const kindCell = document.createElement('td')
    const kind = document.createElement('select')
    for (const [value, label] of [['dissolved', 'DTNP(용존)'], ['total', '일반(총)'], ['control', '품질관리'], ['unknown', '확인 필요']]) {
      const option = document.createElement('option')
      option.value = value
      option.textContent = label
      option.selected = item.sampleKind === value
      kind.append(option)
    }
    kind.addEventListener('change', () => { item.sampleKind = kind.value; reviewConfirm.checked = false; reviewExportButton.disabled = true })
    kindCell.append(kind)
    const noCell = document.createElement('td')
    noCell.append(textInput(item.finalNo, `${item.originalName} 최종 No`, (value) => { item.finalNo = value; reviewConfirm.checked = false; reviewExportButton.disabled = true }))
    const nameCell = document.createElement('td')
    nameCell.append(textInput(item.finalSampleName, `${item.originalName} 최종 시료명`, (value) => { item.finalSampleName = value; reviewConfirm.checked = false; reviewExportButton.disabled = true }))
    row.append(
      includeCell, cell(item.originalName), kindCell, noCell, nameCell,
      cell(item.tn ?? '—', 'readonly-number'), cell(item.tp ?? '—', 'readonly-number'),
      cell(`${item.matchReason} · ${item.sourceFile}`),
    )
    reviewBody.append(row)
  }
  results.classList.add('hidden')
  reviewResults.classList.remove('hidden')
  reviewResults.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function showRetry(documents) {
  const failed = documents.filter((file) => file.status === 'failed')
  retryCard.classList.toggle('hidden', failed.length === 0)
  if (!failed.length) return
  const names = `${failed.length}개: ${failed.map((file) => file.name).join(', ')}`
  if (failed.some((file) => file.failureCode === 'daily_quota')) {
    retryTitle.textContent = '오늘의 AI 판독 한도에 도달했습니다'
    failedMessage.textContent = '하루 한도가 초기화된 뒤 다시 판독해주세요. ' + names
  } else if (failed.some((file) => file.failureCode === 'minute_limit')) {
    retryTitle.textContent = '분당 AI 요청 한도에 도달했습니다'
    failedMessage.textContent = '약 1분 뒤 실패한 파일을 다시 시도해주세요. ' + names
  } else if (failed.some((file) => file.failureCode === 'rate_limit')) {
    retryTitle.textContent = 'AI 사용 한도에 도달했습니다'
    failedMessage.textContent = '분당·하루 한도 중 무엇인지 확인되지 않았습니다. 잠시 후 재시도하고, 계속 실패하면 Google AI Studio 사용량을 확인해주세요. ' + names
  } else if (failed.some((file) => file.failureCode === 'service_unavailable')) {
    retryTitle.textContent = 'AI 서비스가 일시적으로 혼잡합니다'
    failedMessage.textContent = '잠시 후 실패한 파일을 다시 시도해주세요. ' + names
  } else {
    retryTitle.textContent = '일부 파일을 끝까지 읽지 못했습니다'
    failedMessage.textContent = names
  }
  const retryable = failed.filter((file) => file.retryable)
  retryButton.classList.toggle('hidden', retryable.length === 0)
  retryButton.textContent = retryable.length < failed.length ? '일시 오류 파일만 다시 시도' : '실패한 파일만 다시 시도'
}

function renderOutcome(data) {
  showRetry(analysis.documents)
  if (data.mode === 'network') renderNetwork(data)
  else renderReview(data)
  if (analysis.documents.some((file) => file.status === 'failed')) retryCard.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function showWorkflow(mode) {
  batchMode.value = mode
  const network = mode === 'network'
  networkTab.classList.toggle('active', network)
  reviewTab.classList.toggle('active', !network)
  networkTab.setAttribute('aria-selected', String(network))
  reviewTab.setAttribute('aria-selected', String(!network))
  workflowTitle.innerHTML = network
    ? '측정망 1~36을<br />번호순으로 정리합니다.'
    : '일반 시료를<br />확인하고 내보냅니다.'
  workflowDescription.innerHTML = network
    ? '파일 순서와 관계없이 <strong>nDTNP</strong>와 <strong>n</strong> 행을 연결합니다. 아직 넣지 않은 번호는 빈 행으로 남기고, 이상한 값은 수정하지 않고 표시합니다.'
    : 'AI가 원본 SID와 T-N·T-P 값을 읽고 시료 매칭을 제안합니다. <strong>포함 여부·시료명·구분</strong>을 사용자가 확정한 뒤 엑셀로 내보냅니다. 숫자는 수정하지 않습니다.'
}

async function processFiles(targetFiles = files, merge = false) {
  errorCard.classList.add('hidden')
  if (!merge) {
    results.classList.add('hidden')
    reviewResults.classList.add('hidden')
    retryCard.classList.add('hidden')
    workbook = null
    analysis = { rawRows: [], documents: [] }
    reviewRows = []
  }
  if (targetFiles.reduce((sum, file) => sum + file.size, 0) > maxTotalBytes) {
    showError('한 번에 올리는 파일의 전체 용량은 50MB 이하여야 합니다.')
    return
  }
  setBusy(true)
  try {
    const payload = await Promise.all(targetFiles.map(async (file) => ({ id: fileId(file), name: file.name, ...await prepareUpload(file) })))
    // 재시도는 일부 파일만 전송하므로 그 조각을 측정망으로 판별하지 않고 합친 뒤 재판별한다.
    const data = await postJson('/api/process', { files: payload, mode: merge ? 'review' : batchMode.value })
    if (!merge) {
      analysis = { rawRows: data.rawRows, documents: data.files }
      renderOutcome(data)
    } else {
      const retriedIds = new Set(payload.map((file) => file.id))
      analysis.rawRows = [...analysis.rawRows.filter((row) => !retriedIds.has(row.sourceId)), ...data.rawRows]
      analysis.documents = [...analysis.documents.filter((file) => !retriedIds.has(file.id)), ...data.files]
      const finalized = await postJson('/api/finalize', { rawRows: analysis.rawRows, mode: batchMode.value })
      finalized.summary = {
        ...finalized.summary,
        readFiles: analysis.documents.filter((file) => file.status === 'read').length,
        failedFiles: analysis.documents.filter((file) => file.status === 'failed').length,
      }
      renderOutcome(finalized)
    }
  } catch (error) {
    showError(error instanceof Error ? error.message : '처리 중 오류가 발생했습니다.')
  } finally {
    setBusy(false)
  }
}

async function retryFailedFiles() {
  const failedIds = new Set(analysis.documents.filter((file) => file.status === 'failed' && file.retryable).map((file) => file.id))
  const targets = files.filter((file) => failedIds.has(fileId(file)))
  if (!targets.length) {
    showError('다시 시도할 원본 파일을 찾지 못했습니다. 파일을 다시 선택해주세요.')
    return
  }
  await processFiles(targets, true)
}

async function processSelectedFiles() {
  const processedIds = new Set(analysis.documents.map((document) => document.id))
  const newFiles = files.filter((file) => !processedIds.has(fileId(file)))
  if (analysis.documents.length && newFiles.length) await processFiles(newFiles, true)
  else await processFiles(files, false)
}

function saveWorkbook(target) {
  if (!target) return
  const binary = atob(target.base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = target.name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function exportReviewed() {
  errorCard.classList.add('hidden')
  setBusy(true)
  try {
    const data = await postJson('/api/export', { rows: reviewRows })
    saveWorkbook({ base64: data.workbookBase64, name: data.workbookName })
  } catch (error) {
    showError(error instanceof Error ? error.message : '엑셀을 만들지 못했습니다.')
  } finally {
    setBusy(false)
  }
}

input.addEventListener('change', () => addFiles(input.files || []))
clearButton.addEventListener('click', () => { files = []; input.value = ''; clearAnalysis(); renderFiles() })
processButton.addEventListener('click', processSelectedFiles)
downloadButton.addEventListener('click', () => saveWorkbook(workbook))
reviewExportButton.addEventListener('click', exportReviewed)
reviewConfirm.addEventListener('change', () => { reviewExportButton.disabled = !reviewConfirm.checked || analysis.documents.some((file) => file.status === 'failed') })
retryButton.addEventListener('click', retryFailedFiles)
async function switchWorkflow(mode) {
  showWorkflow(mode)
  if (!analysis.rawRows.length) return
  errorCard.classList.add('hidden')
  setBusy(true)
  try {
    const finalized = await postJson('/api/finalize', { rawRows: analysis.rawRows, mode: batchMode.value })
    renderOutcome(finalized)
  } catch (error) {
    showError(error instanceof Error ? error.message : '시료 종류를 변경하지 못했습니다.')
  } finally {
    setBusy(false)
  }
}
networkTab.addEventListener('click', () => switchWorkflow('network'))
reviewTab.addEventListener('click', () => switchWorkflow('review'))
for (const event of ['dragenter', 'dragover']) dropzone.addEventListener(event, (e) => { e.preventDefault(); dropzone.classList.add('dragging') })
for (const event of ['dragleave', 'drop']) dropzone.addEventListener(event, (e) => { e.preventDefault(); dropzone.classList.remove('dragging') })
dropzone.addEventListener('drop', (event) => addFiles(event.dataTransfer?.files || []))

fetch('/api/health')
  .then((response) => response.json())
  .then((health) => {
    connection.classList.add(health.ok && health.apiKeyConfigured ? 'ready' : 'error')
    connection.querySelector('span:last-child').textContent = health.apiKeyConfigured ? '판독 준비됨' : 'API 키 필요'
  })
  .catch(() => {
    connection.classList.add('error')
    connection.querySelector('span:last-child').textContent = '서버 연결 안 됨'
  })
