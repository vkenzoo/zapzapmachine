import { supabase } from '../lib/supabase.js'

export type CategoriaEvento =
  | 'AUTH'
  | 'PERFIL'
  | 'WHATSAPP'
  | 'CONVERSA'
  | 'MENSAGEM'
  | 'AUTOMACAO'
  | 'CHECKOUT'
  | 'ADMIN'
  | 'SISTEMA'

export type AcaoEvento =
  | 'LOGIN'
  | 'CRIAR'
  | 'EDITAR'
  | 'DELETAR'
  | 'ATIVAR'
  | 'DESATIVAR'
  | 'CONECTAR'
  | 'DESCONECTAR'
  | 'ENVIAR_MSG'
  | 'RECEBER_MSG'
  | 'VINCULAR_AGENTE'
  | 'TROCAR_MODO'
  | 'TOGGLE_AGENTES_GLOBAL'
  | 'UPLOAD_FOTO'
  | 'ALTERAR_ROLE'
  | 'EDITAR_PROMPT'
  | 'WEBHOOK_RECEBIDO'

interface LogEventoInput {
  userId?: string | null
  categoria: CategoriaEvento
  acao: AcaoEvento
  recursoTipo?: string
  recursoId?: string
  descricao?: string
  detalhes?: Record<string, unknown>
  ip?: string
}

/**
 * Registra um evento do sistema em logs_eventos.
 * Fire-and-forget: NUNCA trava o fluxo.
 */
export const logEvento = (input: LogEventoInput): void => {
  supabase
    .from('logs_eventos')
    .insert({
      user_id: input.userId ?? null,
      categoria: input.categoria,
      acao: input.acao,
      recurso_tipo: input.recursoTipo ?? null,
      recurso_id: input.recursoId ?? null,
      descricao: input.descricao ?? null,
      detalhes: input.detalhes ?? null,
      ip: input.ip ?? null,
    })
    .then(
      (res) => {
        if (res.error) console.warn('[logEvento] falha:', res.error.message)
      },
      (e) => console.warn('[logEvento] erro:', e)
    )
}
