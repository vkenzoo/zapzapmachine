import { Hono } from 'hono'
import { z } from 'zod'
import { auth } from '../middleware/auth.js'
import { supabase } from '../lib/supabase.js'
import { evolution, mapearStatus } from '../lib/evolution.js'
import { env } from '../lib/env.js'

export const whatsappRoutes = new Hono<{
  Variables: { userId: string }
}>()

whatsappRoutes.use('/*', auth)

const criarSchema = z.object({
  nome: z.string().min(3).max(80),
})

/**
 * POST /whatsapp/instancias
 * Cria uma nova instancia no Evolution + registra no banco.
 */
whatsappRoutes.post('/instancias', async (c) => {
  const userId = c.get('userId')
  const body = await c.req.json().catch(() => ({}))
  const parsed = criarSchema.safeParse(body)

  if (!parsed.success) {
    return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400)
  }

  // 1. Inserir no banco primeiro pra ter o UUID
  const { data: instancia, error } = await supabase
    .from('instancias_whatsapp')
    .insert({
      user_id: userId,
      nome_instancia: parsed.data.nome,
      status: 'CONECTANDO',
    })
    .select('id')
    .single()

  if (error || !instancia) {
    console.error('[criar instancia] erro supabase:', error)
    return c.json({ error: 'Erro ao salvar instancia' }, 500)
  }

  // 2. Criar no Evolution usando UUID como instanceName
  const webhookUrl = `${env().BACKEND_PUBLIC_URL}/webhooks/evolution?instance=${instancia.id}`

  try {
    await evolution.criarInstancia(instancia.id, webhookUrl)

    // Atualizar o evolution_instance_id (usamos o proprio UUID)
    await supabase
      .from('instancias_whatsapp')
      .update({ evolution_instance_id: instancia.id })
      .eq('id', instancia.id)

    return c.json({
      id: instancia.id,
      nomeInstancia: parsed.data.nome,
      status: 'CONECTANDO',
    })
  } catch (e) {
    // Rollback
    await supabase.from('instancias_whatsapp').delete().eq('id', instancia.id)
    console.error('[criar instancia] erro evolution:', e)
    return c.json({ error: 'Erro ao criar instancia no Evolution' }, 500)
  }
})

/**
 * GET /whatsapp/:id/qr
 * Retorna o QR code atual para conectar.
 */
whatsappRoutes.get('/:id/qr', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')

  // Valida ownership
  const { data: instancia } = await supabase
    .from('instancias_whatsapp')
    .select('id, evolution_instance_id, status')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle()

  if (!instancia) {
    return c.json({ error: 'Instancia nao encontrada' }, 404)
  }

  try {
    const resp = (await evolution.conectar(instancia.evolution_instance_id ?? id)) as {
      base64?: string
      code?: string
      pairingCode?: string
    }

    return c.json({
      qrCode: resp.base64 ?? null,
      code: resp.code ?? null,
    })
  } catch (e) {
    console.error('[obter qr] erro:', e)
    return c.json({ error: 'Erro ao gerar QR code' }, 500)
  }
})

/**
 * GET /whatsapp/:id/status
 * Polling endpoint — consulta Evolution + atualiza banco se mudou.
 */
whatsappRoutes.get('/:id/status', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')

  const { data: instancia } = await supabase
    .from('instancias_whatsapp')
    .select('id, evolution_instance_id, status, numero_conectado')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle()

  if (!instancia) {
    return c.json({ error: 'Instancia nao encontrada' }, 404)
  }

  try {
    const resp = (await evolution.status(instancia.evolution_instance_id ?? id)) as {
      instance?: { state?: string }
    }
    const novoStatus = mapearStatus(resp.instance?.state ?? 'close')

    if (novoStatus !== instancia.status) {
      await supabase
        .from('instancias_whatsapp')
        .update({ status: novoStatus })
        .eq('id', id)
    }

    return c.json({
      id,
      status: novoStatus,
      numeroConectado: instancia.numero_conectado,
    })
  } catch (e) {
    console.error('[status] erro:', e)
    return c.json({ error: 'Erro ao consultar status' }, 500)
  }
})

