import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { env } from './lib/env.js'
import { whatsappRoutes } from './routes/whatsapp.js'
import { webhooksEvolutionRoutes } from './routes/webhooks-evolution.js'
import { webhooksCheckoutRoutes } from './routes/webhooks-checkout.js'
import { adminRoutes } from './routes/admin.js'
import { iniciarWorkerAutomacoes } from './services/worker-automacoes.js'
import { rateLimit } from './middleware/rate-limit.js'

const config = env()

const app = new Hono()

// Logger
app.use('*', logger())

// CORS — libera frontend
const origins = config.ALLOWED_ORIGINS.split(',').map((s) => s.trim())
app.use(
  '/whatsapp/*',
  cors({
    origin: origins,
    credentials: true,
    allowHeaders: ['Content-Type', 'Authorization'],
  })
)
app.use(
  '/admin/*',
  cors({
    origin: origins,
    credentials: true,
    allowHeaders: ['Content-Type', 'Authorization'],
  })
)

// Health check
app.get('/', (c) => c.text('RoboVendas Backend OK'))
app.get('/health', (c) =>
  c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: config.NODE_ENV,
  })
)

// Rate limiting — defesa contra brute force + DoS
// Webhooks publicos: 120 req/min por IP (provedores enviam em bursts)
app.use(
  '/webhooks/*',
  rateLimit({
    max: 120,
    windowMs: 60_000,
    message: 'Muitas requisicoes ao webhook. Aguarde.',
  })
)
// Rotas autenticadas: 300 req/min por IP (uso normal alto)
app.use(
  '/whatsapp/*',
  rateLimit({
    max: 300,
    windowMs: 60_000,
  })
)
// Admin: 120 req/min (uso menos intenso)
app.use(
  '/admin/*',
  rateLimit({
    max: 120,
    windowMs: 60_000,
  })
)

// Rotas autenticadas
app.route('/whatsapp', whatsappRoutes)
app.route('/admin', adminRoutes)

// Webhooks publicos (sem auth — validam por secret)
app.route('/webhooks', webhooksEvolutionRoutes)
app.route('/webhooks/checkout', webhooksCheckoutRoutes)

// Handler de erro global
app.onError((err, c) => {
  console.error('[unhandled]', err)
  return c.json({ error: 'Internal server error', message: err.message }, 500)
})

// Start
serve(
  {
    fetch: app.fetch,
    port: config.PORT,
  },
  (info) => {
    console.log(`✅ RoboVendas Backend rodando em http://localhost:${info.port}`)
    console.log(`   NODE_ENV=${config.NODE_ENV}`)
    console.log(`   Webhook publico: ${config.BACKEND_PUBLIC_URL}/webhooks/evolution`)
    // Inicia worker de automacoes agendadas
    iniciarWorkerAutomacoes()
  }
)
