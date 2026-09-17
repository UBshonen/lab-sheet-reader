export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite'

export type GeminiFailureCode = 'daily_quota' | 'minute_limit' | 'rate_limit' | 'service_unavailable' | 'other'

export type GeminiFailure = {
  code: GeminiFailureCode
  message: string
  retryable: boolean
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try { return JSON.stringify(error) } catch { return String(error) }
}

export function classifyGeminiError(error: unknown): GeminiFailure {
  const text = errorText(error)
  const daily = /quota_exceeded|per[_\s-]?day|requests?\s*per\s*day|daily\s*quota|\bRPD\b|GenerateRequestsPerDay/i.test(text)
  const minute = /rate_limit_exceeded|per[_\s-]?minute|requests?\s*per\s*minute|tokens?\s*per\s*minute|\bRPM\b|\bTPM\b|GenerateRequestsPerMinute|TokensPerMinute/i.test(text)
  const rateLimit = /\b429\b|RESOURCE_EXHAUSTED|Too Many Requests/i.test(text)
  const unavailable = /\b(500|502|503|504)\b|UNAVAILABLE|fetch failed|ECONNRESET|ETIMEDOUT/i.test(text)

  if (daily) return {
    code: 'daily_quota',
    message: '오늘 사용할 수 있는 AI 판독 횟수를 모두 사용했습니다. 하루 한도가 초기화된 뒤 다시 판독해주세요.',
    retryable: false,
  }
  if (minute) return {
    code: 'minute_limit',
    message: 'AI 요청이 잠시 몰려 분당 한도에 도달했습니다. 약 1분 뒤 실패한 파일을 다시 시도해주세요.',
    retryable: true,
  }
  if (rateLimit) return {
    code: 'rate_limit',
    message: 'AI 사용 한도에 도달했습니다. 분당 한도인지 하루 한도인지 확인되지 않았습니다. 잠시 후 재시도하거나 Google AI Studio의 사용량을 확인해주세요.',
    retryable: true,
  }
  if (unavailable) return {
    code: 'service_unavailable',
    message: 'AI 서비스가 일시적으로 혼잡하거나 연결되지 않았습니다. 잠시 후 실패한 파일을 다시 시도해주세요.',
    retryable: true,
  }
  return { code: 'other', message: text, retryable: false }
}