const enviarSchema = z.object({
  texto: z.string().min(1).max(4096),
})

/**
 * POST /whatsapp/conversas/:conversaId/enviar
 * Envia uma mensagem via Evolution (WhatsApp real) + salva no banco.
 */
whatsappRoutes.post('/conversas/:conversaId/enviar', async (c) => {
  const userId = c.get('userId')
  const conversaId = c.req.param('conversaId')
  const body = await c.req.json().catch(() => ({}))
  const parsed = enviarSchema.safeParse(body)

  if (!parsed.success) {
    return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400)
  }

  // 1. Busca conversa
  const { data: conversa, error: errConversa } = await supabase
    .from('conversas')
    .select('id, telefone, instancia_whatsapp_id')
    .eq('id', conversaId)
    .eq('user_id', userId)
    .maybeSingle()

  if (errConversa) {
    console.error('[enviar] erro query conversa:', errConversa)
    return c.json({ error: 'Erro ao buscar conversa' }, 500)
  }

  if (!conversa) {
    return c.json({ error: 'Conversa nao encontrada' }, 404)
  }

  if (!conversa.instancia_whatsapp_id) {
    return c.json({ error: 'Conversa sem instancia vinculada' }, 500)
  }

  // 2. Busca instancia separadamente
  const { data: instancia } = await supabase
    .from('instancias_whatsapp')
    .select('evolution_instance_id')
    .eq('id', conversa.instancia_whatsapp_id)
    .maybeSingle()

  const instanceName =
    instancia?.evolution_instance_id ?? conversa.instancia_whatsapp_id

  if (!instanceName) {
    return c.json({ error: 'Instancia do WhatsApp nao encontrada' }, 500)
  }

  // Telefone cru sem +/espaco/hifen pro Evolution
  const telefoneCru = conversa.telefone.replace(/\D/g, '')

  // 2. Envia via Evolution
  try {
    await evolution.enviarTexto(instanceName, telefoneCru, parsed.data.texto)
  } catch (e) {
    console.error('[enviar] erro Evolution:', e)
    return c.json({ error: 'Erro ao enviar mensagem no WhatsApp' }, 502)
  }

  // 3. Salva no banco
  const { data: msg, error } = await supabase
    .from('mensagens')
    .insert({
      conversa_id: conversaId,
      user_id: userId,
      tipo: 'OUTGOING_HUMANO',
      conteudo: parsed.data.texto,
      status: 'ENVIADA',
    })
    .select()
    .single()

  if (error) {
    console.error('[enviar] erro ao salvar mensagem:', error)
    return c.json({ error: 'Mensagem enviada mas erro ao salvar historico' }, 500)
  }

  // 4. Atualiza conversa
  await supabase
    .from('conversas')
    .update({
      ultima_mensagem: parsed.data.texto,
      ultima_mensagem_em: new Date().toISOString(),
    })
    .eq('id', conversaId)

  return c.json(msg)
})

/**
 * DELETE /whatsapp/:id
 * Desloga + deleta do Evolution + remove do banco.
 */
whatsappRoutes.delete('/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')

  const { data: instancia } = await supabase
    .from('instancias_whatsapp')
    .select('evolution_instance_id')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle()

  if (!instancia) {
    return c.json({ error: 'Instancia nao encontrada' }, 404)
  }

  try {
    await evolution.desconectar(instancia.evolution_instance_id ?? id).catch(() => null)
    await evolution.deletar(instancia.evolution_instance_id ?? id).catch(() => null)
  } catch (e) {
    console.warn('[delete] aviso evolution:', e)
  }

  await supabase.from('instancias_whatsapp').delete().eq('id', id)
  return c.json({ ok: true })
})
