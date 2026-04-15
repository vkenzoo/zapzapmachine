import { env } from './env.js'

const config = env()

/**
 * Cliente HTTP minimalista para a Evolution API v2.
 * Docs: https://doc.evolution-api.com
 */
const evoFetch = async (path: string, init?: RequestInit) => {
  const url = `${config.EVOLUTION_API_URL}${path}`
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      apikey: config.EVOLUTION_API_KEY,
      ...init?.headers,
    },
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Evolution API ${res.status}: ${body}`)
  }

  return res.json()
}

export const evolution = {
  /**
   * Cria uma nova instancia no Evolution + seta webhook.
   * O `instanceName` e usado como identificador no Evolution — recomendamos
   * usar o UUID da tabela `instancias_whatsapp` para manter mapping 1:1.
   */
  criarInstancia: async (instanceName: string, webhookUrl: string) => {
    return evoFetch('/instance/create', {
      method: 'POST',
      body: JSON.stringify({
        instanceName,
        qrcode: true,
        integration: 'WHATSAPP-BAILEYS',
        webhook: {
          url: webhookUrl,
          byEvents: false,
          base64: true,
          events: [
            'QRCODE_UPDATED',
            'CONNECTION_UPDATE',
            'MESSAGES_UPSERT',
          ],
        },
      }),
    })
  },

  /**
   * Busca o QR code de conexao. Retorna `{ pairingCode, code, base64, count }`.
   * `base64` e o QR em data URL pronto para <img src={...}>.
   */
  conectar: async (instanceName: string) => {
    return evoFetch(`/instance/connect/${instanceName}`)
  },

  /**
   * Estado atual da instancia. Retorna `{ instance: { state: 'open'|'close'|'connecting', ... } }`.
   * `open` = conectado, `connecting` = aguardando scan, `close` = desconectado.
   */
  status: async (instanceName: string) => {
    return evoFetch(`/instance/connectionState/${instanceName}`)
  },

  /**
   * Desloga (desconecta) a instancia.
   */
  desconectar: async (instanceName: string) => {
    return evoFetch(`/instance/logout/${instanceName}`, { method: 'DELETE' })
  },

  /**
   * Deleta a instancia do Evolution.
   */
  deletar: async (instanceName: string) => {
    return evoFetch(`/instance/delete/${instanceName}`, { method: 'DELETE' })
  },

  /**
   * Envia uma mensagem de texto.
   */
  enviarTexto: async (instanceName: string, telefone: string, texto: string) => {
    return evoFetch(`/message/sendText/${instanceName}`, {
      method: 'POST',
      body: JSON.stringify({
        number: telefone,
        text: texto,
      }),
    })
  },

  /**
   * Busca a URL da foto de perfil publica do contato.
   * Retorna `{ wuid, profilePictureUrl }` quando o contato tem foto publica,
   * ou `{ wuid }` (sem picture) caso nao tenha ou nao seja visivel.
   */
  fotoPerfil: async (
    instanceName: string,
    telefone: string
  ): Promise<string | null> => {
    try {
      const resp = (await evoFetch(`/chat/fetchProfilePictureUrl/${instanceName}`, {
        method: 'POST',
        body: JSON.stringify({ number: telefone }),
      })) as { profilePictureUrl?: string }
      return resp.profilePictureUrl ?? null
    } catch {
      return null
    }
  },

  /**
   * Baixa o conteudo de uma mensagem com midia (imagem/audio/video/doc).
   * Recebe o objeto `message` inteiro do webhook e retorna { base64, mimetype }.
   * Evolution precisa do message original pra decriptar.
   */
  baixarMidia: async (
    instanceName: string,
    message: unknown
  ): Promise<{ base64: string; mimetype: string } | null> => {
    try {
      const resp = (await evoFetch(
        `/chat/getBase64FromMediaMessage/${instanceName}`,
        {
          method: 'POST',
          body: JSON.stringify({
            message,
            convertToMp4: false,
          }),
        }
      )) as { base64?: string; mimetype?: string }

      if (!resp.base64) return null
      return {
        base64: resp.base64,
        mimetype: resp.mimetype ?? 'application/octet-stream',
      }
    } catch (e) {
      console.error('[baixarMidia] erro:', e)
      return null
    }
  },
}

/**
 * Traduz o estado do Evolution para o enum da nossa tabela.
 */
export const mapearStatus = (
  state: string
): 'CONECTADO' | 'CONECTANDO' | 'DESCONECTADO' | 'ERRO' => {
  switch (state) {
    case 'open':
      return 'CONECTADO'
    case 'connecting':
      return 'CONECTANDO'
    case 'close':
      return 'DESCONECTADO'
    default:
      return 'ERRO'
  }
}
