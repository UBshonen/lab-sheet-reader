import sharp from 'sharp'

/**
 * 보내기 전에 이미지를 줄인다.
 *
 * 모델은 어차피 이미지를 제 한도로 축소한 뒤 토큰을 센다. 원본을 그대로
 * 보내면 토큰은 그대로인데 업로드만 느려지고, 파일이 크면 요청 자체가
 * 실패한다. 실제로 3.8MB 사진에서 fetch 가 끊겼다.
 *
 * 다만 손글씨는 해상도가 곧 정확도라 너무 줄이면 안 된다.
 * 긴 변 2048px 이면 A4 를 200dpi 남짓으로 찍은 것과 비슷하고,
 * 지금까지 잘 읽힌 사진들이 그 언저리였다.
 */

const MAX_EDGE = 2048
const QUALITY = 88

/** 이보다 작으면 손대지 않는다. 다시 압축해봐야 화질만 나빠진다 */
const SKIP_BYTES = 1_200_000

export type Prepared = {
  bytes: Uint8Array
  mimeType: string
  /** 줄였으면 무엇이 어떻게 바뀌었는지. 로그에 찍어 사람이 알 수 있게 */
  note?: string
}

export async function prepare(bytes: Uint8Array, mimeType: string): Promise<Prepared> {
  // PDF 는 페이지 구조를 건드리면 안 되므로 그대로 보낸다
  if (mimeType === 'application/pdf') return { bytes, mimeType }
  if (bytes.byteLength < SKIP_BYTES) return { bytes, mimeType }

  const input = Buffer.from(bytes)
  const meta = await sharp(input).metadata()
  const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0)

  const out = await sharp(input)
    .rotate() // 사진의 방향 정보를 실제 픽셀에 반영한다
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: QUALITY })
    .toBuffer()

  const mb = (n: number) => (n / 1_048_576).toFixed(1)
  return {
    bytes: new Uint8Array(out),
    mimeType: 'image/jpeg',
    note: `${longEdge}px ${mb(bytes.byteLength)}MB → ${Math.min(longEdge, MAX_EDGE)}px ${mb(out.byteLength)}MB`,
  }
}
