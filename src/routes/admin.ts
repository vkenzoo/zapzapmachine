import { Hono } from 'hono'
import { z } from 'zod'
import { adminAuth } from '../middleware/admin.js'
import { supabase } from '../lib/supabase.js'
import { invalidarCacheRegras } from '../services/montar-prompt.js'
import { logEvento } from '../services/log-evento.js'
import { httpError } from '../lib/http-error.js'

export const adminRoutes = new Hono<{
  Variables: { userId: string }
}>()

adminRoutes.use('/*', adminAuth)

// ============================================================
// STATS — KPIs globais
// ============================================================

adminRoutes.get('/stats', async (c) => {
  const [usuarios, whatsapps, agentes, bases, automacoes] = await Promise.all([
    supabase.from('usuarios').select('id', { count: 'exact', head: true }),
    supabase.from('instancias_whatsapp').select('id', { count: 'exact', head: true }),
    supabase.from('agentes').select('id', { count: 'exact', head: true }),
    supabase.from('bases_conhecimento').select('id', { count: 'exact', head: true }),
    supabase.from('automacoes').select('id', { count: 'exact', head: true }),
  ])

  // Gasto total IA (todos os tempos)
  const { data: gastoTotal } = await supabase
    .from('logs_ia')
    .select('custo_usd')

  const totalUSD = (gastoTotal ?? []).reduce(
    (sum, l) => sum + Number(l.custo_usd ?? 0),
    0
  )

  // Gasto ultimo 30 dias
  const trintaDias = new Date(Date.now() - 30 * 86400 * 1000).toISOString()
  const { data: gasto30d } = await supabase
    .from('logs_ia')
    .select('custo_usd')
    .gte('criado_em', trintaDias)

  const total30dUSD = (gasto30d ?? []).reduce(
    (sum, l) => sum + Number(l.custo_usd ?? 0),
    0
  )

  return c.json({
    totalUsuarios: usuarios.count ?? 0,
    totalWhatsapps: whatsapps.count ?? 0,
    totalAgentes: agentes.count ?? 0,
    totalBases: bases.count ?? 0,
    totalAutomacoes: automacoes.count ?? 0,
    gastoIaTotalUSD: Math.round(totalUSD * 10000) / 10000,
    gastoIa30dUSD: Math.round(total30dUSD * 10000) / 10000,
  })
})

// ============================================================
// USUARIOS
// ============================================================

adminRoutes.get('/usuarios', async (c) => {
  // Join com auth.users pra pegar email
  const { data: usuarios, error } = await supabase
    .from('usuarios')
    .select('id, nome, role, plano, status, criado_em, ultimo_login, foto_url, agentes_desligados')
    .order('criado_em', { ascending: false })

  if (error) return httpError(c, 500, 'Erro ao processar requisicao', error)

  // Busca emails via auth admin API
  const emails: Record<string, string> = {}
  if (usuarios && usuarios.length > 0) {
    const { data: authData } = await supabase.auth.admin.listUsers({
      perPage: 1000,
    })
    for (const u of authData?.users ?? []) {
      if (u.id && u.email) emails[u.id] = u.email
    }
  }

  const result = (usuarios ?? []).map((u) => ({
    ...u,
    email: emails[u.id] ?? null,
  }))

  return c.json(result)
})

adminRoutes.patch('/usuarios/:id/role', async (c) => {
  const adminUserId = c.get('userId')
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const parsed = z.object({ role: z.enum(['USER', 'ADMIN']) }).safeParse(body)

  if (!parsed.success) {
    return c.json({ error: 'role deve ser USER ou ADMIN' }, 400)
  }

  const { error } = await supabase
    .from('usuarios')
    .update({ role: parsed.data.role })
    .eq('id', id)

  if (error) return httpError(c, 500, 'Erro ao processar requisicao', error)

  logEvento({
    userId: adminUserId,
    categoria: 'ADMIN',
    acao: 'ALTERAR_ROLE',
    recursoTipo: 'USUARIO',
    recursoId: id,
    descricao: `Alterou role para ${parsed.data.role}`,
    detalhes: { alvoUserId: id, novaRole: parsed.data.role },
  })

  return c.json({ ok: true, role: parsed.data.role })
})

// ============================================================
// IA — relatorios de gasto
// ============================================================

