type Env = {
  GEMINI_API_KEY?: string
}

type Context = {
  env: Env
}

export function onRequestGet(context: Context): Response {
  return Response.json(
    {
      ok: true,
      apiKeyConfigured: Boolean(context.env.GEMINI_API_KEY?.trim()),
    },
    {
      headers: {
        'cache-control': 'no-store',
      },
    },
  )
}
