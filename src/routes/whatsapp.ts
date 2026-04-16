import { Hono } from 'hono'
import { z } from 'zod'
import { auth } from '../middleware/auth.js'
import { supabase } from '../lib/supabase.js'
import { evolution, mapearStatus } from '../lib/evolution.js'
import { env } from '../lib/env.js'
import { logEvento } from '../services/log-evento.js'

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

    logEvento({
      userId,
      categoria: 'WHATSAPP',
      acao: 'CRIAR',
      recursoTipo: 'WHATSAPP',
      recursoId: instancia.id,
      descricao: `Criou instância WhatsApp "${parsed.data.nome}"`,
    })

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
  let whatsappId: string | null = null
  try {
    const resp = (await evolution.enviarTexto(
      instanceName,
      telefoneCru,
      parsed.data.texto
    )) as { key?: { id?: string } }
    whatsappId = resp?.key?.id ?? null
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
      whatsapp_message_id: whatsappId,
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

  logEvento({
    userId,
    categoria: 'MENSAGEM',
    acao: 'ENVIAR_MSG',
    recursoTipo: 'CONVERSA',
    recursoId: conversaId,
    descricao: 'Enviou mensagem de texto (humano)',
    detalhes: { preview: parsed.data.texto.substring(0, 80) },
  })

  return c.json(msg)
})

const enviarMidiaSchema = z.object({
  tipoMidia: z.enum(['IMAGEM', 'AUDIO', 'VIDEO', 'DOCUMENTO']),
  base64: z.string().min(1), // base64 bruto (sem prefix data:)
  mimetype: z.string().min(1),
  fileName: z.string().optional(),
  legenda: z.string().optional(),
})

/**
 * POST /whatsapp/conversas/:conversaId/enviar-midia
 * Sobe a midia pro Storage, envia via Evolution, salva no banco.
 */
