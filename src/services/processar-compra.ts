import { supabase } from '../lib/supabase.js'
import { evolution } from '../lib/evolution.js'

interface DadosCompra {
  /** Nome completo do comprador */
  nome: string
  /** Email (opcional) */
  email?: string
  /** Telefone cru ou formatado — normalizamos aqui */
  telefone: string
  /** ID externo do produto no provedor (ex: ID do Hotmart) */
  idExternoProduto: string
  /** Nome do produto (fallback se nao tiver registrado) */
  nomeProduto?: string
}

interface ProcessarCompraInput {
  /** ID da integracao_checkout (apos validar webhook_secret) */
  integracaoId: string
  /** Provedor pra logs */
  provedor: string
  dados: DadosCompra
}

/**
 * Normaliza telefone: remove tudo que nao eh digito, garante +55 prefix,
 * formata pra +55 XX XXXXX-XXXX.
 */
const normalizarTelefone = (raw: string): { fmt: string; cru: string } | null => {
  let digits = raw.replace(/\D/g, '')
  if (!digits) return null

  // Se veio sem codigo de pais, assume 55 (BR)
  if (digits.length === 10 || digits.length === 11) {
    digits = '55' + digits
  }
  // Se tem mais de 13 digitos, provavelmente eh erro
  if (digits.length > 13) return null
  if (digits.length < 12) return null

  // Formato final: +55 XX XXXXX-XXXX ou +55 XX XXXX-XXXX (telefones antigos sem 9)
  const ddd = digits.slice(2, 4)
  const rest = digits.slice(4)
  let numero = rest
  if (rest.length === 9) numero = `${rest.slice(0, 5)}-${rest.slice(5)}`
  if (rest.length === 8) numero = `${rest.slice(0, 4)}-${rest.slice(4)}`
  const fmt = `+55 ${ddd} ${numero}`
  return { fmt, cru: digits }
}

/**
 * Substitui placeholders no template.
 */
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
 * Processa uma compra recebida via webhook.
 * - Valida telefone
 * - Busca produto vinculado → agente
 * - Cria ou atualiza conversa
 * - Envia primeira mensagem (template) via Evolution
 * - Marca conversa como modo=IA se tiver agente
 */
export const processarCompra = async ({
  integracaoId,
  provedor,
  dados,
}: ProcessarCompraInput): Promise<
  { ok: true; conversaId: string } | { ok: false; motivo: string }
> => {
  console.log(`[compra:${provedor}] processando — produto=${dados.idExternoProduto}`)

  // 1. Normaliza telefone
  const tel = normalizarTelefone(dados.telefone)
  if (!tel) {
    return { ok: false, motivo: `Telefone invalido: ${dados.telefone}` }
  }

  // 2. Busca integracao + user_id + instancia WhatsApp do user
  const { data: integracao } = await supabase
    .from('integracoes_checkout')
    .select('id, user_id, status')
    .eq('id', integracaoId)
    .maybeSingle()

  if (!integracao || integracao.status !== 'ATIVO') {
    return { ok: false, motivo: 'Integracao inativa ou nao encontrada' }
  }

  // 3. Busca produto (pra pegar agente + template)
  const { data: produto } = await supabase
    .from('produtos_checkout')
    .select('id, nome_produto, agente_vinculado_id, template_primeira_mensagem')
    .eq('integracao_id', integracaoId)
    .eq('id_externo_produto', dados.idExternoProduto)
    .maybeSingle()

  // Se nao existe, cria automaticamente (sem agente/template — pra aparecer no dashboard e user configurar)
  let produtoId = produto?.id
  if (!produto) {
    const { data: novo } = await supabase
      .from('produtos_checkout')
      .insert({
        integracao_id: integracaoId,
        id_externo_produto: dados.idExternoProduto,
        nome_produto: dados.nomeProduto ?? dados.idExternoProduto,
      })
      .select('id')
      .single()
    produtoId = novo?.id
  }

  const agenteId = produto?.agente_vinculado_id ?? null
  const nomeProduto = produto?.nome_produto ?? dados.nomeProduto ?? dados.idExternoProduto
  const template = produto?.template_primeira_mensagem ?? null

  // 4. Encontra instancia WhatsApp ativa do user
  const { data: instancia } = await supabase
    .from('instancias_whatsapp')
    .select('id, evolution_instance_id')
    .eq('user_id', integracao.user_id)
    .eq('status', 'CONECTADO')
    .order('criado_em', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!instancia) {
    return {
      ok: false,
      motivo: 'Nenhuma instancia WhatsApp conectada pro usuario',
    }
  }
  const instanceName = instancia.evolution_instance_id ?? instancia.id

  // 5. Cria ou reaproveita conversa
  const { data: existente } = await supabase
    .from('conversas')
    .select('id')
    .eq('user_id', integracao.user_id)
    .eq('telefone', tel.fmt)
    .maybeSingle()

  let conversaId: string
  if (existente) {
    conversaId = existente.id
    // Atualiza agente + modo se ainda nao tinha
    if (agenteId) {
      await supabase
        .from('conversas')
        .update({ agente_id: agenteId, modo: 'IA' })
        .eq('id', conversaId)
    }
  } else {
    const cores = ['#3b82f6', '#10b981', '#8b5cf6', '#f59e0b', '#ec4899']
    const { data: nova, error } = await supabase
      .from('conversas')
      .insert({
        user_id: integracao.user_id,
        instancia_whatsapp_id: instancia.id,
        nome_contato: dados.nome || tel.fmt,
        telefone: tel.fmt,
        status: 'EM_ATENDIMENTO',
        modo: agenteId ? 'IA' : 'HUMANO',
        agente_id: agenteId,
        avatar_cor: cores[Math.floor(Math.random() * cores.length)],
        ultima_mensagem: `🛒 Nova compra: ${nomeProduto}`,
        ultima_mensagem_em: new Date().toISOString(),
        nao_lidas: 1,
      })
      .select('id')
      .single()

    if (error || !nova) {
      console.error('[compra] erro criar conversa:', error)
      return { ok: false, motivo: 'Erro ao criar conversa' }
    }
    conversaId = nova.id
  }

  // 6. Atualiza ultimo_recebimento da integracao
  await supabase
    .from('integracoes_checkout')
    .update({ ultimo_recebimento: new Date().toISOString() })
    .eq('id', integracaoId)

  // 7. Se tem template, envia primeira mensagem via Evolution
  if (template && template.trim()) {
    const msg = aplicarTemplate(template, {
      nome: dados.nome,
      produto: nomeProduto,
      email: dados.email,
    })

    try {
      const resp = (await evolution.enviarTexto(instanceName, tel.cru, msg)) as {
        key?: { id?: string }
      }
      const whatsappId = resp?.key?.id ?? null

      await supabase.from('mensagens').insert({
        conversa_id: conversaId,
        user_id: integracao.user_id,
        tipo: 'OUTGOING_HUMANO', // eh mensagem automatica mas nao IA (template fixo)
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

      console.log(`[compra:${provedor}] ✅ 1a msg enviada pra ${tel.fmt}`)
    } catch (e) {
      console.error('[compra] erro enviar 1a msg:', e)
      // Nao falha o webhook — conversa foi criada, IA continua atendendo quando cliente responder
    }
  } else {
    console.log(`[compra:${provedor}] sem template, conversa criada mas sem msg inicial`)
  }

  return { ok: true, conversaId }
}
