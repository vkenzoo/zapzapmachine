import type { MiddlewareHandler } from 'hono'
import { supabase, validarJWT } from '../lib/supabase.js'

/**
 * Middleware: valida JWT + verifica se o usuario tem role='ADMIN'.
 * Se nao for admin, retorna 403.
 */
export const adminAuth: MiddlewareHandler<{
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

  // Valida role=ADMIN
  const { data } = await supabase
    .from('usuarios')
    .select('role')
    .eq('id', userId)
    .maybeSingle()

  if (!data || data.role !== 'ADMIN') {
    return c.json({ error: 'Forbidden: requires admin role' }, 403)
  }

  c.set('userId', userId)
  return next()
}