whatsappRoutes.post('/conversas/:conversaId/enviar-midia', async (c) => {
  const userId = c.get('userId')
  const conversaId = c.req.param('conversaId')
  const body = await c.req.json().catch(() => ({}))
  const parsed = enviarMidiaSchema.safeParse(body)

  if (!parsed.success) {
    return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400)
  }

  const { tipoMidia, base64, mimetype, fileName, legenda } = parsed.data

  // 1. Busca conversa + instancia
  const { data: conversa } = await supabase
    .from('conversas')
    .select('id, telefone, instancia_whatsapp_id')
    .eq('id', conversaId)
    .eq('user_id', userId)
    .maybeSingle()

  if (!conversa || !conversa.instancia_whatsapp_id) {
    return c.json({ error: 'Conversa nao encontrada' }, 404)
  }

  const { data: instancia } = await supabase
    .from('instancias_whatsapp')
    .select('evolution_instance_id')
    .eq('id', conversa.instancia_whatsapp_id)
    .maybeSingle()

  const instanceName =
    instancia?.evolution_instance_id ?? conversa.instancia_whatsapp_id
  const telefoneCru = conversa.telefone.replace(/\D/g, '')

  // 2. Upload pro Supabase Storage
  const extMap: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'audio/ogg': 'ogg',
    'audio/ogg; codecs=opus': 'ogg',
    'audio/mp4': 'm4a',
    'audio/mpeg': 'mp3',
    'audio/webm': 'webm',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'application/pdf': 'pdf',
  }
  const ext = extMap[mimetype] ?? mimetype.split('/')[1]?.split(';')[0] ?? 'bin'
  const msgUuid = crypto.randomUUID()
  const path = `${userId}/outgoing/${conversaId}/${msgUuid}.${ext}`
  const buffer = Buffer.from(base64, 'base64')

  const { error: upErr } = await supabase.storage
    .from('whatsapp-media')
    .upload(path, buffer, { contentType: mimetype, upsert: true })

  if (upErr) {
    console.error('[enviar-midia] upload Storage falhou:', upErr)
    return c.json({ error: 'Falha ao armazenar midia' }, 500)
  }

  const { data: publicData } = supabase.storage
    .from('whatsapp-media')
    .getPublicUrl(path)
  const midiaUrl = publicData.publicUrl

  // 3. Envia via Evolution (usa URL publica — mais leve que base64)
  let whatsappId: string | null = null
  try {
    let resp: { key?: { id?: string } } = {}
    if (tipoMidia === 'AUDIO') {
      resp = (await evolution.enviarAudio(
        instanceName,
        telefoneCru,
        midiaUrl
      )) as { key?: { id?: string } }
    } else {
      const mediatype: 'image' | 'video' | 'document' =
        tipoMidia === 'IMAGEM'
          ? 'image'
          : tipoMidia === 'VIDEO'
            ? 'video'
            : 'document'
      resp = (await evolution.enviarMidia(instanceName, {
        telefone: telefoneCru,
        mediatype,
        media: midiaUrl,
        mimetype,
        caption: legenda,
        fileName: fileName ?? `${mediatype}.${ext}`,
      })) as { key?: { id?: string } }
    }
    whatsappId = resp?.key?.id ?? null
  } catch (e) {
    console.error('[enviar-midia] Evolution falhou:', e)
    return c.json({ error: 'Falha ao enviar midia no WhatsApp' }, 502)
  }

  // 4. Preview textual amigavel
  const iconePorTipo: Record<string, string> = {
    IMAGEM: '📷',
    AUDIO: '🎙️',
    VIDEO: '🎥',
    DOCUMENTO: '📎',
  }
  const preview = legenda
    ? `${iconePorTipo[tipoMidia] ?? ''} ${legenda}`
    : `${iconePorTipo[tipoMidia] ?? ''} ${
        tipoMidia === 'IMAGEM'
          ? 'Imagem'
          : tipoMidia === 'AUDIO'
            ? 'Mensagem de voz'
            : tipoMidia === 'VIDEO'
              ? 'Video'
              : fileName ?? 'Documento'
      }`

  // 5. Salva no DB
  const { data: msg, error } = await supabase
    .from('mensagens')
    .insert({
      conversa_id: conversaId,
      user_id: userId,
      tipo: 'OUTGOING_HUMANO',
      conteudo: preview,
      tipo_midia: tipoMidia,
      midia_url: midiaUrl,
      whatsapp_message_id: whatsappId,
      status: 'ENVIADA',
    })
    .select()
    .single()

  if (error) {
    console.error('[enviar-midia] save mensagem:', error)
    return c.json({ error: 'Enviado mas erro ao salvar historico' }, 500)
  }

  await supabase
    .from('conversas')
    .update({
      ultima_mensagem: preview,
      ultima_mensagem_em: new Date().toISOString(),
    })
    .eq('id', conversaId)

  logEvento({
    userId,
    categoria: 'MENSAGEM',
    acao: 'ENVIAR_MSG',
    recursoTipo: 'CONVERSA',
    recursoId: conversaId,
    descricao: `Enviou mídia (${tipoMidia.toLowerCase()})`,
    detalhes: { tipoMidia, temLegenda: !!legenda },
  })

  return c.json(msg)
})

const vincularAgenteSchema = z.object({
  agenteId: z.string().uuid().nullable(),
})

const simularIncomingSchema = z.object({
  texto: z.string().min(1).max(2000),
})

/**
 * POST /whatsapp/conversas/:conversaId/simular-incoming
 * Insere uma mensagem INCOMING direto no banco (sem passar pela Evolution).
 * Se a conversa tem agente vinculado e modo=IA, dispara a resposta IA.
 * Util pra testar prompts sem mandar no WhatsApp real.
 */
