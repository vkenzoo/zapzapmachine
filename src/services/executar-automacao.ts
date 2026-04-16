import { supabase } from '../lib/supabase.js'
import { evolution } from '../lib/evolution.js'

export type EventoAutomacao =
  | 'COMPRA_APROVADA'
  | 'COMPRA_RECUSADA'
  | 'REEMBOLSO'
  | 'ASSINATURA_CANCELADA'
  | 'CARRINHO_ABANDONADO'

export interface DadosEvento {
  nome: string
  email?: string
  telefone: string
  idExternoProduto: string
  nomeProduto?: string
  /** Provedor que disparou o evento (pra filtrar automacoes) */
  provedor: 'HOTMART' | 'KIWIFY' | 'TICTO'
  /** ID da integracao pra saber qual user */
  integracaoId: string
}

/** Linha da tabela automacoes (camelCase via mapper interno) */
interface AutomacaoRow {
  id: string
  user_id: string
  nome: string
  ativo: boolean
  evento: string
  provedor: string | null
  produto_id: string | null
  agente_id: string | null
  mensagem_inicial: string | null
  delay_minutos: number
  executar_se_existe: boolean
}

/** Normaliza telefone: digits-only, prefix 55, formato +55 XX XXXXX-XXXX */
const normalizarTelefone = (raw: string): { fmt: string; cru: string } | null => {
  let digits = raw.replace(/\D/g, '')
  if (!digits) return null
  if (digits.length === 10 || digits.length === 11) digits = '55' + digits
  if (digits.length > 13 || digits.length < 12) return null

  const ddd = digits.slice(2, 4)
  const rest = digits.slice(4)
  let numero = rest
  if (rest.length === 9) numero = `${rest.slice(0, 5)}-${rest.slice(5)}`
  if (rest.length === 8) numero = `${rest.slice(0, 4)}-${rest.slice(4)}`
  return { fmt: `+55 ${ddd} ${numero}`, cru: digits }
}

/** Aplica placeholders {nome}, {produto}, {email} */
const aplicarTemplate = (
  template: string,
  vars: { nome?: string; produto?: string; email?: string }
): string => {
  return template
    .replace(/\{nome\}/gi, vars.nome ?? 'cliente')
    .replace(/\{produto\}/gi, vars.produto ?? 'sua compra')
    .replace(/\{email\}/gi, vars.email ?? '')
    .trim()
}

/**
 * Busca automacoes ativas que batem com o evento + provedor + produto.
 * Retorna em ordem de criacao (mais antigas primeiro, permite ordenar visualmente).
 */
const buscarAutomacoesMatching = async (
  userId: string,
  evento: EventoAutomacao,
  provedor: string,
  produtoId: string | null
): Promise<AutomacaoRow[]> => {
  // Condicoes: ativo + evento + (provedor = X ou NULL) + (produto_id = X ou NULL)
  let query = supabase
    .from('automacoes')
    .select('*')
    .eq('user_id', userId)
    .eq('ativo', true)
    .eq('evento', evento)

  const { data, error } = await query
  if (error || !data) return []

  // Filtro em memoria pra matchear "NULL = qualquer"
  return (data as AutomacaoRow[]).filter((a) => {
    if (a.provedor && a.provedor !== provedor) return false
    if (a.produto_id && a.produto_id !== produtoId) return false
    return true
  })
}

/**
 * Dispara todas as automacoes matching pra um evento.
 * Cada automacao: se delay=0, executa agora; senão, agenda na fila.
 */
export const dispararAutomacoes = async (
  evento: EventoAutomacao,
  dados: DadosEvento
): Promise<{ ok: boolean; disparadas: number; agendadas: number }> => {
  console.log(`[automacao] disparando ${evento} — produto=${dados.idExternoProduto}`)

  // 1. Busca integracao → user_id
  const { data: integracao } = await supabase
    .from('integracoes_checkout')
    .select('id, user_id, status')
    .eq('id', dados.integracaoId)
    .maybeSingle()

  if (!integracao || integracao.status !== 'ATIVO') {
    return { ok: false, disparadas: 0, agendadas: 0 }
  }

  // 2. Find or create produto (pra ter produto_id estavel)
  const { data: produto } = await supabase
    .from('produtos_checkout')
    .select('id, nome_produto')
    .eq('integracao_id', dados.integracaoId)
    .eq('id_externo_produto', dados.idExternoProduto)
    .maybeSingle()

  let produtoId: string | null = produto?.id ?? null
  const nomeProduto = produto?.nome_produto ?? dados.nomeProduto ?? dados.idExternoProduto

  if (!produto) {
    const { data: novo } = await supabase
      .from('produtos_checkout')
      .insert({
        integracao_id: dados.integracaoId,
        id_externo_produto: dados.idExternoProduto,
        nome_produto: dados.nomeProduto ?? dados.idExternoProduto,
      })
      .select('id')
      .single()
    produtoId = novo?.id ?? null
  }

  // 3. Atualiza ultimo_recebimento da integracao
  await supabase
    .from('integracoes_checkout')
    .update({ ultimo_recebimento: new Date().toISOString() })
    .eq('id', dados.integracaoId)

  // 4. Busca automacoes matching
  const automacoes = await buscarAutomacoesMatching(
    integracao.user_id,
    evento,
    dados.provedor,
    produtoId
  )

  if (automacoes.length === 0) {
    console.log(`[automacao] nenhuma automacao matching pra ${evento}`)
    return { ok: true, disparadas: 0, agendadas: 0 }
  }

  let disparadas = 0
  let agendadas = 0
  const dadosComProduto = { ...dados, nomeProduto }

  // 5. Pra cada automacao, executa agora ou agenda
  for (const auto of automacoes) {
    if (auto.delay_minutos === 0) {
      await executarAutomacao(auto, dadosComProduto)
      disparadas++
    } else {
      const executarEm = new Date(Date.now() + auto.delay_minutos * 60 * 1000)
      await supabase.from('automacoes_pendentes').insert({
        automacao_id: auto.id,
        user_id: auto.user_id,
        executar_em: executarEm.toISOString(),
        dados_evento: dadosComProduto,
        status: 'PENDENTE',
      })
      console.log(
        `[automacao] ${auto.nome} agendada pra ${executarEm.toISOString()}`
      )
      agendadas++
    }
  }

  return { ok: true, disparadas, agendadas }
}

