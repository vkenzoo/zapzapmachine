import { supabase } from '../lib/supabase.js'
import { evolution } from '../lib/evolution.js'
import { transcreverAudio } from '../lib/whisper.js'
import { agendarRespostaIA } from './gerar-resposta-ia.js'

const CORES_AVATAR = [
  '#3b82f6', '#10b981', '#8b5cf6', '#f59e0b',
  '#ec4899', '#14b8a6', '#ef4444', '#6366f1',
]

/**
 * Extrai o telefone limpo do `remoteJid` do Evolution.
 * Formato comum: `5511998765432@s.whatsapp.net`
 */
const limparTelefone = (remoteJid: string): string => {
  return remoteJid.split('@')[0].replace(/\D/g, '')
}

/**
 * Formata o telefone para exibicao: +55 11 99876-5432
 */
const formatarTelefone = (cru: string): string => {
  // Ex: 5511998765432 → +55 11 99876-5432
  if (cru.length >= 12 && cru.startsWith('55')) {
    return `+55 ${cru.slice(2, 4)} ${cru.slice(4, 9)}-${cru.slice(9)}`
  }
  return `+${cru}`
}

/**
 * Retorna extensao de arquivo a partir do mimetype.
 */
const extensaoDeMime = (mimetype: string): string => {
  const map: Record<string, string> = {
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
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  }
  if (map[mimetype]) return map[mimetype]
  const second = mimetype.split('/')[1]?.split(';')[0]
  return second ?? 'bin'
}

/**
 * Faz upload do base64 da midia pro Supabase Storage e retorna a URL publica.
 * Retorna null em caso de erro (nao trava o fluxo).
 */
const uploadMidiaStorage = async (
  base64: string,
  mimetype: string,
  userId: string,
  conversaId: string,
  messageId: string
): Promise<string | null> => {
  try {
    const ext = extensaoDeMime(mimetype)
    const path = `${userId}/${conversaId}/${messageId}.${ext}`
    const buffer = Buffer.from(base64, 'base64')

    const { error } = await supabase.storage
      .from('whatsapp-media')
      .upload(path, buffer, {
        contentType: mimetype,
        upsert: true,
      })

    if (error) {
      console.error('[uploadMidia] erro upload:', error)
      return null
    }

    const { data } = supabase.storage.from('whatsapp-media').getPublicUrl(path)
    return data.publicUrl
  } catch (e) {
    console.error('[uploadMidia] erro:', e)
    return null
  }
}

type TipoMidia =
  | 'TEXTO'
  | 'IMAGEM'
  | 'AUDIO'
  | 'VIDEO'
  | 'DOCUMENTO'
  | 'STICKER'
  | 'LOCALIZACAO'
  | 'CONTATO'

interface ProcessarMensagemInput {
  instanciaWhatsappId: string // UUID da nossa tabela `instancias_whatsapp`
  instanceName: string // nome da instancia no Evolution (mesmo UUID)
  userId: string
  evento: 'messages.upsert' | 'messages.update' | string
  dados: {
    key: {
      remoteJid: string
      fromMe: boolean
      id: string
    }
    pushName?: string
    message?: {
      conversation?: string
      extendedTextMessage?: { text: string }
      imageMessage?: { caption?: string; mimetype?: string }
      audioMessage?: { mimetype?: string; ptt?: boolean; seconds?: number }
      videoMessage?: { caption?: string; mimetype?: string }
      documentMessage?: { fileName?: string; mimetype?: string }
      stickerMessage?: { mimetype?: string }
      locationMessage?: { degreesLatitude?: number; degreesLongitude?: number }
      contactMessage?: { displayName?: string }
    }
    messageTimestamp?: number
  }
}

/**
 * Detecta tipo de midia e retorna um preview textual amigavel.
 */
const extrairMidia = (
  message: ProcessarMensagemInput['dados']['message']
): { conteudo: string; tipoMidia: TipoMidia } => {
  if (!message) return { conteudo: '', tipoMidia: 'TEXTO' }

  // Texto puro
  if (message.conversation) {
    return { conteudo: message.conversation, tipoMidia: 'TEXTO' }
  }
  if (message.extendedTextMessage?.text) {
    return { conteudo: message.extendedTextMessage.text, tipoMidia: 'TEXTO' }
  }

  // Imagem
  if (message.imageMessage) {
    const caption = message.imageMessage.caption
    return {
      conteudo: caption ? `📷 ${caption}` : '📷 Imagem',
      tipoMidia: 'IMAGEM',
    }
  }

  // Audio
  if (message.audioMessage) {
    const ptt = message.audioMessage.ptt
    const secs = message.audioMessage.seconds
    const duracao = secs ? ` (${secs}s)` : ''
    return {
      conteudo: ptt ? `🎙️ Mensagem de voz${duracao}` : `🎵 Audio${duracao}`,
      tipoMidia: 'AUDIO',
    }
  }

  // Video
  if (message.videoMessage) {
    const caption = message.videoMessage.caption
    return {
      conteudo: caption ? `🎥 ${caption}` : '🎥 Video',
      tipoMidia: 'VIDEO',
    }
  }

  // Documento
  if (message.documentMessage) {
    const nome = message.documentMessage.fileName
    return {
      conteudo: nome ? `📎 ${nome}` : '📎 Documento',
      tipoMidia: 'DOCUMENTO',
    }
  }

  // Sticker
  if (message.stickerMessage) {
    return { conteudo: '😀 Figurinha', tipoMidia: 'STICKER' }
  }

  // Localizacao
  if (message.locationMessage) {
    return { conteudo: '📍 Localizacao', tipoMidia: 'LOCALIZACAO' }
  }

  // Contato
  if (message.contactMessage) {
    const nome = message.contactMessage.displayName
    return {
      conteudo: nome ? `👤 Contato: ${nome}` : '👤 Contato',
      tipoMidia: 'CONTATO',
    }
  }

  return { conteudo: '', tipoMidia: 'TEXTO' }
}