adminRoutes.get('/ia/gastos', async (c) => {
  // Gastos por dia nos ultimos 30 dias
  const trintaDias = new Date(Date.now() - 30 * 86400 * 1000).toISOString()

  const { data, error } = await supabase
    .from('logs_ia')
    .select('criado_em, custo_usd, input_tokens, output_tokens, tipo, provider')
    .gte('criado_em', trintaDias)
    .order('criado_em', { ascending: false })

  if (error) return httpError(c, 500, 'Erro ao processar requisicao', error)

  // Agrupa por dia
  const porDia: Record<string, { custo: number; chamadas: number; tokens: number }> = {}
  for (const log of data ?? []) {
    const dia = (log.criado_em as string).substring(0, 10)
    if (!porDia[dia]) porDia[dia] = { custo: 0, chamadas: 0, tokens: 0 }
    porDia[dia].custo += Number(log.custo_usd ?? 0)
    porDia[dia].chamadas++
    porDia[dia].tokens += Number(log.input_tokens ?? 0) + Number(log.output_tokens ?? 0)
  }

  // Totais por tipo
  const porTipo: Record<string, { custo: number; chamadas: number }> = {}
  const porProvider: Record<string, { custo: number; chamadas: number }> = {}
  let custoTotal = 0
  let chamadas = 0

  for (const log of data ?? []) {
    const custo = Number(log.custo_usd ?? 0)
    custoTotal += custo
    chamadas++

    const tipo = (log.tipo as string) ?? 'chat'
    if (!porTipo[tipo]) porTipo[tipo] = { custo: 0, chamadas: 0 }
    porTipo[tipo].custo += custo
    porTipo[tipo].chamadas++

    const prov = (log.provider as string) ?? 'unknown'
    if (!porProvider[prov]) porProvider[prov] = { custo: 0, chamadas: 0 }
    porProvider[prov].custo += custo
    porProvider[prov].chamadas++
  }

  return c.json({
    periodo: '30d',
    custoTotalUSD: Math.round(custoTotal * 10000) / 10000,
    totalChamadas: chamadas,
    porDia: Object.entries(porDia)
      .map(([dia, v]) => ({
        dia,
        custoUSD: Math.round(v.custo * 10000) / 10000,
        chamadas: v.chamadas,
        tokens: v.tokens,
      }))
      .sort((a, b) => a.dia.localeCompare(b.dia)),
    porTipo: Object.entries(porTipo).map(([tipo, v]) => ({
      tipo,
      custoUSD: Math.round(v.custo * 10000) / 10000,
      chamadas: v.chamadas,
    })),
    porProvider: Object.entries(porProvider).map(([provider, v]) => ({
      provider,
      custoUSD: Math.round(v.custo * 10000) / 10000,
      chamadas: v.chamadas,
    })),
  })
})

adminRoutes.get('/ia/gastos-por-usuario', async (c) => {
  const { data, error } = await supabase
    .from('logs_ia')
    .select('user_id, custo_usd, input_tokens, output_tokens')

  if (error) return httpError(c, 500, 'Erro ao processar requisicao', error)

  const porUsuario: Record<
    string,
    { custo: number; chamadas: number; tokens: number }
  > = {}

  for (const log of data ?? []) {
    const uid = log.user_id as string
    if (!porUsuario[uid]) porUsuario[uid] = { custo: 0, chamadas: 0, tokens: 0 }
    porUsuario[uid].custo += Number(log.custo_usd ?? 0)
    porUsuario[uid].chamadas++
    porUsuario[uid].tokens +=
      Number(log.input_tokens ?? 0) + Number(log.output_tokens ?? 0)
  }

  // Join com nomes
  const userIds = Object.keys(porUsuario)
  const nomes: Record<string, string> = {}
  if (userIds.length > 0) {
    const { data: users } = await supabase
      .from('usuarios')
      .select('id, nome')
      .in('id', userIds)
    for (const u of users ?? []) {
      nomes[u.id as string] = (u.nome as string) ?? '—'
    }
  }

  return c.json(
    Object.entries(porUsuario)
      .map(([userId, v]) => ({
        userId,
        nome: nomes[userId] ?? '—',
        custoUSD: Math.round(v.custo * 10000) / 10000,
        chamadas: v.chamadas,
        tokens: v.tokens,
      }))
      .sort((a, b) => b.custoUSD - a.custoUSD)
  )
})

// ============================================================
// IA — logs paginados
// ============================================================

adminRoutes.get('/ia/logs', async (c) => {
  const page = Number(c.req.query('page') ?? '1')
  const limit = Math.min(100, Number(c.req.query('limit') ?? '50'))
  const offset = (page - 1) * limit

  const { data, error, count } = await supabase
    .from('logs_ia')
    .select('*', { count: 'exact' })
    .order('criado_em', { ascending: false })
    .range(offset, offset + limit - 1)

  if (error) return httpError(c, 500, 'Erro ao processar requisicao', error)

  return c.json({
    items: data ?? [],
    total: count ?? 0,
    page,
    limit,
  })
})

// ============================================================
// CHECKOUT — logs paginados
// ============================================================

adminRoutes.get('/checkout/logs', async (c) => {
  const page = Number(c.req.query('page') ?? '1')
  const limit = Math.min(100, Number(c.req.query('limit') ?? '50'))
  const offset = (page - 1) * limit

  const { data, error, count } = await supabase
    .from('logs_checkout')
    .select('*', { count: 'exact' })
    .order('criado_em', { ascending: false })
    .range(offset, offset + limit - 1)

  if (error) return httpError(c, 500, 'Erro ao processar requisicao', error)

  return c.json({
    items: data ?? [],
    total: count ?? 0,
    page,
    limit,
  })
})

