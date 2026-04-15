import type { MiddlewareHandler } from 'hono'
import { validarJWT } from '../lib/supabase.js'

/**
 * Middleware que extrai o JWT do Authorization header,
 * valida no Supabase e anexa `userId` ao contexto.
 *
 * Uso:
 *   app.use('/api/*', auth)
 *   const userId = c.get('userId')
 */
export const auth: MiddlewareHandler<{
  Variables: { userId: string }
}> = async (c, next) => {
  const header = c.req.header('Authorization')

  if (!header || !header.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401)
  }

  const token = header.slice(7)
  const userId = await validarJWT(token)

  if (!userId) {
    return c.json({ error: 'Invalid or expired token' }, 401)
  }

  c.set('userId', userId)
  return next()
}
