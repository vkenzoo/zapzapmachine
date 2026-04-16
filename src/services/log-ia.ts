import { supabase } from '../lib/supabase.js'
import { calcularCusto, type LLMUsage } from '../lib/llm.js'

interface LogIAInput {
  userId: string
  conversaId?: string | null
  agenteId?: string | null
  provider: string
  model: string
  tipo?: 'chat' | 'whisper' | 'vision'
  usage: LLMUsage
  duracaoMs?: number
  systemPromptPreview?: string
  erro?: boolean
  erroMensagem?: string
}

/**
 * Registra uma chamada LLM em logs_ia.
 * Fire-and-forget: erros aqui NUNCA travam a resposta.
 */
export const logIA = (input: LogIAInput): void => {
  const custo = calcularCusto(input.model, input.usage)

  supabase
    .from('logs_ia')
    .insert({
      user_id: input.userId,
      conversa_id: input.conversaId ?? null,
      agente_id: input.agenteId ?? null,
      provider: input.provider,
      model: input.model,
      tipo: input.tipo ?? 'chat',
      input_tokens: input.usage.inputTokens,
      output_tokens: input.usage.outputTokens,
      cache_read_tokens: input.usage.cacheReadTokens,
      cache_creation_tokens: input.usage.cacheCreationTokens,
      custo_usd: custo,
      duracao_ms: input.duracaoMs,
      system_prompt_preview: input.systemPromptPreview?.substring(0, 200),
      erro: input.erro ?? false,
      erro_mensagem: input.erroMensagem,
    })
    .then(
      (res) => {
        if (res.error) console.warn('[logIA] falha ao inserir:', res.error.message)
      },
      (e) => console.warn('[logIA] erro:', e)
    )
}

interface LogWhisperInput {
  userId: string
  conversaId?: string | null
  duracaoMs?: number
  duracaoAudioSegundos?: number
  erro?: boolean
  erroMensagem?: string
}

/**
 * Registra transcricao Whisper em logs_ia (tipo='whisper').
 * Custo: $0.006/min = $0.0001/s
 */
export const logWhisper = (input: LogWhisperInput): void => {
  const custo = (input.duracaoAudioSegundos ?? 0) * 0.0001

  supabase
    .from('logs_ia')
    .insert({
      user_id: input.userId,
      conversa_id: input.conversaId ?? null,
      provider: 'openai',
      model: 'whisper-1',
      tipo: 'whisper',
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      custo_usd: Math.round(custo * 1_000_000) / 1_000_000,
      duracao_ms: input.duracaoMs,
      erro: input.erro ?? false,
      erro_mensagem: input.erroMensagem,
    })
    .then(
      (res) => {
        if (res.error) console.warn('[logWhisper] falha:', res.error.message)
      },
      (e) => console.warn('[logWhisper] erro:', e)
    )
}
