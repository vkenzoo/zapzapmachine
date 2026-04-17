import type { MiddlewareHandler } from 'hono'

/**
 * Rate limiter em memoria por IP (ou chave custom).
 * Janela deslizante simples: max N requests em M segundos.
 *
 * Nao precisa de Redis/deps. OK para MVP/single-instance.
 * Se escalar pra multi-instance, trocar por Redis sorted set.
 */

interface Bucket {
  count: number
  resetAt: number
}

interface RateLimitOptions {
  /** Maximo de requests permitidas na janela */
  max: number
  /** Janela em ms */
  windowMs: number
  /** Funcao pra derivar a chave (default: IP) */
  keyFn?: (c: Parameters<MiddlewareHandler>[0]) => string
  /** Mensagem de erro customizada */
  message?: string
}

const store = new Map<string, Bucket>()

// GC periodico: remove buckets expirados a cada 60s
setInterval(() => {
  const agora = Date.now()
  for (const [k, b] of store.entries()) {
    if (b.resetAt < agora) store.delete(k)
  }
}, 60_000).unref?.()

const extrairIp = (c: Parameters<MiddlewareHandler>[0]): string => {
  // Prioriza headers de proxy (Cloudflare/Traefik), fallback pra socket
  return (
    c.req.header('cf-connecting-ip') ??
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ??
    'unknown'
  )
}

export const rateLimit = (opts: RateLimitOptions): MiddlewareHandler => {
  const {
    max,
    windowMs,
    keyFn = extrairIp,
    message = 'Muitas requisicoes. Tente novamente em alguns minutos.',
  } = opts

  return async (c, next) => {
    const key = `${c.req.path}:${keyFn(c)}`
    const agora = Date.now()

    const bucket = store.get(key)

    if (!bucket || bucket.resetAt < agora) {
      store.set(key, { count: 1, resetAt: agora + windowMs })
      return next()
    }

    if (bucket.count >= max) {
      const retryAfter = Math.ceil((bucket.resetAt - agora) / 1000)
      c.header('Retry-After', String(retryAfter))
      c.header('X-RateLimit-Limit', String(max))
      c.header('X-RateLimit-Remaining', '0')
      c.header('X-RateLimit-Reset', String(Math.floor(bucket.resetAt / 1000)))
      return c.json({ error: message, retryAfter }, 429)
    }

    bucket.count++
    c.header('X-RateLimit-Limit', String(max))
    c.header('X-RateLimit-Remaining', String(max - bucket.count))
    return next()
  }
}
