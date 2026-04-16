import { Hono } from 'hono'
import { supabase } from '../lib/supabase.js'
import {
  dispararAutomacoes,
  type EventoAutomacao,
  type DadosEvento,
} from '../services/executar-automacao.js'
import { logCheckout } from '../services/log-checkout.js'

export const webhooksCheckoutRoutes = new Hono()

/**
 * Valida o webhook_secret e retorna a integracao correspondente.
 */
const validarSecret = async (
  provedor: string,
  secret: string | undefined
): Promise<{ id: string; user_id: string } | null> => {
  if (!secret) return null
  const { data } = await supabase
    .from('integracoes_checkout')
    .select('id, user_id')
    .eq('provedor', provedor)
    .eq('webhook_secret', secret)
    .eq('status', 'ATIVO')
    .maybeSingle()
  return data
}

/** Pega numero de diferentes formatos: "997", "997,00", "R$ 997", 99700 (centavos) */
const parseValor = (raw: unknown): number | undefined => {
  if (raw == null) return undefined
  if (typeof raw === 'number') return raw > 1000000 ? raw / 100 : raw // muito grande = centavos
  if (typeof raw === 'string') {
    const clean = raw.replace(/[^\d.,]/g, '').replace(/\./g, '').replace(',', '.')
    const n = parseFloat(clean)
    return isNaN(n) ? undefined : n
  }
  return undefined
}

// =============================================================================
// HOTMART
// =============================================================================
// Docs: https://developers.hotmart.com/docs/pt-BR/2.0.0/webhook/purchase-webhook/

interface HotmartPayload {
  event?: string
  data?: {
    buyer?: { name?: string; email?: string; checkout_phone?: string }
    product?: {
      id?: string | number
      name?: string
      content?: { access_url?: string }
    }
    purchase?: {
      status?: string
      price?: { value?: number; currency_value?: string }
      payment?: {
        type?: string
        method?: string
        installments_number?: number
        billet_url?: string
        billet_barcode?: string
        pix_code?: string
      }
    }
    subscription?: { subscriber?: { code?: string } }
  }
}

/** Mapeia evento Hotmart → evento interno */
const mapearEventoHotmart = (
  evento: string,
  status: string
): EventoAutomacao | null => {
  const e = evento.toUpperCase()
  const s = status.toUpperCase()

  if (['PURCHASE_APPROVED', 'PURCHASE_COMPLETE'].includes(e)) return 'COMPRA_APROVADA'
  if (['APPROVED', 'COMPLETE'].includes(s)) return 'COMPRA_APROVADA'

  if (e === 'PURCHASE_REFUNDED' || s === 'REFUNDED') return 'REEMBOLSO'
  if (e === 'PURCHASE_CANCELED' || s === 'CANCELED') return 'COMPRA_RECUSADA'

  if (e === 'PURCHASE_BILLET_PRINTED') return 'BOLETO_GERADO'
  if (e === 'PURCHASE_EXPIRED') return 'PAGAMENTO_EXPIRADO'
  if (e === 'PURCHASE_DELAYED') return 'PAGAMENTO_ATRASADO'
  if (e === 'PURCHASE_CHARGEBACK') return 'CHARGEBACK'
  if (e === 'PURCHASE_PROTEST') return 'PROTESTO'

  if (e === 'SUBSCRIPTION_CANCELLATION') return 'ASSINATURA_CANCELADA'

  if (e === 'PURCHASE_OUT_OF_SHOPPING_CART') return 'CARRINHO_ABANDONADO'

  return null
}