/**
 * Processa uma mensagem recebida do Evolution webhook.
 * - Extrai telefone + conteudo
 * - Find or create conversa
 * - Insere mensagem INCOMING (fromMe=false) ou OUTGOING_HUMANO (fromMe=true)
 * - Atualiza ultima_mensagem + nao_lidas
 */
export const processarMensagem = async (
  input: ProcessarMensagemInput
): Promise<void> => {
  const { instanciaWhatsappId, instanceName, userId, dados } = input

  // Extrai tipo + conteudo de qualquer tipo de mensagem (texto ou midia)
  const { conteudo: conteudoPlaceholder, tipoMidia } = extrairMidia(dados.message)

  if (!conteudoPlaceholder) {
    console.log('[processarMensagem] mensagem sem conteudo suportado, skip')
    return
  }

  // conteudo pode ser atualizado depois se for audio transcrito
  let conteudo = conteudoPlaceholder

  // Pra mensagens de midia, baixa o arquivo via Evolution e sobe no Storage.
  // Stickers sao ignorados (baixo valor, alto custo de armazenamento).
  let midiaUrl: string | null = null
  const tiposComMidia = new Set<TipoMidia>(['IMAGEM', 'AUDIO', 'VIDEO', 'DOCUMENTO'])

  if (tiposComMidia.has(tipoMidia)) {
    console.log(`[midia] tipo=${tipoMidia} id=${dados.key.id} — baixando...`)

    const baixada = await evolution.baixarMidia(instanceName, {
      key: dados.key,
      message: dados.message,
      messageTimestamp: dados.messageTimestamp,
    })

    if (!baixada) {
      console.warn(`[midia] baixarMidia retornou null (id=${dados.key.id})`)
    } else {
      console.log(
        `[midia] base64 size=${baixada.base64.length} mime=${baixada.mimetype}`
      )

      midiaUrl = await uploadMidiaStorage(
        baixada.base64,
        baixada.mimetype,
        userId,
        dados.key.remoteJid.replace(/[^\w]/g, '_'),
        dados.key.id
      )

      if (!midiaUrl) {
        console.warn(`[midia] upload falhou (id=${dados.key.id})`)
      } else {
        console.log(`[midia] ✅ salva em ${midiaUrl}`)

        // Audio: transcreve via Whisper e usa transcricao como conteudo
        if (tipoMidia === 'AUDIO') {
          console.log(`[whisper] transcrevendo audio...`)
          const duracaoSegundos = dados.message?.audioMessage?.seconds
          const texto = await transcreverAudio(midiaUrl, {
            userId,
            duracaoSegundos,
          })
          if (texto) {
            // Conteudo vira o texto transcrito com prefixo visual pro dashboard
            conteudo = `🎙️ "${texto}"`
            console.log(`[whisper] ✅ transcrito: ${texto.substring(0, 100)}`)
          } else {
            console.warn('[whisper] transcricao falhou, mantem placeholder')
          }
        }
      }
    }
  }

  const telefoneCru = limparTelefone(dados.key.remoteJid)
  const telefoneFmt = formatarTelefone(telefoneCru)
  const isFromMe = dados.key.fromMe === true

  // pushName so eh confiavel em mensagens INCOMING (da pessoa pra gente).
  // Em OUTGOING (fromMe=true), pushName eh o NOSSO proprio nome, nao do contato.
  const nomeContatoConfiavel = !isFromMe && dados.pushName ? dados.pushName : null
  const nomeContato = nomeContatoConfiavel ?? telefoneFmt

  // 0. Dedup: se ja temos essa mensagem (pelo id do WhatsApp), skip
  const { data: jaExiste } = await supabase
    .from('mensagens')
    .select('id')
    .eq('whatsapp_message_id', dados.key.id)
    .eq('user_id', userId)
    .maybeSingle()

  if (jaExiste) {
    console.log(`[processarMensagem] duplicada (id=${dados.key.id}), skip`)
    return
  }

  // 1. Find or create conversa
  const { data: conversaExistente } = await supabase
    .from('conversas')
    .select('id, nao_lidas, nome_contato, telefone, modo, agente_id')
    .eq('user_id', userId)
    .eq('telefone', telefoneFmt)
    .maybeSingle()

  let conversaId: string

  if (conversaExistente) {
    conversaId = conversaExistente.id

    // Se o nome atual eh o telefone (placeholder) e veio pushName confiavel, atualiza
    if (
      nomeContatoConfiavel &&
      conversaExistente.nome_contato === conversaExistente.telefone
    ) {
      await supabase
        .from('conversas')
        .update({ nome_contato: nomeContatoConfiavel })
        .eq('id', conversaId)
    }
  } else {
    const avatarCor = CORES_AVATAR[Math.floor(Math.random() * CORES_AVATAR.length)]

    // Busca foto de perfil publica do contato no Evolution (best-effort)
    const fotoUrl = await evolution.fotoPerfil(instanceName, telefoneCru)

    // Busca agente padrao ativo do usuario pra vincular automaticamente
    // Mas respeita flag global "agentes_desligados"
    let agentePadraoId: string | null = null
    if (!isFromMe) {
      const { data: userRow } = await supabase
        .from('usuarios')
        .select('agentes_desligados')
        .eq('id', userId)
        .maybeSingle()

      if (!userRow?.agentes_desligados) {
        const { data: agentesAtivos } = await supabase
          .from('agentes')
          .select('id')
          .eq('user_id', userId)
          .eq('status', 'ATIVO')
          .limit(1)
        agentePadraoId = agentesAtivos?.[0]?.id ?? null
      }
    }

    const { data: novaConversa, error } = await supabase
      .from('conversas')
      .insert({
        user_id: userId,
        instancia_whatsapp_id: instanciaWhatsappId,
        nome_contato: nomeContato,
        telefone: telefoneFmt,
        status: 'EM_ATENDIMENTO',
        modo: agentePadraoId ? 'IA' : 'HUMANO',
        agente_id: agentePadraoId,
        avatar_cor: avatarCor,
        foto_url: fotoUrl,
        ultima_mensagem: conteudo,
        ultima_mensagem_em: new Date().toISOString(),
        nao_lidas: isFromMe ? 0 : 1,
      })
      .select('id')
      .single()

    if (error || !novaConversa) {
      console.error('[processarMensagem] erro ao criar conversa:', error)
      return
    }
    conversaId = novaConversa.id

    // Insere primeira mensagem
    await supabase
      .from('mensagens')
      .insert({
        conversa_id: conversaId,
        user_id: userId,
        tipo: isFromMe ? 'OUTGOING_HUMANO' : 'INCOMING',
        conteudo,
        tipo_midia: tipoMidia,
        midia_url: midiaUrl,
        whatsapp_message_id: dados.key.id,
        status: 'ENVIADA',
      })

    // BUG FIX: Trigger IA tambem em conversas NOVAS (antes fazia `return` e nunca chamava)
    if (!isFromMe && agentePadraoId) {
      console.log(`[processarMensagem] nova conversa + agente ativo → trigger IA`)
      agendarRespostaIA(conversaId)
    }
    return
  }

  // 2. Insert mensagem
  const { error: erroMsg } = await supabase
    .from('mensagens')
    .insert({
      conversa_id: conversaId,
      user_id: userId,
      tipo: isFromMe ? 'OUTGOING_HUMANO' : 'INCOMING',
      conteudo,
      tipo_midia: tipoMidia,
      midia_url: midiaUrl,
      whatsapp_message_id: dados.key.id,
      status: 'ENVIADA',
    })

  if (erroMsg) {
    console.error('[processarMensagem] erro ao inserir mensagem:', erroMsg)
    return
  }

  // 3. Atualizar conversa
  const novaContagem = isFromMe ? 0 : (conversaExistente.nao_lidas ?? 0) + 1

  await supabase
    .from('conversas')
    .update({
      ultima_mensagem: conteudo,
      ultima_mensagem_em: new Date().toISOString(),
      nao_lidas: novaContagem,
    })
    .eq('id', conversaId)

  // 4. Trigger IA — se mensagem INCOMING, modo=IA e agente vinculado
  // Usa debounce: agrupa msgs que chegam em sequencia (cliente escrevendo varias seguidas)
  if (!isFromMe && conversaExistente.modo === 'IA' && conversaExistente.agente_id) {
    console.log(`[processarMensagem] conversa existente + modo=IA + agente → trigger IA`)
    agendarRespostaIA(conversaId)
  } else if (!isFromMe) {
    console.log(`[processarMensagem] IA nao disparada: modo=${conversaExistente.modo} agente_id=${conversaExistente.agente_id}`)
  }
}
