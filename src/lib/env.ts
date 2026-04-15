import { z } from 'zod'

const envSchema = z.object({
  // Server
  PORT: z.coerce.number().default(3001),
  NODE_ENV: z.enum(['development', 'production']).default('development'),

  // Supabase
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // Evolution API
  EVOLUTION_API_URL: z.string().url(),
  EVOLUTION_API_KEY: z.string().min(1),

  // Backend exposure (para webhook URL que Evolution vai chamar)
  BACKEND_PUBLIC_URL: z.string().url(),

  // CORS
  ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),

  // LLM
  LLM_PROVIDER: z.enum(['claude', 'openai']).default('claude'),
  LLM_MODEL: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
})

export type Env = z.infer<typeof envSchema>

let cached: Env | null = null

export const env = (): Env => {
  if (cached) return cached
  const parsed = envSchema.safeParse(process.env)
  if (!parsed.success) {
    console.error('❌ Env invalida:', parsed.error.flatten().fieldErrors)
    process.exit(1)
  }
  cached = parsed.data
  return cached
}
