import { supabase } from '../lib/supabase.js'
import { evolution } from '../lib/evolution.js'

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
  const { conteudo, tipoMidia } = extrairMidia(dados.message)

  if (!conteudo) {
    console.log('[processarMensagem] mensagem sem conteudo suportado, skip')
    return
  }

  const telefoneCru = limparTelefone(dados.key.remoteJid)
  const telefoneFmt = formatarTelefone(telefoneCru)
  const isFromMe = dados.key.fromMe === true

  // pushName so eh confiavel em mensagens INCOMING (da pessoa pra gente).
  // Em OUTGOING (fromMe=true), pushName eh o NOSSO proprio nome, nao do contato.
  const nomeContatoConfiavel = !isFromMe && dados.pushName ? dados.pushName : null
  const nomeContato = nomeContatoConfiavel ?? telefoneFmt

  // 1. Find or create conversa
  const { data: conversaExistente } = await supabase
    .from('conversas')
    .select('id, nao_lidas, nome_contato, telefone')
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

    const { data: novaConversa, error } = await supabase
      .from('conversas')
      .insert({
        user_id: userId,
        instancia_whatsapp_id: instanciaWhatsappId,
        nome_contato: nomeContato,
        telefone: telefoneFmt,
        status: 'EM_ATENDIMENTO',
        modo: 'IA',
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

    // Como acabou de criar, ja atualiza e insere mensagem depois
    await supabase
      .from('mensagens')
      .insert({
        conversa_id: conversaId,
        user_id: userId,
        tipo: isFromMe ? 'OUTGOING_HUMANO' : 'INCOMING',
        conteudo,
        tipo_midia: tipoMidia,
        status: 'ENVIADA',
      })
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
}
