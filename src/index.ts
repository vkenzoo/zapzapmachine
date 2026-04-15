import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { env } from './lib/env.js'
import { whatsappRoutes } from './routes/whatsapp.js'
import { webhooksEvolutionRoutes } from './routes/webhooks-evolution.js'

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

// Health check
app.get('/', (c) => c.text('RoboVendas Backend OK'))
app.get('/health', (c) =>
  c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: config.NODE_ENV,
  })
)

// Rotas autenticadas
app.route('/whatsapp', whatsappRoutes)

// Webhooks publicos (sem auth)
app.route('/webhooks', webhooksEvolutionRoutes)

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
  }
)
