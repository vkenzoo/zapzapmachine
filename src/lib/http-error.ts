import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

/**
 * Retorna resposta de erro sanitizada — nunca vaza detalhes internos
 * (DB schema, stack traces, etc) pro cliente. O erro completo vai pros logs.
 */
export const httpError = (
  c: Context,
  status: ContentfulStatusCode,
  mensagemPublica: string,
  erroInterno?: unknown
) => {
  if (erroInterno) {
    console.error(`[${status}] ${mensagemPublica}:`, erroInterno)
  }
  return c.json({ error: mensagemPublica }, status)
}
