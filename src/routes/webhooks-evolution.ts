import { Hono } from 'hono'
import { supabase } from '../lib/supabase.js'
import { mapearStatus } from '../lib/evolution.js'
import { processarMensagem } from '../services/processar-mensagem.js'

export const webhooksEvolutionRoutes = new Hono()

/**
 * POST /webhooks/evolution?instance=<uuid>
 * Endpoint PUBLICO — sem auth de usuario. A seguranca e feita por:
 * 1. Query param `instance` precisa bater com uma instancia existente
 * 2. (opcional futuro) HMAC signature header do Evolution
 *
 * Eventos recebidos:
 * - `QRCODE_UPDATED` — novo QR disponivel
 * - `CONNECTION_UPDATE` — state changed (open/close/connecting)
 * - `MESSAGES_UPSERT` — nova mensagem recebida ou enviada
 */
webhooksEvolutionRoutes.post('/evolution', async (c) => {
  const instanceId = c.req.query('instance')

  if (!instanceId) {
    return c.json({ error: 'Missing instance query param' }, 400)
  }

  // Busca a instancia pra saber o user_id
  const { data: instancia } = await supabase
    .from('instancias_whatsapp')
    .select('id, user_id')
    .eq('id', instanceId)
    .maybeSingle()

  if (!instancia) {
    console.warn('[webhook] instancia nao encontrada:', instanceId)
    return c.json({ error: 'Instancia nao encontrada' }, 404)
  }

  const body = await c.req.json().catch(() => ({}))
  const event: string = body.event ?? ''
  const dados = body.data ?? {}

  console.log(`[webhook] evento=${event} instancia=${instanceId}`)

  try {
    switch (event) {
      case 'connection.update': {
        const state = dados.state ?? 'close'
        const novoStatus = mapearStatus(state)

        const update: Record<string, unknown> = { status: novoStatus }
        if (dados.wuid) {
          // wuid formato: 5511998765432@s.whatsapp.net
          const numero = dados.wuid.split('@')[0]
          update.numero_conectado = `+${numero}`
        }

        await supabase
          .from('instancias_whatsapp')
          .update(update)
          .eq('id', instanceId)
        break
      }

      case 'messages.upsert':
      case 'messages.update': {
        // Pode vir como objeto unico ou array
        const mensagens = Array.isArray(dados) ? dados : [dados]

        for (const msg of mensagens) {
          // Pula mensagens de grupo por enquanto
          if (msg?.key?.remoteJid?.includes('@g.us')) continue

          await processarMensagem({
            instanciaWhatsappId: instanceId,
            userId: instancia.user_id,
            evento: event,
            dados: msg,
          })
        }
        break
      }

      case 'qrcode.updated': {
        // QR foi atualizado — a proxima chamada ao /qr vai pegar o novo
        // Nao fazemos nada aqui, so log
        break
      }

      default:
        // Outros eventos ignorados por enquanto
        break
    }

    return c.json({ ok: true })
  } catch (e) {
    console.error('[webhook] erro ao processar:', e)
    return c.json({ error: 'Erro interno' }, 500)
  }
})
