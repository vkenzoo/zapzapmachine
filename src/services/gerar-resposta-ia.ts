import { supabase } from '../lib/supabase.js'
import { getLLM, type LLMMessage } from '../lib/llm.js'
import { evolution } from '../lib/evolution.js'
import { montarSystemPrompt, type BaseInput } from './montar-prompt.js'

const HISTORICO_MAX = 20
const TAG_AJUDA = '[PRECISO_AJUDA]'

/**
 * Delay promise helper.
 */
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Remove acentos/simbolos do telefone pra mandar pro Evolution.
 */
const telefoneCru = (fmt: string) => fmt.replace(/\D/g, '')

interface ConversaInfo {
  id: string
  user_id: string
  telefone: string
  instancia_whatsapp_id: string
  agente_id: string | null
  modo: string
}

interface AgenteRow {
  id: string
  nome: string
  objetivo: string
  descricao: string | null
  status: string
  config: unknown
}

/**
 * Gera e envia uma resposta IA pra conversa.
 * Fire-and-forget: chama direto do webhook, nao trava.
 */
export const gerarRespostaIA = async (conversaId: string): Promise<void> => {
  // 1. Busca conversa
  const { data: conversa, error: errConv } = await supabase
    .from('conversas')
    .select(
      'id, user_id, telefone, instancia_whatsapp_id, agente_id, modo'
    )
    .eq('id', conversaId)
    .maybeSingle<ConversaInfo>()

  if (errConv || !conversa) {
    console.warn('[ia] conversa nao encontrada', conversaId, errConv)
    return
  }
  if (!conversa.agente_id || conversa.modo !== 'IA') {
    console.log('[ia] conversa sem agente/modo != IA, skip')
    return
  }

  // 2. Busca agente
  const { data: agente } = await supabase
    .from('agentes')
    .select('id, nome, objetivo, descricao, status, config')
    .eq('id', conversa.agente_id)
    .maybeSingle<AgenteRow>()

  if (!agente || agente.status !== 'ATIVO') {
    console.log('[ia] agente inativo ou nao encontrado, skip')
    return
  }

  // 3. Busca bases vinculadas ao agente
  const { data: vinculos } = await supabase
    .from('agentes_bases')
    .select('base_id')
    .eq('agente_id', conversa.agente_id)

  const baseIds = (vinculos ?? []).map((v) => v.base_id as string)

  let bases: BaseInput[] = []
  if (baseIds.length > 0) {
    const { data: basesRows } = await supabase
      .from('bases_conhecimento')
      .select(
        'nome, informacoes_produto, persona, faq_objecoes, personalidade_agente, limitacoes, entregaveis'
      )
      .in('id', baseIds)
    bases = (basesRows ?? []) as BaseInput[]
  }

  // 4. Busca historico (ultimas N mensagens)
  const { data: historicoRaw } = await supabase
    .from('mensagens')
    .select('tipo, conteudo')
    .eq('conversa_id', conversaId)
    .order('enviada_em', { ascending: false })
    .limit(HISTORICO_MAX)

  const historico = (historicoRaw ?? []).reverse() as {
    tipo: string
    conteudo: string
  }[]

  const messages: LLMMessage[] = historico.map((msg) => {
    if (msg.tipo === 'INCOMING') {
      return { role: 'user', content: msg.conteudo }
    }
    if (msg.tipo === 'OUTGOING_HUMANO') {
      return {
        role: 'assistant',
        content: `[Atendente humano]: ${msg.conteudo}`,
      }
    }
    // OUTGOING_IA
    return { role: 'assistant', content: msg.conteudo }
  })

  // Garante que o array comeca com role=user. Se a ultima msg for assistant
  // (raro), pula — LLM exige user primeiro.
  while (messages.length > 0 && messages[0].role !== 'user') {
    messages.shift()
  }
  if (messages.length === 0) {
    console.log('[ia] sem mensagem user, skip')
    return
  }

  // 5. Monta prompt
  const systemPrompt = montarSystemPrompt(
    {
      nome: agente.nome,
      objetivo: agente.objetivo as Parameters<
        typeof montarSystemPrompt
      >[0]['objetivo'],
      descricao: agente.descricao ?? '',
      config: (agente.config ?? {}) as Parameters<
        typeof montarSystemPrompt
      >[0]['config'],
    },
    bases
  )

  // 6. Chama LLM
  let resposta: string
  try {
    const llm = getLLM()
    console.log(
      `[ia] gerando resposta (provider=${llm.name} model=${llm.model}, msgs=${messages.length})`
    )
    resposta = await llm.generate({ systemPrompt, messages })
  } catch (e) {
    console.error('[ia] erro LLM:', e)
    return
  }

  if (!resposta.trim()) {
    console.warn('[ia] resposta vazia')
    return
  }

  // 7. Pos-processamento: checa escalada pra humano
  let precisaAjuda = false
  if (resposta.includes(TAG_AJUDA)) {
    precisaAjuda = true
    resposta = resposta.replace(TAG_AJUDA, '').trim()
  }

  // 8. Pos-processamento: split em partes (se habilitado)
  const config = (agente.config ?? {}) as { dividirRespostaEmPartes?: boolean }
  const partes = config.dividirRespostaEmPartes
    ? resposta
        .split(/\n---\n/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [resposta]

  // 9. Envia cada parte via Evolution + salva no DB
  const instanceName = conversa.instancia_whatsapp_id
  const tel = telefoneCru(conversa.telefone)

  for (let i = 0; i < partes.length; i++) {
    const parte = partes[i]
    if (i > 0) {
      // Delay entre partes pra parecer natural (800-1500ms)
      await delay(800 + Math.random() * 700)
    }

    let whatsappId: string | null = null
    try {
      const resp = (await evolution.enviarTexto(
        instanceName,
        tel,
        parte
      )) as { key?: { id?: string } }
      whatsappId = resp?.key?.id ?? null
    } catch (e) {
      console.error('[ia] erro ao enviar via Evolution:', e)
      continue
    }

    await supabase.from('mensagens').insert({
      conversa_id: conversaId,
      user_id: conversa.user_id,
      tipo: 'OUTGOING_IA',
      conteudo: parte,
      tipo_midia: 'TEXTO',
      whatsapp_message_id: whatsappId,
      status: 'ENVIADA',
    })
  }

  // 10. Atualiza conversa
  await supabase
    .from('conversas')
    .update({
      ultima_mensagem: partes[partes.length - 1],
      ultima_mensagem_em: new Date().toISOString(),
      ...(precisaAjuda ? { modo: 'HUMANO' } : {}),
    })
    .eq('id', conversaId)

  if (precisaAjuda) {
    console.log(`[ia] escalado pra humano (conversa=${conversaId})`)
  }
}
