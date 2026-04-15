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
