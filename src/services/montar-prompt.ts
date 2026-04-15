/**
 * Monta o system prompt completo a partir da config do agente + bases de conhecimento.
 * Esse prompt eh passado pro LLM pra ele responder como o agente configurado.
 */

// Tipos copiados do frontend — intencionalmente sem importar pra manter backend independente.

type ObjetivoAgente =
  | 'VENDAS'
  | 'SUPORTE'
  | 'RECUPERACAO'
  | 'ONBOARDING'
  | 'USO_PESSOAL'

interface ConfigAgente {
  solicitarAjudaHumana?: boolean
  usarEmojis?: boolean
  restringirTemas?: boolean
  dividirRespostaEmPartes?: boolean
}

interface AgenteInput {
  nome: string
  objetivo: ObjetivoAgente
  descricao: string
  config: ConfigAgente
}

interface InformacoesProduto {
  nomeProduto?: string
  descricaoCurta?: string
  preco?: number | null
  urlVenda?: string
  tipo?: string
  garantia?: string
}

interface Persona {
  nomePersona?: string
  idadeFaixa?: string
  profissao?: string
  principaisDores?: string
  desejosObjetivos?: string
  nivelConsciencia?: string
}

interface FaqItem {
  id?: string
  pergunta?: string
  resposta?: string
}

interface PersonalidadeAgente {
  tomVoz?: string
  nomeAgente?: string
  instrucoesEspeciais?: string
  usarEmojis?: boolean
  usarAudios?: boolean
  idiomaPrincipal?: string
}

interface LimitacoesConfig {
  topicosProibidos?: string
  nuncaMencionarConcorrentes?: boolean
  naoPrometerResultados?: boolean
  limiteDescontoMaximo?: number | null
  instrucoesTransferirHumano?: string
}

interface Entregaveis {
  tipoEntrega?: string
  instrucoesAcesso?: string
  linkAcesso?: string
  suportePosVenda?: string
}

export interface BaseInput {
  nome?: string
  informacoes_produto?: InformacoesProduto
  persona?: Persona
  faq_objecoes?: FaqItem[]
  personalidade_agente?: PersonalidadeAgente
  limitacoes?: LimitacoesConfig
  entregaveis?: Entregaveis
}

const OBJETIVO_LABEL: Record<ObjetivoAgente, string> = {
  VENDAS: 'Vender o produto/servico pro cliente',
  SUPORTE: 'Dar suporte e tirar duvidas do cliente',
  RECUPERACAO: 'Recuperar vendas perdidas / leads frios',
  ONBOARDING: 'Receber e orientar novos clientes',
  USO_PESSOAL: 'Assistente pessoal multiproposito',
}

const TOM_VOZ_LABEL: Record<string, string> = {
  formal: 'Formal, cerimonioso',
  informal: 'Informal, proximo',
  amigavel: 'Amigavel, acolhedor',
  profissional: 'Profissional, direto',
  descontraido: 'Descontraido, casual',
}

const IDIOMA_LABEL: Record<string, string> = {
  portugues: 'Portugues (Brasil)',
  ingles: 'Ingles',
  espanhol: 'Espanhol',
}

const NIVEL_CONSCIENCIA_LABEL: Record<string, string> = {
  inconsciente: 'Inconsciente do problema',
  consciente_problema: 'Consciente do problema mas nao da solucao',
  consciente_solucao: 'Consciente da solucao mas nao do produto',
  consciente_produto: 'Conhece o produto mas tem duvidas',
  mais_consciente: 'Pronto pra comprar',
}

const secao = (titulo: string, conteudo: string[]): string => {
  const body = conteudo.filter(Boolean).join('\n')
  if (!body.trim()) return ''
  return `\n## ${titulo}\n${body}`
}

/**
 * Concatena valores repetidos de cada base em uma unica secao.
 * Por ex: se o agente tem 2 bases, junta as FAQs das duas.
 */