// ============================================================
// EVENTOS — auditoria completa do sistema
// ============================================================

adminRoutes.get('/eventos/logs', async (c) => {
  const page = Number(c.req.query('page') ?? '1')
  const limit = Math.min(200, Number(c.req.query('limit') ?? '50'))
  const offset = (page - 1) * limit
  const categoria = c.req.query('categoria')
  const userId = c.req.query('userId')
  const search = c.req.query('search')

  let query = supabase
    .from('logs_eventos')
    .select('*', { count: 'exact' })
    .order('criado_em', { ascending: false })

  if (categoria) query = query.eq('categoria', categoria)
  if (userId) query = query.eq('user_id', userId)
  if (search) query = query.ilike('descricao', `%${search}%`)

  const { data, error, count } = await query.range(offset, offset + limit - 1)

  if (error) return httpError(c, 500, 'Erro ao processar requisicao', error)

  // Enriquece com nome do usuario
  const userIds = new Set<string>()
  for (const log of data ?? []) {
    if (log.user_id) userIds.add(log.user_id as string)
  }

  const nomes: Record<string, string> = {}
  if (userIds.size > 0) {
    const { data: users } = await supabase
      .from('usuarios')
      .select('id, nome')
      .in('id', Array.from(userIds))
    for (const u of users ?? []) {
      nomes[u.id as string] = (u.nome as string) ?? '—'
    }
  }

  const items = (data ?? []).map((log) => ({
    ...log,
    user_nome: log.user_id ? (nomes[log.user_id as string] ?? '—') : null,
  }))

  return c.json({
    items,
    total: count ?? 0,
    page,
    limit,
  })
})

adminRoutes.get('/eventos/stats', async (c) => {
  // Contagem por categoria nos ultimos 7 dias
  const seteDias = new Date(Date.now() - 7 * 86400 * 1000).toISOString()
  const { data, error } = await supabase
    .from('logs_eventos')
    .select('categoria, acao')
    .gte('criado_em', seteDias)

  if (error) return httpError(c, 500, 'Erro ao processar requisicao', error)

  const porCategoria: Record<string, number> = {}
  const porAcao: Record<string, number> = {}
  let total = 0

  for (const log of data ?? []) {
    const cat = (log.categoria as string) ?? 'SISTEMA'
    const ac = (log.acao as string) ?? '—'
    porCategoria[cat] = (porCategoria[cat] ?? 0) + 1
    porAcao[ac] = (porAcao[ac] ?? 0) + 1
    total++
  }

  return c.json({
    periodo: '7d',
    total,
    porCategoria: Object.entries(porCategoria)
      .map(([categoria, count]) => ({ categoria, count }))
      .sort((a, b) => b.count - a.count),
    porAcao: Object.entries(porAcao)
      .map(([acao, count]) => ({ acao, count }))
      .sort((a, b) => b.count - a.count),
  })
})

// ============================================================
// CONTROLE DE PROMPTS
// ============================================================

adminRoutes.get('/prompts', async (c) => {
  const { data, error } = await supabase
    .from('config_prompts_admin')
    .select('*')
    .order('chave', { ascending: true })

  if (error) return httpError(c, 500, 'Erro ao processar requisicao', error)
  return c.json(data ?? [])
})

adminRoutes.put('/prompts/:chave', async (c) => {
  const userId = c.get('userId')
  const chave = c.req.param('chave')
  const body = await c.req.json().catch(() => ({}))
  const parsed = z
    .object({
      titulo: z.string().optional(),
      conteudo: z.string(),
      ativo: z.boolean().optional(),
    })
    .safeParse(body)

  if (!parsed.success) {
    return c.json({ error: 'conteudo obrigatorio' }, 400)
  }

  const update: Record<string, unknown> = {
    conteudo: parsed.data.conteudo,
    atualizado_em: new Date().toISOString(),
    atualizado_por: userId,
  }
  if (parsed.data.titulo !== undefined) update.titulo = parsed.data.titulo
  if (parsed.data.ativo !== undefined) update.ativo = parsed.data.ativo

  const { error } = await supabase
    .from('config_prompts_admin')
    .update(update)
    .eq('chave', chave)

  if (error) return httpError(c, 500, 'Erro ao processar requisicao', error)

  // Invalida cache pra proxima chamada IA usar as novas regras
  invalidarCacheRegras()

  logEvento({
    userId,
    categoria: 'ADMIN',
    acao: 'EDITAR_PROMPT',
    recursoTipo: 'PROMPT',
    recursoId: chave,
    descricao: `Editou regra global "${chave}"`,
    detalhes: { ativo: parsed.data.ativo },
  })

  return c.json({ ok: true })
})
