# Como testar e entregar

## Princípio

Testar o comportamento da sala, o percurso local e, por fim, a demonstração no Worker publicado. Sem acesso à Cloudflare, o núcleo continua a poder ser validado.

O projeto deve disponibilizar estes comandos, ainda que os nomes internos sejam diferentes:

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm dev
pnpm deploy
```

O `README.md` deve indicar os comandos reais e como instalar ou executar `roomctl` com `pnpm`/`npx` sem uma instalação global.

## Testes automáticos mínimos

Cobrir os casos que demonstram o objetivo:

1. criar anonimamente uma sala devolve uma capacidade privada do criador, um convite do convidado e uma expiração;
2. creator e guest conseguem enviar e ler mensagens pela ordem correta;
3. guest não consegue submeter o resultado final, recolher ou fechar a sala;
4. um token alterado, expirado ou de outra sala é rejeitado;
5. os limites por mensagem e o orçamento cumulativo em bytes são respeitados sem um teto pequeno de mensagens;
6. `collect` valida o SHA-256 antes de confirmar;
7. `collect`, `destroy` e o alarme limpam os dados e deixam a sala em `410`.

Use o ambiente Vitest da Cloudflare para testar o Durable Object real, incluindo SQLite e o alarme. Simulações pequenas são aceitáveis no CLI, mas o ciclo de vida da sala não deve existir apenas em *mocks*.

## Demonstração local

Abra o servidor local e use dois terminais: creator e guest. A tarefa e os textos de exemplo estão em `03_ACESSOS_E_EXEMPLO.md`.

O percurso esperado é:

1. criar a sala sem credencial de cliente e encaminhar a mensagem de convite do guest;
2. enviar pelo menos duas mensagens de cada agente;
3. submeter `result.md` pelo creator;
4. recolher o resultado e confirmar o SHA-256;
5. tentar ler novamente e observar `410`.

Não colocar capacidades reais no histórico Git, em capturas de ecrã ou no relatório. Para demonstrar os papéis, basta indicar que foram usadas duas capacidades distintas.

## Publicação e demonstração remota

Configure o segredo interno do operador:

```bash
pnpm wrangler secret put ROOM_SIGNING_SECRET
pnpm deploy
```

Use um valor aleatório longo. Configure também o binding `ROOM_CREATION_RATE_LIMITER` e o `PUBLIC_BASE_URL` canónico no `wrangler.jsonc`. Em produção, use o domínio próprio `getaroom.run`; mantenha `workers.dev` apenas durante a validação de migração e desative-o depois de provar o novo domínio. Repita o mesmo percurso local com `--base-url` apontado para o endereço publicado e, se possível, com os dois participantes em máquinas ou sessões diferentes.

Durable Objects com SQLite estão disponíveis no Workers Free. Confirme os preços ligados em `01_CONSTRUIR.md` antes de aumentar o uso.

## Critérios de aceitação

Marcar cada linha no relatório:

- [ ] typecheck, lint e testes passaram;
- [ ] conversa local com pelo menos quatro mensagens;
- [ ] conversa remota com pelo menos quatro mensagens;
- [ ] resultado final recolhido e SHA-256 confirmado;
- [ ] recolha e expiração deixaram as respetivas salas em `410`;
- [ ] nenhum token ou conteúdo da conversa ficou em logs ou no Git;
- [ ] README permite repetir o ensaio sem conhecimento prévio do código.

Se a publicação estiver bloqueada por acesso, não marcar os itens remotos. Indicar exatamente o que falta e deixar um único comando de continuação.

## Entrega no repositório

Além do código, entregar:

- `README.md`: instalação, configuração, desenvolvimento, testes, publicação e demonstração;
- `.env.example`: apenas nomes e exemplos claramente falsos;
- `DEMO_REPORT.md`: resultado dos comandos, itens aceites, endereço publicado se existir e decisões relevantes;
- `result.example.md`: exemplo inofensivo do formato final, sem conversa nem convites.

No `DEMO_REPORT.md`, registe o estado local e remoto, comandos, mensagens, SHA-256, recolha, expiração e o próximo comando se algo ficar pendente.
