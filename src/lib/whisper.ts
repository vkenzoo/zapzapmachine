import OpenAI from 'openai'
import { env } from './env.js'

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

/**
 * Transcreve um arquivo de audio via Whisper.
 * Recebe URL publica (Supabase Storage) ou base64 — baixa, envia pra OpenAI e retorna texto.
 */
export const transcreverAudio = async (audioUrl: string): Promise<string | null> => {
  try {
    // Baixa o audio
    const res = await fetch(audioUrl)
    if (!res.ok) {
      console.error('[whisper] falha ao baixar audio:', res.status)
      return null
    }
    const buffer = Buffer.from(await res.arrayBuffer())

    // Deriva nome + mime do URL / headers
    const contentType = res.headers.get('content-type') ?? 'audio/ogg'
    const ext = audioUrl.split('.').pop()?.split('?')[0] ?? 'ogg'
    const nome = `audio.${ext}`

    // OpenAI SDK aceita Blob-like com nome
    const file = new File([new Uint8Array(buffer)], nome, { type: contentType })

    const openai = getClient()
    const result = await openai.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      language: 'pt', // forca portugues
    })

    return result.text?.trim() ?? null
  } catch (e) {
    console.error('[whisper] erro transcricao:', e)
    return null
  }
}