whatsappRoutes.post('/conversas/:conversaId/simular-incoming', async (c) => {
  const userId = c.get('userId')
  const conversaId = c.req.param('conversaId')
  const body = await c.req.json().catch(() => ({}))
  const parsed = simularIncomingSchema.safeParse(body)

  if (!parsed.success) {
    return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400)
  }

  const { data: conversa } = await supabase
    .from('conversas')
    .select('id, modo, agente_id')
    .eq('id', conversaId)
    .eq('user_id', userId)
    .maybeSingle()

  if (!conversa) {
    return c.json({ error: 'Conversa nao encontrada' }, 404)
  }

  // Gera um whatsapp_message_id fake pra manter dedup consistente
  const fakeId = `SIM_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

  const { data: msg, error } = await supabase
    .from('mensagens')
    .insert({
      conversa_id: conversaId,
      user_id: userId,
      tipo: 'INCOMING',
      conteudo: parsed.data.texto,
      tipo_midia: 'TEXTO',
      whatsapp_message_id: fakeId,
      status: 'ENVIADA',
    })
    .select()
    .single()

  if (error) {
    return c.json({ error: 'Erro ao salvar mensagem', details: error }, 500)
  }

  await supabase
    .from('conversas')
    .update({
      ultima_mensagem: parsed.data.texto,
      ultima_mensagem_em: new Date().toISOString(),
    })
    .eq('id', conversaId)

  // Dispara IA se aplicavel (importacao lazy pra evitar circular dep)
  if (conversa.modo === 'IA' && conversa.agente_id) {
    const { agendarRespostaIA } = await import(
      '../services/gerar-resposta-ia.js'
    )
    agendarRespostaIA(conversaId)
  }

  return c.json(msg)
})

/**
 * PATCH /whatsapp/conversas/:conversaId/agente
 * Vincula (ou desvincula) um agente a uma conversa.
 */
whatsappRoutes.patch('/conversas/:conversaId/agente', async (c) => {
  const userId = c.get('userId')
  const conversaId = c.req.param('conversaId')
  const body = await c.req.json().catch(() => ({}))
  const parsed = vincularAgenteSchema.safeParse(body)

  if (!parsed.success) {
    return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400)
  }

  // Valida ownership da conversa
  const { data: conversa } = await supabase
    .from('conversas')
    .select('id')
    .eq('id', conversaId)
    .eq('user_id', userId)
    .maybeSingle()

  if (!conversa) {
    return c.json({ error: 'Conversa nao encontrada' }, 404)
  }

  // Se foi pedido vincular um agente, valida que pertence ao mesmo user
  if (parsed.data.agenteId) {
    const { data: agente } = await supabase
      .from('agentes')
      .select('id, status')
      .eq('id', parsed.data.agenteId)
      .eq('user_id', userId)
      .maybeSingle()

    if (!agente) {
      return c.json({ error: 'Agente nao encontrado' }, 404)
    }
    if (agente.status !== 'ATIVO') {
      return c.json({ error: 'Agente esta inativo' }, 400)
    }
  }

  const { data, error } = await supabase
    .from('conversas')
    .update({ agente_id: parsed.data.agenteId })
    .eq('id', conversaId)
    .select('*')
    .single()

  if (error) {
    console.error('[vincular-agente] erro:', error)
    return c.json({ error: 'Erro ao vincular agente' }, 500)
  }

  logEvento({
    userId,
    categoria: 'CONVERSA',
    acao: 'VINCULAR_AGENTE',
    recursoTipo: 'CONVERSA',
    recursoId: conversaId,
    descricao: parsed.data.agenteId
      ? 'Vinculou agente à conversa'
      : 'Desvinculou agente da conversa',
    detalhes: { agenteId: parsed.data.agenteId },
  })

  return c.json(data)
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

  logEvento({
    userId,
    categoria: 'WHATSAPP',
    acao: 'DELETAR',
    recursoTipo: 'WHATSAPP',
    recursoId: id,
    descricao: 'Removeu instância WhatsApp',
  })

  return c.json({ ok: true })
})

// ============================================================
// PERFIL
// ============================================================

/**
 * PATCH /whatsapp/perfil
 * Atualiza nome e/ou foto do usuario.
 */
whatsappRoutes.patch('/perfil', async (c) => {
  const userId = c.get('userId')
  const body = await c.req.json().catch(() => ({}))

  const update: Record<string, unknown> = {}
  if (typeof body.nome === 'string' && body.nome.trim()) {
    update.nome = body.nome.trim()
  }
  if (typeof body.foto_url === 'string') {
    update.foto_url = body.foto_url || null
  }

  if (Object.keys(update).length === 0) {
    return c.json({ error: 'Nada pra atualizar' }, 400)
  }

  const { error } = await supabase
    .from('usuarios')
    .update(update)
    .eq('id', userId)

  if (error) {
    return c.json({ error: error.message }, 500)
  }

  logEvento({
    userId,
    categoria: 'PERFIL',
    acao: 'EDITAR',
    descricao: `Atualizou perfil (${Object.keys(update).join(', ')})`,
    detalhes: update,
  })

  return c.json({ ok: true, ...update })
})

/**
 * POST /whatsapp/perfil/upload-foto
 * Recebe base64 da foto, sobe no Storage, retorna URL publica.
 */
whatsappRoutes.post('/perfil/upload-foto', async (c) => {
  const userId = c.get('userId')
  const body = await c.req.json().catch(() => ({}))
  const { base64, mimetype } = body as { base64?: string; mimetype?: string }

  if (!base64 || !mimetype) {
    return c.json({ error: 'base64 e mimetype obrigatorios' }, 400)
  }

  const ext = mimetype.split('/')[1]?.split(';')[0] ?? 'jpg'
  const path = `${userId}/avatar.${ext}`
  const buffer = Buffer.from(base64, 'base64')

  const { error: upErr } = await supabase.storage
    .from('avatars')
    .upload(path, buffer, { contentType: mimetype, upsert: true })

  if (upErr) {
    return c.json({ error: upErr.message }, 500)
  }

  const { data } = supabase.storage.from('avatars').getPublicUrl(path)
  const fotoUrl = `${data.publicUrl}?t=${Date.now()}`

  // Salva na tabela usuarios
  await supabase.from('usuarios').update({ foto_url: fotoUrl }).eq('id', userId)

  logEvento({
    userId,
    categoria: 'PERFIL',
    acao: 'UPLOAD_FOTO',
    descricao: 'Trocou foto de perfil',
  })

  return c.json({ fotoUrl })
})

// ============================================================
// TOGGLE AGENTES (GLOBAL)
// ============================================================

/**
 * POST /whatsapp/toggle-agentes
 * Desliga ou religa todos os agentes IA nas conversas do usuario.
 */
whatsappRoutes.post('/toggle-agentes', async (c) => {
  const userId = c.get('userId')
  const body = await c.req.json().catch(() => ({}))
  const desligar = body.desligar === true

  if (desligar) {
    // 1. Salva modo atual das conversas em modo_anterior (só as que estão em IA)
    await supabase
      .from('conversas')
      .update({ modo_anterior: 'IA', modo: 'HUMANO' })
      .eq('user_id', userId)
      .eq('modo', 'IA')

    // 2. Marca flag global
    await supabase
      .from('usuarios')
      .update({ agentes_desligados: true })
      .eq('id', userId)

    logEvento({
      userId,
      categoria: 'PERFIL',
      acao: 'TOGGLE_AGENTES_GLOBAL',
      descricao: 'Desligou todos os agentes IA (modo humano global)',
      detalhes: { desligados: true },
    })

    return c.json({ ok: true, desligados: true })
  } else {
    // 1. Restaura conversas que tinham modo_anterior = IA
    await supabase
      .from('conversas')
      .update({ modo: 'IA', modo_anterior: null })
      .eq('user_id', userId)
      .eq('modo_anterior', 'IA')

    // 2. Desliga flag global
    await supabase
      .from('usuarios')
      .update({ agentes_desligados: false })
      .eq('id', userId)

    logEvento({
      userId,
      categoria: 'PERFIL',
      acao: 'TOGGLE_AGENTES_GLOBAL',
      descricao: 'Religou agentes IA',
      detalhes: { desligados: false },
    })

    return c.json({ ok: true, desligados: false })
  }
})

// ============================================================
// PING LOGIN — atualiza ultimo_login do usuario
// ============================================================

whatsappRoutes.post('/ping-login', async (c) => {
  const userId = c.get('userId')
  const ip = c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? undefined
  await supabase
    .from('usuarios')
    .update({ ultimo_login: new Date().toISOString() })
    .eq('id', userId)
  logEvento({
    userId,
    categoria: 'AUTH',
    acao: 'LOGIN',
    descricao: 'Usuário fez login',
    ip,
  })
  return c.json({ ok: true })
})

// ============================================================
// AUTOMAÇÕES
// ============================================================

const automacaoSchema = z.object({
  nome: z.string().min(2).max(120),
  evento: z.enum([
    'COMPRA_APROVADA',
    'COMPRA_RECUSADA',
    'REEMBOLSO',
    'ASSINATURA_CANCELADA',
    'CARRINHO_ABANDONADO',
  ]),
  provedor: z.enum(['HOTMART', 'KIWIFY', 'TICTO']).nullable().optional(),
  produtoId: z.string().uuid().nullable().optional(),
  agenteId: z.string().uuid().nullable().optional(),
  mensagemInicial: z.string().nullable().optional(),
  delayMinutos: z.number().int().min(0).max(43200).default(0), // max 30 dias
  executarSeExiste: z.boolean().default(false),
  ativo: z.boolean().default(true),
})

/** Lista automacoes do usuario */
whatsappRoutes.get('/automacoes', async (c) => {
  const userId = c.get('userId')
  const { data, error } = await supabase
    .from('automacoes')
    .select('*')
    .eq('user_id', userId)
    .order('criado_em', { ascending: false })

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data ?? [])
})

/** Cria nova automacao */
whatsappRoutes.post('/automacoes', async (c) => {
  const userId = c.get('userId')
  const body = await c.req.json().catch(() => ({}))
  const parsed = automacaoSchema.safeParse(body)

  if (!parsed.success) {
    return c.json({ error: 'Dados invalidos', details: parsed.error.flatten() }, 400)
  }

  const d = parsed.data
  const { data, error } = await supabase
    .from('automacoes')
    .insert({
      user_id: userId,
      nome: d.nome,
      evento: d.evento,
      provedor: d.provedor ?? null,
      produto_id: d.produtoId ?? null,
      agente_id: d.agenteId ?? null,
      mensagem_inicial: d.mensagemInicial ?? null,
      delay_minutos: d.delayMinutos,
      executar_se_existe: d.executarSeExiste,
      ativo: d.ativo,
    })
    .select('*')
    .single()

  if (error) return c.json({ error: error.message }, 500)

  logEvento({
    userId,
    categoria: 'AUTOMACAO',
    acao: 'CRIAR',
    recursoTipo: 'AUTOMACAO',
    recursoId: (data as { id: string }).id,
    descricao: `Criou automação "${d.nome}"`,
    detalhes: { evento: d.evento, delayMinutos: d.delayMinutos, ativo: d.ativo },
  })

  return c.json(data)
})

/** Atualiza automacao */
whatsappRoutes.patch('/automacoes/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const parsed = automacaoSchema.partial().safeParse(body)

  if (!parsed.success) {
    return c.json({ error: 'Dados invalidos', details: parsed.error.flatten() }, 400)
  }

  const d = parsed.data
  const update: Record<string, unknown> = { atualizado_em: new Date().toISOString() }
  if (d.nome !== undefined) update.nome = d.nome
  if (d.evento !== undefined) update.evento = d.evento
  if (d.provedor !== undefined) update.provedor = d.provedor
  if (d.produtoId !== undefined) update.produto_id = d.produtoId
  if (d.agenteId !== undefined) update.agente_id = d.agenteId
  if (d.mensagemInicial !== undefined) update.mensagem_inicial = d.mensagemInicial
  if (d.delayMinutos !== undefined) update.delay_minutos = d.delayMinutos
  if (d.executarSeExiste !== undefined) update.executar_se_existe = d.executarSeExiste
  if (d.ativo !== undefined) update.ativo = d.ativo

  const { data, error } = await supabase
    .from('automacoes')
    .update(update)
    .eq('id', id)
    .eq('user_id', userId)
    .select('*')
    .single()

  if (error) return c.json({ error: error.message }, 500)

  // Detecta mudanca importante de ativo
  const acao =
    d.ativo === true
      ? 'ATIVAR'
      : d.ativo === false
      ? 'DESATIVAR'
      : 'EDITAR'
  logEvento({
    userId,
    categoria: 'AUTOMACAO',
    acao,
    recursoTipo: 'AUTOMACAO',
    recursoId: id,
    descricao: `${acao === 'ATIVAR' ? 'Ativou' : acao === 'DESATIVAR' ? 'Pausou' : 'Editou'} automação "${(data as { nome?: string }).nome ?? ''}"`,
    detalhes: update,
  })

  return c.json(data)
})

/** Deleta automacao */
whatsappRoutes.delete('/automacoes/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')

  const { error } = await supabase
    .from('automacoes')
    .delete()
    .eq('id', id)
    .eq('user_id', userId)

  if (error) return c.json({ error: error.message }, 500)

  logEvento({
    userId,
    categoria: 'AUTOMACAO',
    acao: 'DELETAR',
    recursoTipo: 'AUTOMACAO',
    recursoId: id,
    descricao: 'Removeu automação',
  })

  return c.json({ ok: true })
})
