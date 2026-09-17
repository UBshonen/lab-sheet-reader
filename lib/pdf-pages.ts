import { PDFDocument } from 'pdf-lib'

export type PdfPage = { number: number; bytes: Uint8Array }

const MAX_PAGES = 20

/** 한 번의 AI 응답에서 중간 페이지가 통째로 빠지는 일을 막기 위해 PDF를 한 쪽씩 나눈다. */
export async function splitPdfPages(bytes: Uint8Array): Promise<PdfPage[]> {
  const source = await PDFDocument.load(bytes)
  const count = source.getPageCount()
  if (count === 0) throw new Error('PDF에 페이지가 없습니다.')
  if (count > MAX_PAGES) throw new Error(`PDF는 한 파일당 ${MAX_PAGES}쪽까지 처리할 수 있습니다.`)
  if (count === 1) return [{ number: 1, bytes }]

  const pages: PdfPage[] = []
  for (let index = 0; index < count; index++) {
    const single = await PDFDocument.create()
    const [page] = await single.copyPages(source, [index])
    single.addPage(page)
    pages.push({ number: index + 1, bytes: await single.save() })
  }
  return pages
}
