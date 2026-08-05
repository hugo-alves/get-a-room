# Acessos e ensaio com dois agentes

## O que o Codex precisa no VPS

Fornecer:

- uma pasta ou repositório limpo onde possa criar o projeto;
- Node.js 22 ou superior e `pnpm`;
- Git, se quiser guardar o trabalho em commits;
- autenticação Cloudflare por `wrangler login` **ou** `CLOUDFLARE_API_TOKEN`;
- permissão na conta para criar e publicar um Worker com Durable Objects.

Não são necessárias chaves OpenAI, Anthropic ou de outro modelo. O serviço não executa agentes: apenas transporta mensagens entre agentes que já estão a correr noutro local.

Se usar um token Cloudflare, limite-o ao Worker e à respetiva configuração. Disponibilize-o no ambiente, nunca nos documentos ou no repositório. Sem autenticação, o Codex conclui a versão local e deixa a publicação como único passo pendente. Pode decidir nomes, bibliotecas pequenas e organização interna sem esperar.

## Mensagem para iniciar o trabalho

Depois de copiar e extrair este ZIP no VPS, pode enviar ao Codex:

> Lê os quatro ficheiros por ordem, começando em `00_COMECAR_AQUI.md`. Constrói o ensaio técnico descrito na pasta/repositório que te indiquei, testa-o localmente e publica-o na Cloudflare se o acesso estiver disponível. Mantém o âmbito pequeno, não registes conteúdo nem convites e deixa `DEMO_REPORT.md` com resultados verificáveis. Podes tomar decisões técnicas pequenas sem esperar por mim; se a publicação ficar bloqueada, conclui tudo o resto e deixa o comando exato para continuar.

## Tarefa para a primeira sala

Guardar o texto seguinte em `task.md`:

```markdown
# Tarefa

Desenhar o percurso de integração mais pequeno para uma aplicação para computador que dá a colaboradores não técnicos acesso a agentes de programação aprovados pela empresa.

Incluir início de sessão, instalação ou verificação local, credencial virtual sem chave em bruto, tarefa inofensiva, ajuda e confirmação para o administrador. O percurso deve demorar menos de 10 minutos.

Não pedir ao utilizador que compreenda terminal, modelos, chaves de API ou MCP. Entregar uma proposta curta em Markdown com passos, estados de erro recuperáveis e duas métricas de sucesso.
```

## Instruções para o creator

Dar a este agente apenas o seu convite e o endereço do Worker:

```text
Estás no papel de creator. Usa exclusivamente roomctl para colaborar na sala indicada pela tua capacidade privada.

1. Lê a tarefa e envia uma proposta curta ao guest.
2. Espera pela crítica sem pedir a uma pessoa que transporte mensagens.
3. Responde às questões importantes e melhora a proposta.
4. Cria result.md e submete-o com roomctl final.

Mantém a conversa focada. Não mostres a capacidade privada e não inventes aprovação do guest.
```

## Instruções para o guest

Dar a este agente apenas o seu convite e o endereço do Worker:

```text
Estás no papel de guest. Usa exclusivamente roomctl para colaborar na sala indicada pelo convite.

1. Espera pela proposta e identifica os dois ou três problemas com maior impacto.
2. Envia uma crítica concreta e sugestões possíveis.
3. Lê a revisão e explica uma vez qualquer problema ainda importante.
4. Quando estiver suficientemente forte, envia READY e um resumo de uma frase.

Não submetas o resultado final e não mostres o convite.
```

## Como passar os convites

Para este teste, copiar cada convite para uma variável de ambiente na máquina correspondente:

Exemplo de uso sem gravar o token num ficheiro:

```bash
export ROOM_INVITE='token-recebido-em-segredo'
pnpm roomctl status --invite "$ROOM_INVITE" --base-url "$ROOM_BASE_URL"
```

No fim, remover a variável da sessão. A capacidade deixa de ser útil quando a sala expira, é recolhida ou fechada.
