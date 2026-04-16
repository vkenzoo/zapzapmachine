import { Hono } from 'hono'
import { supabase } from '../lib/supabase.js'
import { dispararAutomacoes, type EventoAutomacao } from '../services/executar-automacao.js'
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

// =============================================================================
// HOTMART
// =============================================================================

webhooksCheckoutRoutes.post('/hotmart', async (c) => {
  const secret = c.req.query('secret')
  const integracao = await validarSecret('HOTMART', secret)
  if (!integracao) return c.json({ error: 'Invalid or missing secret' }, 401)

  const body = (await c.req.json().catch(() => ({}))) as {
    event?: string
    data?: {
      buyer?: { name?: string; email?: string; checkout_phone?: string }
      product?: { id?: string | number; name?: string }
      purchase?: { status?: string }
    }
  }

  const evento = body.event ?? ''
  const status = body.data?.purchase?.status ?? ''
  console.log(`[hotmart] evento=${evento} status=${status}`)

  // Mapear evento Hotmart → nosso evento interno
  let eventoInterno: EventoAutomacao | null = null
  if (
    ['PURCHASE_APPROVED', 'PURCHASE_COMPLETE'].includes(evento) ||
    ['APPROVED', 'COMPLETE'].includes(status)
  ) {
    eventoInterno = 'COMPRA_APROVADA'
  } else if (evento === 'PURCHASE_REFUNDED' || status === 'REFUNDED') {
    eventoInterno = 'REEMBOLSO'
  } else if (evento === 'PURCHASE_CANCELED' || status === 'CANCELED') {
    eventoInterno = 'COMPRA_RECUSADA'
  } else if (evento === 'SUBSCRIPTION_CANCELLATION') {
    eventoInterno = 'ASSINATURA_CANCELADA'
  } else if (evento === 'PURCHASE_OUT_OF_SHOPPING_CART') {
    eventoInterno = 'CARRINHO_ABANDONADO'
  }

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

  const resultado = await dispararAutomacoes(eventoInterno, {
    integracaoId: integracao.id,
    provedor: 'HOTMART',
    nome: buyer.name ?? 'Cliente',
    email: buyer.email,
    telefone: buyer.checkout_phone,
    idExternoProduto: String(product.id),
    nomeProduto: product.name,
  })

  logCheckout({
    integracaoId: integracao.id,
    userId: integracao.user_id,
    provedor: 'HOTMART',
    evento: eventoInterno,
    statusWebhook: 'SUCESSO',
    payload: { evento, status, buyer: { name: buyer.name, email: buyer.email }, product },
  })

  return c.json(resultado)
})

// =============================================================================
// KIWIFY
// =============================================================================

webhooksCheckoutRoutes.post('/kiwify', async (c) => {
  const secret = c.req.query('secret')
  const integracao = await validarSecret('KIWIFY', secret)
  if (!integracao) return c.json({ error: 'Invalid or missing secret' }, 401)

  const body = (await c.req.json().catch(() => ({}))) as {
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
  }

  const status = (body.order_status ?? body.webhook_event_type ?? '').toLowerCase()
  console.log(`[kiwify] status=${status}`)

  let eventoInterno: EventoAutomacao | null = null
  if (['paid', 'approved', 'compra_aprovada', 'order_approved'].includes(status)) {
    eventoInterno = 'COMPRA_APROVADA'
  } else if (['refunded', 'reembolsado'].includes(status)) {
    eventoInterno = 'REEMBOLSO'
  } else if (['canceled', 'cancelled', 'refused'].includes(status)) {
    eventoInterno = 'COMPRA_RECUSADA'
  } else if (status.includes('abandoned') || status.includes('abandonado')) {
    eventoInterno = 'CARRINHO_ABANDONADO'
  }

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
      erroMensagem: 'Payload incompleto (mobile ou product_id)',
    })
    return c.json({ error: 'Payload incompleto' }, 400)
  }

  const nome =
    customer.full_name ??
    `${customer.first_name ?? ''} ${customer.last_name ?? ''}`.trim() ??
    'Cliente'

  const resultado = await dispararAutomacoes(eventoInterno, {
    integracaoId: integracao.id,
    provedor: 'KIWIFY',
    nome,
    email: customer.email,
    telefone: customer.mobile,
    idExternoProduto: product.product_id,
    nomeProduto: product.product_name,
  })

  logCheckout({
    integracaoId: integracao.id,
    userId: integracao.user_id,
    provedor: 'KIWIFY',
    evento: eventoInterno,
    statusWebhook: 'SUCESSO',
    payload: { status, customer: { name: nome, email: customer.email }, product },
  })

  return c.json(resultado)
})

// =============================================================================
// TICTO
// =============================================================================

webhooksCheckoutRoutes.post('/ticto', async (c) => {
  const secret = c.req.query('secret')
  const integracao = await validarSecret('TICTO', secret)
  if (!integracao) return c.json({ error: 'Invalid or missing secret' }, 401)

  const body = (await c.req.json().catch(() => ({}))) as {
    status?: string
    event?: string
    customer?: { name?: string; email?: string; phone?: string }
    product?: { id?: string | number; name?: string }
  }

  const status = (body.status ?? body.event ?? '').toLowerCase()
  console.log(`[ticto] status=${status}`)

  let eventoInterno: EventoAutomacao | null = null
  if (['approved', 'paid', 'authorized', 'compra_aprovada'].includes(status)) {
    eventoInterno = 'COMPRA_APROVADA'
  } else if (['refunded', 'reembolsado'].includes(status)) {
    eventoInterno = 'REEMBOLSO'
  } else if (['canceled', 'cancelled', 'refused'].includes(status)) {
    eventoInterno = 'COMPRA_RECUSADA'
  } else if (status.includes('abandoned') || status.includes('abandonado')) {
    eventoInterno = 'CARRINHO_ABANDONADO'
  }

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
  const product = body.product

  if (!customer?.phone || !product?.id) {
    logCheckout({
      integracaoId: integracao.id,
      userId: integracao.user_id,
      provedor: 'TICTO',
      evento: eventoInterno,
      statusWebhook: 'ERRO',
      payload: body,
      erroMensagem: 'Payload incompleto (phone ou product.id)',
    })
    return c.json({ error: 'Payload incompleto' }, 400)
  }

  const resultado = await dispararAutomacoes(eventoInterno, {
    integracaoId: integracao.id,
    provedor: 'TICTO',
    nome: customer.name ?? 'Cliente',
    email: customer.email,
    telefone: customer.phone,
    idExternoProduto: String(product.id),
    nomeProduto: product.name,
  })

  logCheckout({
    integracaoId: integracao.id,
    userId: integracao.user_id,
    provedor: 'TICTO',
    evento: eventoInterno,
    statusWebhook: 'SUCESSO',
    payload: { status, customer: { name: customer.name, email: customer.email }, product },
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
  })

  return c.json(resultado)
})