webhooksCheckoutRoutes.post('/hotmart', async (c) => {
  const secret = c.req.query('secret')
  const integracao = await validarSecret('HOTMART', secret)
  if (!integracao) return c.json({ error: 'Invalid or missing secret' }, 401)

  const body = (await c.req.json().catch(() => ({}))) as HotmartPayload
  const evento = body.event ?? ''
  const status = body.data?.purchase?.status ?? ''
  console.log(`[hotmart] evento=${evento} status=${status}`)

  const eventoInterno = mapearEventoHotmart(evento, status)

  if (!eventoInterno) {
    logCheckout({
      integracaoId: integracao.id,
      userId: integracao.user_id,
      provedor: 'HOTMART',
      evento: evento || status || 'desconhecido',
      statusWebhook: 'IGNORADO',
      payload: body,
      erroMensagem: 'evento nao mapeado',
    })
    return c.json({ ok: true, ignored: true, reason: `evento ${evento} nao mapeado` })
  }

  const buyer = body.data?.buyer
  const product = body.data?.product
  const purchase = body.data?.purchase

  if (!buyer?.checkout_phone || !product?.id) {
    logCheckout({
      integracaoId: integracao.id,
      userId: integracao.user_id,
      provedor: 'HOTMART',
      evento: eventoInterno,
      statusWebhook: 'ERRO',
      payload: body,
      erroMensagem: 'Payload incompleto (phone ou product.id)',
    })
    return c.json({ error: 'Payload incompleto' }, 400)
  }

  const dados: DadosEvento = {
    integracaoId: integracao.id,
    provedor: 'HOTMART',
    nome: buyer.name ?? 'Cliente',
    email: buyer.email,
    telefone: buyer.checkout_phone,
    idExternoProduto: String(product.id),
    nomeProduto: product.name,
    valor: parseValor(purchase?.price?.value),
    metodoPagamento: purchase?.payment?.type ?? purchase?.payment?.method,
    parcelas: purchase?.payment?.installments_number,
    linkAcesso: product.content?.access_url,
    boletoUrl: purchase?.payment?.billet_url,
    pixCodigo: purchase?.payment?.pix_code,
  }

  const resultado = await dispararAutomacoes(eventoInterno, dados)

  logCheckout({
    integracaoId: integracao.id,
    userId: integracao.user_id,
    provedor: 'HOTMART',
    evento: eventoInterno,
    statusWebhook: 'SUCESSO',
    payload: {
      evento,
      status,
      buyer: { name: buyer.name, email: buyer.email },
      product: { id: product.id, name: product.name },
      valor: dados.valor,
      metodoPagamento: dados.metodoPagamento,
    },
  })

  return c.json(resultado)
})

// =============================================================================
// KIWIFY
// =============================================================================
// Docs: https://docs.kiwify.com.br/api-reference/webhooks

interface KiwifyPayload {
  order_status?: string
  webhook_event_type?: string
  Customer?: {
    first_name?: string
    last_name?: string
    full_name?: string
    email?: string
    mobile?: string
  }
  Product?: { product_id?: string; product_name?: string }
  Commissions?: { charge_amount?: number; net_amount?: number }
  payment_method?: string
  installments?: number
  net_amount?: number
  charge_amount?: number
  boleto_url?: string
  pix_code?: string
  payment?: { amount?: number; method?: string; type?: string }
}

const mapearEventoKiwify = (status: string): EventoAutomacao | null => {
  const s = status.toLowerCase().trim()

  if (['paid', 'approved', 'compra_aprovada', 'order_approved'].includes(s))
    return 'COMPRA_APROVADA'

  if (['refunded', 'reembolsado', 'compra_reembolsada'].includes(s)) return 'REEMBOLSO'

  if (['canceled', 'cancelled', 'refused', 'compra_recusada'].includes(s))
    return 'COMPRA_RECUSADA'

  if (s === 'boleto_gerado' || s === 'billet_generated') return 'BOLETO_GERADO'
  if (s === 'pix_gerado' || s === 'pix_generated') return 'PIX_GERADO'
  if (s === 'chargeback') return 'CHARGEBACK'

  if (s === 'subscription_canceled') return 'ASSINATURA_CANCELADA'
  if (s === 'subscription_late') return 'ASSINATURA_ATRASADA'
  if (s === 'subscription_renewed') return 'ASSINATURA_RENOVADA'

  if (s.includes('abandoned') || s.includes('abandonado') || s === 'carrinho_abandonado')
    return 'CARRINHO_ABANDONADO'

  return null
}

