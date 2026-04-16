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

export interface LLMUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export interface LLMResult {
  text: string
  usage: LLMUsage
}

export interface LLMProvider {
  name: 'claude' | 'openai'
  model: string
  generate(params: LLMGenerateParams): Promise<string>
  generateWithUsage(params: LLMGenerateParams): Promise<LLMResult>
}

const DEFAULT_MAX_TOKENS = 1024

// ============================================================================
// Precos por 1M tokens — pra calcular custo aproximado
// ============================================================================

interface ModelPricing {
  inputPerMillion: number
  outputPerMillion: number
  cacheReadPerMillion: number
  cacheCreationPerMillion: number
}

const PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-4-5-20250929': {
    inputPerMillion: 3.0,
    outputPerMillion: 15.0,
    cacheReadPerMillion: 0.3,
    cacheCreationPerMillion: 3.75,
  },
  'claude-opus-4-6': {
    inputPerMillion: 15.0,
    outputPerMillion: 75.0,
    cacheReadPerMillion: 1.5,
    cacheCreationPerMillion: 18.75,
  },
  'gpt-4o-mini': {
    inputPerMillion: 0.15,
    outputPerMillion: 0.6,
    cacheReadPerMillion: 0.075,
    cacheCreationPerMillion: 0.15,
  },
  'gpt-4o': {
    inputPerMillion: 2.5,
    outputPerMillion: 10.0,
    cacheReadPerMillion: 1.25,
    cacheCreationPerMillion: 2.5,
  },
}

/**
 * Calcula custo aproximado em USD baseado nos tokens e modelo.
 */
export const calcularCusto = (model: string, usage: LLMUsage): number => {
  const pricing = PRICING[model]
  if (!pricing) return 0

  const base =
    (usage.inputTokens * pricing.inputPerMillion) / 1_000_000 +
    (usage.outputTokens * pricing.outputPerMillion) / 1_000_000 +
    (usage.cacheReadTokens * pricing.cacheReadPerMillion) / 1_000_000 +
    (usage.cacheCreationTokens * pricing.cacheCreationPerMillion) / 1_000_000

  return Math.round(base * 1_000_000) / 1_000_000 // arredonda 6 casas
}

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

  private buildMessages(messages: LLMMessage[]) {
    return messages.map((m) => {
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
    })
  }

  async generate(params: LLMGenerateParams): Promise<string> {
    const r = await this.generateWithUsage(params)
    return r.text
  }

  async generateWithUsage({
    systemPrompt,
    messages,
    maxTokens,
  }: LLMGenerateParams): Promise<LLMResult> {
    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
      system: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: this.buildMessages(messages),
    })

    const textos: string[] = []
    for (const bloco of resp.content) {
      if (bloco.type === 'text') textos.push(bloco.text)
    }
    const text = textos.join('\n').trim()

    const u = resp.usage as {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }

    return {
      text,
      usage: {
        inputTokens: u?.input_tokens ?? 0,
        outputTokens: u?.output_tokens ?? 0,
        cacheReadTokens: u?.cache_read_input_tokens ?? 0,
        cacheCreationTokens: u?.cache_creation_input_tokens ?? 0,
      },
    }
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

  private buildMessages(systemPrompt: string, messages: LLMMessage[]) {
    return [
      { role: 'system' as const, content: systemPrompt },
      ...messages.map((m) => {
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
    ]
  }

  async generate(params: LLMGenerateParams): Promise<string> {
    const r = await this.generateWithUsage(params)
    return r.text
  }

  async generateWithUsage({
    systemPrompt,
    messages,
    maxTokens,
  }: LLMGenerateParams): Promise<LLMResult> {
    const resp = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: this.buildMessages(systemPrompt, messages),
    })

    const text = resp.choices[0]?.message?.content?.trim() ?? ''
    const u = resp.usage as
      | {
          prompt_tokens?: number
          completion_tokens?: number
          prompt_tokens_details?: { cached_tokens?: number }
        }
      | undefined

    const cacheRead = u?.prompt_tokens_details?.cached_tokens ?? 0
    const inputTotal = u?.prompt_tokens ?? 0
    const inputNaoCache = Math.max(0, inputTotal - cacheRead)

    return {
      text,
      usage: {
        inputTokens: inputNaoCache,
        outputTokens: u?.completion_tokens ?? 0,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: 0,
      },
    }
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
      throw new Error('LLM_PROVIDER=claude mas ANTHROPIC_API_KEY nao foi definida')
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
