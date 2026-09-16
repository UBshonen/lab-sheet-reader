const input = document.querySelector('#fileInput')
const dropzone = document.querySelector('#dropzone')
const selectedArea = document.querySelector('#selectedArea')
const fileList = document.querySelector('#fileList')
const fileCount = document.querySelector('#fileCount')
const totalSize = document.querySelector('#totalSize')
const clearButton = document.querySelector('#clearButton')
const processButton = document.querySelector('#processButton')
const progressCard = document.querySelector('#progressCard')
const errorCard = document.querySelector('#errorCard')
const errorMessage = document.querySelector('#errorMessage')
const results = document.querySelector('#results')
const resultBody = document.querySelector('#resultBody')
const documentList = document.querySelector('#documentList')
const downloadButton = document.querySelector('#downloadButton')
const connection = document.querySelector('#connection')

let files = []
let workbook = null

const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function extension(name) {
  return name.split('.').pop()?.slice(0, 4) || 'file'
}

function addFiles(next) {
  for (const file of next) {
    if (!allowed.has(file.type)) continue
    const key = `${file.name}:${file.size}:${file.lastModified}`
    if (!files.some((item) => `${item.name}:${item.size}:${item.lastModified}` === key)) files.push(file)
  }
  files = files.slice(0, 20)
  renderFiles()
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
      renderFiles()
    })

    item.append(icon, meta, remove)
    fileList.append(item)
  })

  const hasFiles = files.length > 0
  selectedArea.classList.toggle('hidden', !hasFiles)
  processButton.disabled = !hasFiles
  fileCount.textContent = String(files.length)
  totalSize.textContent = `총 ${formatBytes(files.reduce((sum, file) => sum + file.size, 0))}`
}

async function toBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

function setBusy(busy) {
  processButton.disabled = busy || files.length === 0
  clearButton.disabled = busy
  input.disabled = busy
  progressCard.classList.toggle('hidden', !busy)
}

function showError(message) {
  errorMessage.textContent = message
  errorCard.classList.remove('hidden')
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

function renderResult(data) {
  workbook = { base64: data.workbookBase64, name: data.workbookName }
  document.querySelector('#readFiles').textContent = data.summary.readFiles
  document.querySelector('#completeSamples').textContent = data.summary.completeSamples
  document.querySelector('#warningSamples').textContent = data.summary.warningSamples

  documentList.replaceChildren()
  for (const file of data.files) {
    const row = document.createElement('div')
    row.className = 'document-row'
    const name = document.createElement('span')
    name.className = 'document-name'
    name.textContent = file.name
    const status = document.createElement('span')
    status.className = `status-chip ${file.status}`
    status.textContent = file.status === 'read' ? '결과표 사용' : file.status === 'skip' ? '제외' : '확인 필요'
    const reason = document.createElement('span')
    reason.className = 'document-reason'
    reason.textContent = `${file.document} · ${file.reason}`
    row.append(name, status, reason)
    documentList.append(row)
  }

  resultBody.replaceChildren()
  for (const item of data.rows) {
    const row = document.createElement('tr')
    if (item.warnings.length) row.className = 'warning-row'
    row.append(
      cell(String(item.no)),
      cell(item.sampleName),
      cell(displayNumber(item.dtn), item.dtn === null ? 'value-missing' : ''),
      cell(displayNumber(item.tn), item.tn === null ? 'value-missing' : ''),
      cell(displayNumber(item.dtp), item.dtp === null ? 'value-missing' : ''),
      cell(displayNumber(item.tp), item.tp === null ? 'value-missing' : ''),
      cell(item.warnings.length ? item.warnings.join(' · ') : '확인됨', item.warnings.length ? 'warning-label' : 'ok-label'),
    )
    resultBody.append(row)
  }

  results.classList.remove('hidden')
  results.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

async function processFiles() {
  errorCard.classList.add('hidden')
  results.classList.add('hidden')
  workbook = null
  setBusy(true)

  try {
    const payload = await Promise.all(files.map(async (file) => ({
      name: file.name,
      mimeType: file.type,
      data: await toBase64(file),
    })))
    const response = await fetch('/api/process', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: payload }),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || '처리 중 오류가 발생했습니다.')
    renderResult(data)
  } catch (error) {
    showError(error instanceof Error ? error.message : '처리 중 오류가 발생했습니다.')
  } finally {
    setBusy(false)
  }
}

function downloadWorkbook() {
  if (!workbook) return
  const binary = atob(workbook.base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  const url = URL.createObjectURL(new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = workbook.name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

input.addEventListener('change', () => addFiles(input.files || []))
clearButton.addEventListener('click', () => {
  files = []
  input.value = ''
  renderFiles()
})
processButton.addEventListener('click', processFiles)
downloadButton.addEventListener('click', downloadWorkbook)

for (const event of ['dragenter', 'dragover']) {
  dropzone.addEventListener(event, (e) => {
    e.preventDefault()
    dropzone.classList.add('dragging')
  })
}
for (const event of ['dragleave', 'drop']) {
  dropzone.addEventListener(event, (e) => {
    e.preventDefault()
    dropzone.classList.remove('dragging')
  })
}
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
