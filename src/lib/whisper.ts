import OpenAI from 'openai'
import { env } from './env.js'
import { logWhisper } from '../services/log-ia.js'

let cached: OpenAI | null = null

const getClient = (): OpenAI => {
  if (cached) return cached
  const key = env().OPENAI_API_KEY
  if (!key) {
    throw new Error(
      'OPENAI_API_KEY nao configurada — necessaria pra transcrever audio'
    )
  }
  cached = new OpenAI({ apiKey: key })
  return cached
}

interface TranscreverOptions {
  /** Se passado, loga a transcricao em logs_ia */
  userId?: string
  conversaId?: string
  /** Duracao do audio em segundos (pro calculo de custo) */
  duracaoSegundos?: number
}

/**
 * Transcreve um arquivo de audio via Whisper.
 * Recebe URL publica (Supabase Storage) ou base64 — baixa, envia pra OpenAI e retorna texto.
 */
export const transcreverAudio = async (
  audioUrl: string,
  opts?: TranscreverOptions
): Promise<string | null> => {
  const inicio = Date.now()
  try {
    const res = await fetch(audioUrl)
    if (!res.ok) {
      console.error('[whisper] falha ao baixar audio:', res.status)
      if (opts?.userId) {
        logWhisper({
          userId: opts.userId,
          conversaId: opts.conversaId,
          duracaoMs: Date.now() - inicio,
          erro: true,
          erroMensagem: `download falhou: ${res.status}`,
        })
      }
      return null
    }
    const buffer = Buffer.from(await res.arrayBuffer())
    const contentType = res.headers.get('content-type') ?? 'audio/ogg'
    const ext = audioUrl.split('.').pop()?.split('?')[0] ?? 'ogg'
    const nome = `audio.${ext}`
    const file = new File([new Uint8Array(buffer)], nome, { type: contentType })

    const openai = getClient()
    const result = await openai.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      language: 'pt',
    })

    if (opts?.userId) {
      logWhisper({
        userId: opts.userId,
        conversaId: opts.conversaId,
        duracaoMs: Date.now() - inicio,
        duracaoAudioSegundos: opts.duracaoSegundos,
      })
    }

    return result.text?.trim() ?? null
  } catch (e) {
    console.error('[whisper] erro transcricao:', e)
    if (opts?.userId) {
      logWhisper({
        userId: opts.userId,
        conversaId: opts.conversaId,
        duracaoMs: Date.now() - inicio,
        erro: true,
        erroMensagem: e instanceof Error ? e.message : String(e),
      })
    }
    return null
  }
}
