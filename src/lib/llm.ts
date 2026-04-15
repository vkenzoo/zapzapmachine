import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { env } from './env.js'

export interface LLMMessage {
  role: 'user' | 'assistant'
  content: string
  /**
   * URLs de imagens anexadas (apenas role='user').
   * Claude e OpenAI conseguem "ver" e comentar sobre elas.
   */
  images?: string[]
}

export interface LLMGenerateParams {
  systemPrompt: string
  messages: LLMMessage[]
  maxTokens?: number
}

export interface LLMProvider {
  name: 'claude' | 'openai'
  model: string
  generate(params: LLMGenerateParams): Promise<string>
}

const DEFAULT_MAX_TOKENS = 1024

// ============================================================================
// Claude (Anthropic)
// ============================================================================

class ClaudeProvider implements LLMProvider {
  name = 'claude' as const
  model: string
  private client: Anthropic

  constructor(apiKey: string, model?: string) {
    this.client = new Anthropic({ apiKey })
    this.model = model ?? 'claude-sonnet-4-5-20250929'
  }

  async generate({
    systemPrompt,
    messages,
    maxTokens,
  }: LLMGenerateParams): Promise<string> {
    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
      // Prompt caching: system prompt fica cacheado por 5 min
      system: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: messages.map((m) => {
        // Se tem imagens, monta content como array com text + image blocks
        if (m.role === 'user' && m.images && m.images.length > 0) {
          return {
            role: 'user' as const,
            content: [
              ...m.images.map((url) => ({
                type: 'image' as const,
                source: { type: 'url' as const, url },
              })),
              { type: 'text' as const, text: m.content || 'Imagem recebida:' },
            ],
          }
        }
        return { role: m.role, content: m.content }
      }),
    })

    // Concatena blocos de texto (normalmente um so)
    const textos: string[] = []
    for (const bloco of resp.content) {
      if (bloco.type === 'text') textos.push(bloco.text)
    }
    return textos.join('\n').trim()
  }
}

// ============================================================================
// OpenAI
// ============================================================================

class OpenAIProvider implements LLMProvider {
  name = 'openai' as const
  model: string
  private client: OpenAI

  constructor(apiKey: string, model?: string) {
    this.client = new OpenAI({ apiKey })
    this.model = model ?? 'gpt-4o-mini'
  }

  async generate({
    systemPrompt,
    messages,
    maxTokens,
  }: LLMGenerateParams): Promise<string> {
    const resp = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: [
        { role: 'system' as const, content: systemPrompt },
        ...messages.map((m) => {
          // Imagens via vision (GPT-4o/4o-mini suportam)
          if (m.role === 'user' && m.images && m.images.length > 0) {
            return {
              role: 'user' as const,
              content: [
                ...m.images.map((url) => ({
                  type: 'image_url' as const,
                  image_url: { url },
                })),
                { type: 'text' as const, text: m.content || 'Imagem recebida:' },
              ],
            }
          }
          return {
            role: m.role as 'user' | 'assistant',
            content: m.content,
          }
        }),
      ],
    })

    return resp.choices[0]?.message?.content?.trim() ?? ''
  }
}

// ============================================================================
// Factory
// ============================================================================

let cached: LLMProvider | null = null

export const getLLM = (): LLMProvider => {
  if (cached) return cached

  const cfg = env()

  if (cfg.LLM_PROVIDER === 'claude') {
    if (!cfg.ANTHROPIC_API_KEY) {
      throw new Error(
        'LLM_PROVIDER=claude mas ANTHROPIC_API_KEY nao foi definida'
      )
    }
    cached = new ClaudeProvider(cfg.ANTHROPIC_API_KEY, cfg.LLM_MODEL)
  } else {
    if (!cfg.OPENAI_API_KEY) {
      throw new Error('LLM_PROVIDER=openai mas OPENAI_API_KEY nao foi definida')
    }
    cached = new OpenAIProvider(cfg.OPENAI_API_KEY, cfg.LLM_MODEL)
  }

  return cached
}
