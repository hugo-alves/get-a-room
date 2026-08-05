# Sala temporária para dois agentes

## Missão desta noite

Construir e testar uma versão de uma sala onde dois agentes, mesmo a correr em máquinas diferentes, conseguem colaborar por texto. O agente criador abre a sala, o convidado entra por uma ligação privada e ambos colaboram antes de o criador entregar um resultado final em Markdown.

A sala vive na Cloudflare durante poucos minutos. Depois de o resultado ser recolhido — ou quando o prazo termina — os dados da sala são apagados. O resultado final fica guardado apenas na máquina de quem criou a sala.

Isto é um **ensaio técnico**, não uma plataforma pronta para utilizadores. O objetivo é descobrir se o mecanismo é simples e fiável antes de acrescentar integrações.

## Experiência que queremos provar

1. O criador abre anonimamente uma sala e recebe uma capacidade privada e uma ligação pronta a partilhar com o convidado.
2. Cada agente entra da sua máquina através da ferramenta `roomctl`, sem conta.
3. Os agentes conversam e o `creator` submete o resultado em Markdown.
4. O criador recolhe-o e a sala é apagada; salas abandonadas expiram sozinhas.

## Decisões já tomadas

Estas decisões servem para manter o primeiro teste curto e comparável:

- TypeScript, Node.js 22 ou superior e `pnpm`.
- Um Cloudflare Worker como endereço público.
- Um Durable Object com armazenamento SQLite por sala.
- Pedidos HTTP com espera curta (*polling*), em vez de WebSockets.
- Exatamente dois papéis: `creator` e `guest`.
- Convites assinados, temporários e limitados a um papel.
- Duração normal de 24 horas, entre 15 minutos e 7 dias, com limites generosos baseados em bytes em vez de um máximo pequeno de mensagens.
- Conteúdo apenas no Durable Object da sala; sem base de dados externa.
- O servidor não chama modelos de IA. Os agentes já existem e apenas usam a sala.

O *polling* é suficiente porque haverá poucas mensagens e simplifica a ferramenta usada pelos agentes. O Durable Object é útil porque mantém uma conversa ordenada num único lugar e permite apagá-la como uma unidade.

## O que significa “feito”

O ensaio está concluído quando:

- os testes automáticos e uma conversa local passam;
- dois agentes trocam pelo menos quatro mensagens no Worker publicado;
- o resultado final é guardado localmente e o seu SHA-256 é confirmado;
- a sala recolhida e uma sala expirada deixam de estar acessíveis;
- o `README.md` permite repetir instalação, publicação e demonstração.

## Ordem de trabalho

1. Ler os quatro documentos antes de alterar o repositório.
2. Construir o Worker, o Durable Object e `roomctl`.
3. Testar localmente, publicar e repetir contra o domínio canónico `getaroom.run`.
4. Guardar o relatório pedido em `02_TESTAR_E_ENTREGAR.md`.

Se faltar acesso à Cloudflare, a construção e os testes locais devem continuar. Nesse caso, deixar a publicação preparada e indicar, de forma breve, o comando e o acesso que faltam.

## Limites do ensaio

Não construir nesta versão: interface web, Agents SDK, MCP, R2, Workflows, RealtimeKit, Workers AI, `@cloudflare/computer`, integração com Forge, vários participantes ou conversas permanentes. Os agentes já correm fora da Cloudflare; primeiro, provar o transporte, a recolha e o apagamento.

Começar agora por `01_CONSTRUIR.md`.
