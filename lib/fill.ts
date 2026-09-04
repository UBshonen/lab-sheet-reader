import ExcelJS from 'exceljs'
import type { ReadResult } from './reader/index.js'
import { collect, type Sample } from './export.js'

/**
 * 받은 결과정리 양식을 열어 판독값을 채워 넣는다.
 *
 * 새 파일을 만드는 대신 양식을 그대로 쓴다. 수식 · 열 배치 · 서식이
 * 전부 살아 있어야 붙여넣기가 아니라 파일째로 쓸 수 있기 때문이다.
 *
 * 채우는 것    시료명 · BOD 원자료 · SS 원자료
 * 채우지 않는 것  유형 · 접수일자 · 의뢰기관.  사람이 아는 값이다
 * 넣는 것      수식.  양식에는 예시 15행에만 있어서 우리 행 수만큼 내려 쓴다
 */

const FIRST_ROW = 5

/** 양식 5행의 수식. 행 번호만 바꿔 내려 쓴다 */
const FORMULAS: Record<string, (r: number) => string> = {
  K: (r) => `(G${r}-H${r})*(300/I${r})*J${r}`,
  P: (r) => `L${r}-M${r}`,
  Q: (r) => `ROUND(((L${r}-M${r})*(1000/N${r})),2)*O${r}`,
  R: (r) => `(Q${r}*T${r}/1000)+M${r}`,
  S: (r) => `M${r}`,
  V: (r) => `R${r}-S${r}`,
  W: (r) => `ROUND(((R${r}-S${r})*(1000/T${r})),2)`,
  AA: (r) => `(X${r}-Y${r})*Z${r}`,
  AE: (r) => `(AB${r}-AC${r})*AD${r}`,
  AQ: (r) => `(AN${r}-AO${r})*AP${r}`,
}

/** 판독 결과의 어느 값이 양식의 어느 열로 가는지 */
const CELLS: { col: string; from?: string; fixed?: number }[] = [
  { col: 'G', from: 'bodss-sheet.d1' },
  { col: 'H', from: 'bodss-sheet.d2' },
  // 일지에 시료량을 안 적는 경우가 많다. BOD 병이 300mL 라 그게 기본값이다.
  // 적혀 있으면 그 값을 쓴다. 이상하면 타당성 검사가 잡아 노랗게 칠한다
  { col: 'I', from: 'bodss-sheet.bodVol', fixed: 300 },
  { col: 'J', fixed: 1 },
  { col: 'L', from: 'bodss-sheet.w2' },
  { col: 'M', from: 'bodss-sheet.w1' },
  { col: 'N', from: 'bodss-sheet.ssVol' },
  { col: 'O', fixed: 1 },
  // 성적용 SS 는 시료량과 희석배수만 사람이 넣고 나머지는 수식이 만든다
  { col: 'T', from: 'bodss-sheet.ssVol' },
  { col: 'U', fixed: 1 },
  { col: 'X', from: 'tntp-result.tn' },
  { col: 'Y', fixed: 0 },
  { col: 'Z', fixed: 1 },
  { col: 'AB', from: 'tntp-result.tp' },
  { col: 'AC', fixed: 0 },
  { col: 'AD', fixed: 1 },
  { col: 'AN', from: 'toc-result.result' },
  { col: 'AO', fixed: 0 },
  { col: 'AP', fixed: 1 },
  { col: 'AT', from: 'field-meter.ph' },
  { col: 'AU', from: 'field-meter.do' },
]

function pickNumber(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  const m = String(raw).match(/-?[0-9]*\.?[0-9]+/)
  return m ? Number(m[0]) : null
}

function valueOf(sample: Sample, spec: { from?: string; fixed?: number }): number | null {
  if (spec.from) {
    const [templateId, key] = spec.from.split('.')
    const v = pickNumber(sample.rows.get(templateId!)?.cells[key!])
    if (v !== null) return v
  }
  return spec.fixed ?? null
}

/** 이 시료에 채울 값이 하나라도 있나. 빈 줄을 만들지 않는다 */
function hasData(sample: Sample): boolean {
  return CELLS.some((c) => c.from && valueOf(sample, { from: c.from }) !== null)
}

export async function fillTemplate(
  results: ReadResult[],
  templatePath: string,
  outPath: string,
): Promise<{ rows: number; warned: number }> {
  const samples = collect(results).filter(hasData)

  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(templatePath)
  const ws = wb.worksheets[0]!

  // 양식에 들어 있던 예시 데이터를 지운다. 우리 행보다 길 수 있다
  const lastExisting = Math.max(FIRST_ROW + samples.length, 20)
  for (let r = FIRST_ROW; r <= lastExisting; r++) {
    const row = ws.getRow(r)
    for (let c = 1; c <= ws.columnCount; c++) {
      const cell = row.getCell(c)
      cell.value = null
      delete (cell as { note?: unknown }).note
    }
  }

  let warned = 0

  samples.forEach((s, i) => {
    const r = FIRST_ROW + i
    const row = ws.getRow(r)

    row.getCell('F').value = s.name

    for (const spec of CELLS) {
      const v = valueOf(s, spec)
      if (v !== null) row.getCell(spec.col).value = v
    }

    for (const [col, make] of Object.entries(FORMULAS)) {
      row.getCell(col).value = { formula: make(r) } as ExcelJS.CellFormulaValue
    }

    // 타당성에 걸린 줄은 시료명 칸을 노랗게 칠하고 이유를 메모로 남긴다.
    // 값은 지우지 않는다. 판독이 틀렸는지 원래 그런지 도구는 모른다
    if (s.warnings.length) {
      warned++
      const c = row.getCell('F')
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3C4' } }
      c.note = s.warnings.map((w) => w.text).join('\n')
    }

    row.commit()
  })

  await wb.xlsx.writeFile(outPath)
  return { rows: samples.length, warned }
}
