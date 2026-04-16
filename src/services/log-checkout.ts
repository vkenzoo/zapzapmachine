import { supabase } from '../lib/supabase.js'

interface LogCheckoutInput {
  integracaoId?: string | null
  userId?: string | null
  provedor: string
  evento: string
  statusWebhook: 'SUCESSO' | 'ERRO' | 'IGNORADO'
  payload?: unknown
  erroMensagem?: string
  conversaId?: string | null
}

/**
 * Registra um webhook de checkout em logs_checkout.
 * Fire-and-forget.
 */
export const logCheckout = (input: LogCheckoutInput): void => {
  supabase
    .from('logs_checkout')
    .insert({
      integracao_id: input.integracaoId ?? null,
      user_id: input.userId ?? null,
      provedor: input.provedor,
      evento: input.evento,
      status_webhook: input.statusWebhook,
      payload: input.payload ?? null,
      erro_mensagem: input.erroMensagem ?? null,
      conversa_id: input.conversaId ?? null,
    })
    .then(
      (res) => {
        if (res.error)
          console.warn('[logCheckout] falha:', res.error.message)
      },
      (e) => console.warn('[logCheckout] erro:', e)
    )
}