/**
 * Executa uma automacao individualmente: cria/reusa conversa, envia msg template.
 */
export const executarAutomacao = async (
  auto: AutomacaoRow,
  dados: DadosEvento & { nomeProduto?: string }
): Promise<void> => {
  const tel = normalizarTelefone(dados.telefone)
  if (!tel) {
    console.warn(`[automacao:${auto.nome}] telefone invalido: ${dados.telefone}`)
    return
  }

  // Encontra instancia WhatsApp ativa do usuario
  const { data: instancia } = await supabase
    .from('instancias_whatsapp')
    .select('id, evolution_instance_id')
    .eq('user_id', auto.user_id)
    .eq('status', 'CONECTADO')
    .order('criado_em', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!instancia) {
    console.warn(`[automacao:${auto.nome}] sem instancia WhatsApp conectada`)
    return
  }
  const instanceName = instancia.evolution_instance_id ?? instancia.id

  // Check se conversa ja existe
  const { data: existente } = await supabase
    .from('conversas')
    .select('id, modo, agente_id')
    .eq('user_id', auto.user_id)
    .eq('telefone', tel.fmt)
    .maybeSingle()

  if (existente && !auto.executar_se_existe) {
    console.log(
      `[automacao:${auto.nome}] conversa ja existe e executar_se_existe=false, skip`
    )
    return
  }

  let conversaId: string
  if (existente) {
    conversaId = existente.id
    if (auto.agente_id) {
      await supabase
        .from('conversas')
        .update({ agente_id: auto.agente_id, modo: 'IA' })
        .eq('id', conversaId)
    }
  } else {
    const cores = ['#3b82f6', '#10b981', '#8b5cf6', '#f59e0b', '#ec4899']
    const { data: nova, error } = await supabase
      .from('conversas')
      .insert({
        user_id: auto.user_id,
        instancia_whatsapp_id: instancia.id,
        nome_contato: dados.nome || tel.fmt,
        telefone: tel.fmt,
        status: 'EM_ATENDIMENTO',
        modo: auto.agente_id ? 'IA' : 'HUMANO',
        agente_id: auto.agente_id,
        avatar_cor: cores[Math.floor(Math.random() * cores.length)],
        ultima_mensagem: `🔔 ${auto.nome}`,
        ultima_mensagem_em: new Date().toISOString(),
        nao_lidas: 1,
      })
      .select('id')
      .single()

    if (error || !nova) {
      console.error(`[automacao:${auto.nome}] erro criar conversa:`, error)
      return
    }
    conversaId = nova.id
  }

  // Envia mensagem inicial (se configurada)
  if (auto.mensagem_inicial && auto.mensagem_inicial.trim()) {
    const msg = aplicarTemplate(auto.mensagem_inicial, {
      nome: dados.nome,
      produto: dados.nomeProduto,
      email: dados.email,
    })

    try {
      const resp = (await evolution.enviarTexto(instanceName, tel.cru, msg)) as {
        key?: { id?: string }
      }
      const whatsappId = resp?.key?.id ?? null

      await supabase.from('mensagens').insert({
        conversa_id: conversaId,
        user_id: auto.user_id,
        tipo: 'OUTGOING_HUMANO',
        conteudo: msg,
        tipo_midia: 'TEXTO',
        whatsapp_message_id: whatsappId,
        status: 'ENVIADA',
      })

      await supabase
        .from('conversas')
        .update({
          ultima_mensagem: msg,
          ultima_mensagem_em: new Date().toISOString(),
        })
        .eq('id', conversaId)

      console.log(`[automacao:${auto.nome}] ✅ msg enviada pra ${tel.fmt}`)
    } catch (e) {
      console.error(`[automacao:${auto.nome}] erro enviar msg:`, e)
    }
  } else {
    console.log(
      `[automacao:${auto.nome}] sem msg configurada, conversa criada/atualizada`
    )
  }
}