webhooksCheckoutRoutes.post('/kiwify', async (c) => {
  const secret = c.req.query('secret')
  const integracao = await validarSecret('KIWIFY', secret)
  if (!integracao) return c.json({ error: 'Invalid or missing secret' }, 401)

  const body = (await c.req.json().catch(() => ({}))) as KiwifyPayload
  const status = (body.order_status ?? body.webhook_event_type ?? '').toLowerCase()
  console.log(`[kiwify] status=${status}`)

  const eventoInterno = mapearEventoKiwify(status)

  if (!eventoInterno) {
    logCheckout({
      integracaoId: integracao.id,
      userId: integracao.user_id,
      provedor: 'KIWIFY',
      evento: status || 'desconhecido',
      statusWebhook: 'IGNORADO',
      payload: body,
      erroMensagem: 'status nao mapeado',
    })
    return c.json({ ok: true, ignored: true, reason: `status ${status} nao mapeado` })
  }

  const customer = body.Customer
  const product = body.Product

  if (!customer?.mobile || !product?.product_id) {
    logCheckout({
      integracaoId: integracao.id,
      userId: integracao.user_id,
      provedor: 'KIWIFY',
      evento: eventoInterno,
      statusWebhook: 'ERRO',
      payload: body,
      erroMensagem: 'Payload incompleto',
    })
    return c.json({ error: 'Payload incompleto' }, 400)
  }

  const nome =
    customer.full_name ??
    `${customer.first_name ?? ''} ${customer.last_name ?? ''}`.trim() ??
    'Cliente'

  const dados: DadosEvento = {
    integracaoId: integracao.id,
    provedor: 'KIWIFY',
    nome,
    email: customer.email,
    telefone: customer.mobile,
    idExternoProduto: product.product_id,
    nomeProduto: product.product_name,
    valor: parseValor(body.payment?.amount ?? body.charge_amount ?? body.net_amount),
    metodoPagamento: body.payment_method ?? body.payment?.method ?? body.payment?.type,
    parcelas: body.installments,
    boletoUrl: body.boleto_url,
    pixCodigo: body.pix_code,
  }

  const resultado = await dispararAutomacoes(eventoInterno, dados)

  logCheckout({
    integracaoId: integracao.id,
    userId: integracao.user_id,
    provedor: 'KIWIFY',
    evento: eventoInterno,
    statusWebhook: 'SUCESSO',
    payload: {
      status,
      customer: { name: nome, email: customer.email },
      product,
      valor: dados.valor,
      metodoPagamento: dados.metodoPagamento,
    },
  })

  return c.json(resultado)
})

// =============================================================================
// TICTO
// =============================================================================
// Docs: https://webhook.ticto.dev/docs/v2

interface TictoPayload {
  status?: string
  event?: string
  version?: string
  payment_method?: string
  checkout_url?: string
  direct_login_url?: string
  customer?: { name?: string; email?: string; phone?: string }
  product?: { id?: string | number; name?: string }
  item?: { id?: string | number; name?: string; amount?: number }
  order?: { id?: string | number; total?: number; status?: string }
  transaction?: {
    amount?: number
    installments?: number
    boleto_url?: string
    pix_code?: string
  }
}

const mapearEventoTicto = (status: string): EventoAutomacao | null => {
  const s = status.toLowerCase().trim()

  if (['authorized', 'paid', 'approved', 'compra_aprovada', 'venda realizada'].includes(s))
    return 'COMPRA_APROVADA'
  if (['refunded', 'reembolsado'].includes(s)) return 'REEMBOLSO'
  if (['canceled', 'cancelled', 'refused', 'venda recusada'].includes(s))
    return 'COMPRA_RECUSADA'

  if (s === 'boleto impresso' || s === 'boleto_impresso') return 'BOLETO_GERADO'
  if (s === 'boleto atrasado' || s === 'boleto_atrasado') return 'BOLETO_ATRASADO'
  if (s === 'pix gerado' || s === 'pix_gerado') return 'PIX_GERADO'
  if (s === 'pix expirado' || s === 'pix_expirado') return 'PIX_EXPIRADO'

  if (s === 'chargeback') return 'CHARGEBACK'

  if (
    s === 'cancelada' ||
    s === 'assinatura_cancelada' ||
    s === 'subscription_canceled'
  )
    return 'ASSINATURA_CANCELADA'
  if (s === 'atrasada' || s === 'assinatura_atrasada') return 'ASSINATURA_ATRASADA'
  if (
    s === 'extendida' ||
    s === 'retomada' ||
    s === 'assinatura_renovada' ||
    s === 'renovada'
  )
    return 'ASSINATURA_RENOVADA'
  if (
    s === 'período de testes iniciado' ||
    s === 'periodo_testes_iniciado' ||
    s === 'trial_iniciado'
  )
    return 'TRIAL_INICIADO'
  if (
    s === 'período de testes encerrado' ||
    s === 'periodo_testes_encerrado' ||
    s === 'trial_encerrado'
  )
    return 'TRIAL_ENCERRADO'

  if (s.includes('abandoned') || s.includes('abandonado')) return 'CARRINHO_ABANDONADO'

  return null
}

