import { Hono } from 'hono'
import { supabase } from '../lib/supabase.js'
import { processarCompra } from '../services/processar-compra.js'

export const webhooksCheckoutRoutes = new Hono()

/**
 * Valida o webhook_secret e retorna a integracao correspondente.
 * Cada integracao tem um secret unico — usuario cola ele no painel do provedor
 * como parte da URL: /webhooks/checkout/hotmart?secret=XXX
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
// HOTMART — https://developers.hotmart.com/docs/pt-BR/webhooks/listening-webhook/
// Payload: { event, data: { buyer: { name, email, document, checkout_phone }, product: { id, name }, purchase: { status } } }
// Status relevante: PURCHASE_APPROVED | PURCHASE_COMPLETE
// =============================================================================

webhooksCheckoutRoutes.post('/hotmart', async (c) => {
  const secret = c.req.query('secret')
  const integracao = await validarSecret('HOTMART', secret)
  if (!integracao) return c.json({ error: 'Invalid or missing secret' }, 401)

  const body = (await c.req.json().catch(() => ({}))) as {
    event?: string
    data?: {
      buyer?: {
        name?: string
        email?: string
        checkout_phone?: string
        document?: string
      }
      product?: { id?: string | number; name?: string }
      purchase?: { status?: string }
    }
  }

  const evento = body.event ?? ''
  const status = body.data?.purchase?.status ?? ''

  console.log(`[hotmart] evento=${evento} status=${status}`)

  // Processa apenas compras aprovadas / completadas
  if (
    !['PURCHASE_APPROVED', 'PURCHASE_COMPLETE'].includes(evento) &&
    !['APPROVED', 'COMPLETE'].includes(status)
  ) {
    return c.json({ ok: true, ignored: true, reason: 'evento nao aprovacao' })
  }

  const buyer = body.data?.buyer
  const product = body.data?.product

  if (!buyer?.checkout_phone || !product?.id) {
    return c.json(
      { error: 'Payload incompleto (falta checkout_phone ou product.id)' },
      400
    )
  }

  const resultado = await processarCompra({
    integracaoId: integracao.id,
    provedor: 'HOTMART',
    dados: {
      nome: buyer.name ?? 'Cliente',
      email: buyer.email,
      telefone: buyer.checkout_phone,
      idExternoProduto: String(product.id),
      nomeProduto: product.name,
    },
  })

  if (!resultado.ok) {
    console.error('[hotmart] falha:', resultado.motivo)
    return c.json({ error: resultado.motivo }, 500)
  }
  return c.json({ ok: true, conversaId: resultado.conversaId })
})

// =============================================================================
// KIWIFY — https://docs.kiwify.com.br/api-reference/webhooks
// Payload: { order_id, order_status, Customer: { first_name, last_name, email, mobile }, Product: { product_id, product_name } }
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
      CPF?: string
    }
    Product?: { product_id?: string; product_name?: string }
  }

  const status = body.order_status ?? body.webhook_event_type ?? ''
  console.log(`[kiwify] status=${status}`)

  // Processa apenas "paid" / "approved"
  const statusAprovado = ['paid', 'approved', 'compra_aprovada', 'order_approved']
  if (!statusAprovado.includes(status.toLowerCase())) {
    return c.json({ ok: true, ignored: true, reason: 'nao aprovado' })
  }

  const customer = body.Customer
  const product = body.Product

  if (!customer?.mobile || !product?.product_id) {
    return c.json(
      { error: 'Payload incompleto (mobile ou product_id)' },
      400
    )
  }

  const nome =
    customer.full_name ??
    `${customer.first_name ?? ''} ${customer.last_name ?? ''}`.trim() ??
    'Cliente'

  const resultado = await processarCompra({
    integracaoId: integracao.id,
    provedor: 'KIWIFY',
    dados: {
      nome,
      email: customer.email,
      telefone: customer.mobile,
      idExternoProduto: product.product_id,
      nomeProduto: product.product_name,
    },
  })

  if (!resultado.ok) {
    console.error('[kiwify] falha:', resultado.motivo)
    return c.json({ error: resultado.motivo }, 500)
  }
  return c.json({ ok: true, conversaId: resultado.conversaId })
})

// =============================================================================
// TICTO — payload similar, campos podem variar
// Documentacao: https://tictotalk.com.br/webhooks (simplificado)
// =============================================================================

webhooksCheckoutRoutes.post('/ticto', async (c) => {
  const secret = c.req.query('secret')
  const integracao = await validarSecret('TICTO', secret)
  if (!integracao) return c.json({ error: 'Invalid or missing secret' }, 401)

  const body = (await c.req.json().catch(() => ({}))) as {
    status?: string
    event?: string
    customer?: {
      name?: string
      email?: string
      phone?: string
    }
    product?: {
      id?: string | number
      name?: string
    }
  }

  const status = body.status ?? body.event ?? ''
  console.log(`[ticto] status=${status}`)

  const statusAprovado = ['approved', 'paid', 'authorized', 'compra_aprovada']
  if (!statusAprovado.includes(status.toLowerCase())) {
    return c.json({ ok: true, ignored: true, reason: 'nao aprovado' })
  }

  const customer = body.customer
  const product = body.product

  if (!customer?.phone || !product?.id) {
    return c.json({ error: 'Payload incompleto (phone ou product.id)' }, 400)
  }

  const resultado = await processarCompra({
    integracaoId: integracao.id,
    provedor: 'TICTO',
    dados: {
      nome: customer.name ?? 'Cliente',
      email: customer.email,
      telefone: customer.phone,
      idExternoProduto: String(product.id),
      nomeProduto: product.name,
    },
  })

  if (!resultado.ok) {
    console.error('[ticto] falha:', resultado.motivo)
    return c.json({ error: resultado.motivo }, 500)
  }
  return c.json({ ok: true, conversaId: resultado.conversaId })
})

// =============================================================================
// Rota de teste — simula compra sem precisar do provedor real
// POST /webhooks/checkout/simular?secret=XXX
// Body: { nome, email, telefone, idExternoProduto, nomeProduto, provedor }
// =============================================================================

webhooksCheckoutRoutes.post('/simular', async (c) => {
  const secret = c.req.query('secret')
  const provedor = c.req.query('provedor') ?? 'HOTMART'
  const integracao = await validarSecret(provedor.toUpperCase(), secret)
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

  const resultado = await processarCompra({
    integracaoId: integracao.id,
    provedor: 'SIMULAR',
    dados: {
      nome: body.nome ?? 'Cliente Teste',
      email: body.email,
      telefone: body.telefone,
      idExternoProduto: body.idExternoProduto,
      nomeProduto: body.nomeProduto ?? 'Produto Teste',
    },
  })

  if (!resultado.ok) return c.json({ error: resultado.motivo }, 500)
  return c.json({ ok: true, conversaId: resultado.conversaId })
})