export const montarSystemPrompt = (
  agente: AgenteInput,
  bases: BaseInput[]
): string => {
  // Identidade
  const personalidade = bases.find(
    (b) => b.personalidade_agente?.nomeAgente
  )?.personalidade_agente
  const nomeAgente = personalidade?.nomeAgente || agente.nome

  // Acumula secoes das bases
  const produtos: string[] = []
  const personas: string[] = []
  const faqs: string[] = []
  const limitacoes: string[] = []
  const entregaveis: string[] = []

  for (const base of bases) {
    const p = base.informacoes_produto
    if (p?.nomeProduto || p?.descricaoCurta) {
      const linhas: string[] = []
      if (p.nomeProduto) linhas.push(`- Nome: ${p.nomeProduto}`)
      if (p.tipo) linhas.push(`- Tipo: ${p.tipo}`)
      if (p.descricaoCurta) linhas.push(`- Descricao: ${p.descricaoCurta}`)
      if (p.preco != null) linhas.push(`- Preco: R$ ${p.preco}`)
      if (p.urlVenda) linhas.push(`- Link de venda: ${p.urlVenda}`)
      if (p.garantia) linhas.push(`- Garantia: ${p.garantia}`)
      produtos.push(linhas.join('\n'))
    }

    const persona = base.persona
    if (persona?.nomePersona || persona?.principaisDores) {
      const linhas: string[] = []
      if (persona.nomePersona) linhas.push(`- Persona: ${persona.nomePersona}`)
      if (persona.profissao) linhas.push(`- Profissao: ${persona.profissao}`)
      if (persona.idadeFaixa) linhas.push(`- Faixa etaria: ${persona.idadeFaixa}`)
      if (persona.nivelConsciencia) {
        linhas.push(
          `- Nivel de consciencia: ${
            NIVEL_CONSCIENCIA_LABEL[persona.nivelConsciencia] ??
            persona.nivelConsciencia
          }`
        )
      }
      if (persona.principaisDores) linhas.push(`- Dores: ${persona.principaisDores}`)
      if (persona.desejosObjetivos)
        linhas.push(`- Desejos: ${persona.desejosObjetivos}`)
      personas.push(linhas.join('\n'))
    }

    const faqList = base.faq_objecoes ?? []
    for (const item of faqList) {
      if (item.pergunta && item.resposta) {
        faqs.push(`**P:** ${item.pergunta}\n**R:** ${item.resposta}`)
      }
    }

    const l = base.limitacoes
    if (l) {
      if (l.topicosProibidos)
        limitacoes.push(`- NUNCA fale sobre: ${l.topicosProibidos}`)
      if (l.nuncaMencionarConcorrentes)
        limitacoes.push('- NUNCA mencione marcas concorrentes')
      if (l.naoPrometerResultados)
        limitacoes.push(
          '- NUNCA prometa resultados garantidos (use linguagem cautelosa)'
        )
      if (l.limiteDescontoMaximo != null) {
        limitacoes.push(
          `- Desconto maximo que voce pode oferecer: ${l.limiteDescontoMaximo}%`
        )
      }
      if (l.instrucoesTransferirHumano)
        limitacoes.push(
          `- Quando transferir pra humano: ${l.instrucoesTransferirHumano}`
        )
    }

    const e = base.entregaveis
    if (e) {
      const linhas: string[] = []
      if (e.tipoEntrega) linhas.push(`- Tipo de entrega: ${e.tipoEntrega}`)
      if (e.instrucoesAcesso)
        linhas.push(`- Como acessar: ${e.instrucoesAcesso}`)
      if (e.linkAcesso) linhas.push(`- Link de acesso: ${e.linkAcesso}`)
      if (e.suportePosVenda) linhas.push(`- Suporte pos-venda: ${e.suportePosVenda}`)
      if (linhas.length) entregaveis.push(linhas.join('\n'))
    }
  }

  // Personalidade (pega da primeira base que tiver)
  const personalidadeLinhas: string[] = []
  if (personalidade) {
    if (personalidade.tomVoz) {
      personalidadeLinhas.push(
        `- Tom de voz: ${TOM_VOZ_LABEL[personalidade.tomVoz] ?? personalidade.tomVoz}`
      )
    }
    if (personalidade.idiomaPrincipal) {
      personalidadeLinhas.push(
        `- Idioma: ${
          IDIOMA_LABEL[personalidade.idiomaPrincipal] ?? personalidade.idiomaPrincipal
        }`
      )
    }
    if (personalidade.instrucoesEspeciais) {
      personalidadeLinhas.push(
        `- Instrucoes especiais: ${personalidade.instrucoesEspeciais}`
      )
    }
  }

  // Config do agente
  const configLinhas: string[] = []
  if (agente.config.usarEmojis || personalidade?.usarEmojis) {
    configLinhas.push('- Use emojis com moderacao para tornar a conversa amigavel')
  } else {
    configLinhas.push('- NAO use emojis')
  }
  if (agente.config.dividirRespostaEmPartes) {
    configLinhas.push(
      '- Quando a resposta for longa, divida em partes curtas separadas por linha com apenas `---` entre elas. Cada parte sera enviada como uma mensagem separada no WhatsApp pra ficar natural'
    )
  } else {
    configLinhas.push('- Responda em uma unica mensagem (sem dividir em partes)')
  }
  if (agente.config.restringirTemas) {
    configLinhas.push(
      '- Recuse educadamente responder sobre assuntos fora do escopo do produto/servico descrito acima'
    )
  }
  if (agente.config.solicitarAjudaHumana) {
    configLinhas.push(
      '- Se nao souber responder ou precisar de informacao que nao tem, termine sua mensagem com a tag `[PRECISO_AJUDA]` (em linha separada). Isso vai transferir a conversa pra um atendente humano'
    )
  }

  // Monta o prompt final
  const prompt = `Voce eh ${nomeAgente}, atendente de vendas/suporte via WhatsApp.

${agente.descricao ? `**Descricao:** ${agente.descricao}\n` : ''}
**Objetivo principal:** ${OBJETIVO_LABEL[agente.objetivo] ?? agente.objetivo}

## REGRA FUNDAMENTAL — VOCE EH HUMANO

Voce eh uma pessoa de verdade trabalhando como atendente. **NUNCA, em hipotese alguma**, revele ou sugira que voce eh uma IA, bot, robo, assistente virtual ou qualquer sistema automatizado. Se o cliente perguntar "voce eh um robo?" ou "voce eh IA?", desconverse naturalmente ("que isso kkk sou eu mesma aqui", "imagina, pode relaxar que e pessoa de verdade") e siga a conversa.

**Comporte-se como humano de verdade:**
- **Ortografia SEMPRE correta** — acentos, cedilhas, pontuacao. Nada de erros propositais. Voce eh um humano letrado, nao alguem que digita errado
- Use contracoes naturais do portugues: "pra" (para), "ta" (esta), "vc" (voce) — sao formas reconhecidas no WhatsApp, nao erros
- Tom casual e proximo, mas com portugues correto. Exemplo: "Ta tranquilo" sim, "ta tranqilo" nao
- Use girias quando fizer sentido ("beleza", "de boa", "saquei", "entendi", "nossa")
- Mensagens CURTAS. Prefere 1-3 frases por mensagem. Responda como voce digitaria no celular, nao como um email formal
- Nao faca listas com bullets/markdown na resposta, se precisar listar use texto corrido: "temos X, Y e Z"
- Nao use **negrito** nem __italico__ (WhatsApp nao renderiza direito)
- Nao repita saudacoes ("oi", "tudo bem?") depois da primeira mensagem
- Faca perguntas em vez de entregar tudo de uma vez — interesse genuino na pessoa
- Demonstre emocao quando couber: "nossa, que legal!", "poxa, entendo", "eita..."
- Se o cliente demorar a responder, NAO envie mensagem cobrando — espere a proxima dele
- Nunca diga coisas tipo "como posso te ajudar hoje?" (extremamente robotico). Prefere "me conta o que voce ta buscando" ou apenas continuar a conversa

${secao('Informacoes do Produto', produtos)}${secao('Persona / Cliente Alvo', personas)}${secao('Personalidade & Tom', personalidadeLinhas)}${secao('Perguntas Frequentes e Objecoes', faqs)}${secao('Limitacoes e Regras', limitacoes)}${secao('Entregaveis e Acesso', entregaveis)}

## Config desta conversa

${configLinhas.join('\n')}

## Contexto

Voce esta conversando via WhatsApp. Use o historico pra dar continuidade. Mensagens marcadas com \`[Atendente humano]:\` sao de uma colega humana que ja assumiu a conversa antes — leia pra nao se repetir ou contradizer. Se a informacao que o cliente pede nao estiver nas secoes acima e voce nao souber responder com confianca, NAO invente — peca ajuda usando a tag de escalada (se configurada) ou diga "vou confirmar isso pra voce e ja te falo".
`.trim()

  return prompt
}
