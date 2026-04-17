import { supabase } from '../lib/supabase.js'
import { executarAutomacao } from './executar-automacao.js'

const INTERVALO_MS = 30 * 1000 // Checa a cada 30s

/**
 * Worker que processa a fila `automacoes_pendentes`.
 * Roda em loop (setInterval) no boot do servidor.
 *
 * Concorrencia safe: cada pendente e "claimed" atomicamente via
 * UPDATE filtrado por status=PENDENTE. Se 2 workers pegam a mesma
 * fila, so um consegue claimar e o outro pula.
 */
export const iniciarWorkerAutomacoes = (): void => {
  console.log(`[worker-automacoes] iniciando (intervalo=${INTERVALO_MS}ms)`)

  const processar = async () => {
    try {
      const agora = new Date().toISOString()
      const { data: pendentes, error } = await supabase
        .from('automacoes_pendentes')
        .select('*, automacoes(*)')
        .eq('status', 'PENDENTE')
        .lte('executar_em', agora)
        .limit(20)

      if (error) {
        console.error('[worker-automacoes] erro buscar fila:', error)
        return
      }

      if (!pendentes || pendentes.length === 0) return

      console.log(`[worker-automacoes] ${pendentes.length} candidatos na fila`)

      let processados = 0

      for (const pendente of pendentes) {
        const pendenteId = (pendente as { id: string }).id

        // Claim atomic: tenta virar PROCESSANDO apenas se ainda esta PENDENTE.
        // Se outro worker ja pegou, .single() retorna null e pulamos.
        const { data: claimed } = await supabase
          .from('automacoes_pendentes')
          .update({ status: 'PROCESSANDO' })
          .eq('id', pendenteId)
          .eq('status', 'PENDENTE')
          .select('id')
          .maybeSingle()

        if (!claimed) {
          // Outro worker pegou esse registro ou status mudou — pula
          continue
        }

        processados++

        const auto = (pendente as { automacoes?: unknown }).automacoes as
          | {
              id: string
              user_id: string
              nome: string
              ativo: boolean
              evento: string
              provedor: string | null
              produto_id: string | null
              agente_id: string | null
              mensagem_inicial: string | null
              delay_minutos: number
              executar_se_existe: boolean
            }
          | null

        if (!auto || !auto.ativo) {
          await supabase
            .from('automacoes_pendentes')
            .update({
              status: 'FALHOU',
              executada_em: new Date().toISOString(),
              erro: 'Automacao nao encontrada ou inativa',
            })
            .eq('id', pendenteId)
          continue
        }

        try {
          await executarAutomacao(
            auto,
            (pendente as { dados_evento: Parameters<typeof executarAutomacao>[1] })
              .dados_evento
          )

          await supabase
            .from('automacoes_pendentes')
            .update({
              status: 'EXECUTADA',
              executada_em: new Date().toISOString(),
            })
            .eq('id', pendenteId)
        } catch (e) {
          console.error(`[worker-automacoes] erro executar ${auto.nome}:`, e)
          await supabase
            .from('automacoes_pendentes')
            .update({
              status: 'FALHOU',
              executada_em: new Date().toISOString(),
              erro: e instanceof Error ? e.message : String(e),
            })
            .eq('id', pendenteId)
        }
      }

      if (processados > 0) {
        console.log(`[worker-automacoes] processou ${processados} pendentes`)
      }
    } catch (e) {
      console.error('[worker-automacoes] erro no loop:', e)
    }
  }

  // Primeira execucao em 5s (dar tempo do server subir), depois intervalo
  setTimeout(() => {
    processar()
    setInterval(processar, INTERVALO_MS)
  }, 5000)
}