webhooksCheckoutRoutes.post('/ticto', async (c) => {
  const secret = c.req.query('secret')
  const integracao = await validarSecret('TICTO', secret)
  if (!integracao) return c.json({ error: 'Invalid or missing secret' }, 401)

  const body = (await c.req.json().catch(() => ({}))) as TictoPayload
  const status = (body.status ?? body.event ?? '').toLowerCase()
  console.log(`[ticto] status=${status}`)

  const eventoInterno = mapearEventoTicto(status)

  if (!eventoInterno) {
    logCheckout({
      integracaoId: integracao.id,
      userId: integracao.user_id,
      provedor: 'TICTO',
      evento: status || 'desconhecido',
      statusWebhook: 'IGNORADO',
      payload: body,
      erroMensagem: 'status nao mapeado',
    })
    return c.json({ ok: true, ignored: true, reason: `status ${status} nao mapeado` })
  }

  const customer = body.customer
  const product = body.product ?? body.item

  if (!customer?.phone || !product?.id) {
    logCheckout({
      integracaoId: integracao.id,
      userId: integracao.user_id,
      provedor: 'TICTO',
      evento: eventoInterno,
      statusWebhook: 'ERRO',
      payload: body,
      erroMensagem: 'Payload incompleto',
    })
    return c.json({ error: 'Payload incompleto' }, 400)
  }

  const dados: DadosEvento = {
    integracaoId: integracao.id,
    provedor: 'TICTO',
    nome: customer.name ?? 'Cliente',
    email: customer.email,
    telefone: customer.phone,
    idExternoProduto: String(product.id),
    nomeProduto: product.name,
    valor: parseValor(
      body.transaction?.amount ?? body.order?.total ?? body.item?.amount
    ),
    metodoPagamento: body.payment_method,
    parcelas: body.transaction?.installments,
    linkAcesso: body.direct_login_url,
    boletoUrl: body.transaction?.boleto_url,
    pixCodigo: body.transaction?.pix_code,
  }

  const resultado = await dispararAutomacoes(eventoInterno, dados)

  logCheckout({
    integracaoId: integracao.id,
    userId: integracao.user_id,
    provedor: 'TICTO',
    evento: eventoInterno,
    statusWebhook: 'SUCESSO',
    payload: {
      status,
      customer: { name: customer.name, email: customer.email },
      product,
      valor: dados.valor,
      metodoPagamento: dados.metodoPagamento,
    },
  })

  return c.json(resultado)
})

// =============================================================================
// SIMULAR (teste sem provedor real)
// =============================================================================

webhooksCheckoutRoutes.post('/simular', async (c) => {
  const secret = c.req.query('secret')
  const provedor = (c.req.query('provedor') ?? 'HOTMART').toUpperCase() as
    | 'HOTMART'
    | 'KIWIFY'
    | 'TICTO'
  const evento = (c.req.query('evento') ?? 'COMPRA_APROVADA') as EventoAutomacao
  const integracao = await validarSecret(provedor, secret)
  if (!integracao) return c.json({ error: 'Invalid or missing secret' }, 401)

  const body = (await c.req.json().catch(() => ({}))) as {
    nome?: string
    email?: string
    telefone?: string
    idExternoProduto?: string
    nomeProduto?: string
    valor?: number
    metodoPagamento?: string
    parcelas?: number
    linkAcesso?: string
    boletoUrl?: string
    pixCodigo?: string
  }

  if (!body.telefone || !body.idExternoProduto) {
    return c.json({ error: 'telefone e idExternoProduto sao obrigatorios' }, 400)
  }

  const resultado = await dispararAutomacoes(evento, {
    integracaoId: integracao.id,
    provedor,
    nome: body.nome ?? 'Cliente Teste',
    email: body.email,
    telefone: body.telefone,
    idExternoProduto: body.idExternoProduto,
    nomeProduto: body.nomeProduto ?? 'Produto Teste',
    valor: body.valor,
    metodoPagamento: body.metodoPagamento,
    parcelas: body.parcelas,
    linkAcesso: body.linkAcesso,
    boletoUrl: body.boletoUrl,
    pixCodigo: body.pixCodigo,
  })

  return c.json(resultado)
})
