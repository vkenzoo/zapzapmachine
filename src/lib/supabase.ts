import { createClient } from '@supabase/supabase-js'
import { env } from './env.js'

const config = env()

// Cliente service_role — BYPASSA RLS.
// Usado no backend para operacoes administrativas (webhooks, workers).
// CUIDADO: sempre filtrar por user_id manualmente em queries do usuario.
export const supabase = createClient(
  config.SUPABASE_URL,
  config.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  }
)

/**
 * Valida um JWT de usuario e retorna o user_id.
 * Usado pelo middleware de auth.
 */
export const validarJWT = async (token: string): Promise<string | null> => {
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) return null
  return data.user.id
}
