# O que construir

## Visão simples

```text
agente A ─ roomctl ─┐
                    ├─ HTTPS ─ Worker ─ Durable Object da sala
agente B ─ roomctl ─┘
criador  ─ roomctl ────────────────────┘
```

Cada peça existe por uma razão concreta:

| Peça | Para que serve | Porque é necessária |
|---|---|---|
| Worker | Dá um endereço HTTPS comum | Os agentes podem estar em redes e máquinas diferentes |
| Durable Object | Guarda uma sala e ordena as mensagens | Evita conflitos e permite apagar a conversa como uma unidade |
| Convites assinados | Identificam sala, papel e prazo | Cada agente recebe apenas a capacidade de que precisa |
| `roomctl` | Expõe comandos simples no terminal | Codex e outros agentes conseguem usá-lo sem uma integração especial |
| Alarme | Expira uma sala abandonada | A limpeza não depende de alguém voltar mais tarde |
| Ficheiro local | Preserva apenas o resultado escolhido | A conversa pode desaparecer sem perder o trabalho final |

## Estrutura sugerida

Pode ajustar nomes pequenos se isso simplificar o código, mas mantenha as responsabilidades separadas:

```text
src/
  worker.ts          # rotas públicas e encaminhamento para a sala
  room.ts            # Durable Object, SQLite e ciclo de vida
  auth.ts            # criação e validação dos convites
  shared.ts          # tipos e validação dos pedidos
cli/
  roomctl.ts         # ferramenta usada pelo criador e pelos agentes
test/
  room.test.ts       # comportamento da sala
  cli.test.ts        # percurso principal pelo CLI
wrangler.jsonc
package.json
README.md
```

Use TypeScript em modo estrito. No `wrangler.jsonc`, use a configuração declarativa atual `exports` para o Durable Object SQLite e respetivo binding. Prefira dependências pequenas. Nunca escreva convites, tarefas, mensagens ou resultados nos logs.

## Estado de uma sala

Use três estados: `open`, `finalized` e `destroyed`. Guarde em SQLite os metadados da sala, mensagens numeradas e resultado final com SHA-256. Limites: 12 mensagens, 32 KiB por mensagem, 256 KiB para a tarefa e 512 KiB para o resultado. São suficientes para este ensaio e mantêm cada sala pequena.

## Convites

Ao criar a sala, emitir três tokens:

- `creator`: pode ver o estado, recolher o resultado e destruir a sala;
- `proposer`: pode ler, enviar mensagens e submeter o resultado final;
- `critic`: pode ler e enviar mensagens.

Assine os tokens com HMAC-SHA-256 usando o segredo Wrangler `ROOM_SIGNING_SECRET`. Inclua `room_id`, papel, emissão, expiração e um identificador aleatório. Rejeite tokens alterados, expirados ou usados noutra sala.

Uma chave separada, `ROOM_CREATOR_KEY`, protege apenas a criação de salas. Isto basta para impedir que um endereço de demonstração aberto seja usado livremente. Não é necessário criar contas ou um sistema de login nesta fase.

## Rotas HTTP

Implemente JSON sobre HTTPS. Uma forma direta é:

| Método e rota | Papel | Resultado |
|---|---|---|
| `POST /v1/rooms` | chave de criação | cria sala e devolve os três convites |
| `GET /v1/rooms/:id/status` | qualquer convite válido | estado, expiração, contagens e último número |
| `GET /v1/rooms/:id/messages?after=N&wait=20` | proposer/critic | mensagens posteriores a `N`; pode esperar até 20 s |
| `POST /v1/rooms/:id/messages` | proposer/critic | acrescenta uma mensagem |
| `POST /v1/rooms/:id/final` | proposer | guarda o Markdown final e respetivo SHA-256 |
| `GET /v1/rooms/:id/final` | creator | descarrega o resultado enquanto aguarda confirmação |
| `POST /v1/rooms/:id/collect` | creator | confirma o SHA-256 e apaga todo o conteúdo |
| `DELETE /v1/rooms/:id` | creator | termina a sala sem recolher resultado |

Valide token, papel, tipo, tamanho e estado antes de alterar dados. Numere as mensagens dentro do Durable Object. Leituras não prolongam a expiração. Depois da limpeza, a ausência de metadados significa `410`; não trate a sala como nova. Use `storage.deleteAll()` e data de compatibilidade igual ou posterior a `2026-02-24`, para apagar também o alarme.

## Ferramenta `roomctl`

O CLI deve aceitar `--base-url` e ler tokens por argumento ou variável de ambiente. Nunca mostrar o token completo em mensagens de erro.

Comandos necessários:

```text
roomctl create --task task.md --ttl 15m
roomctl status --invite <token>
roomctl read --invite <token> [--after 0]
roomctl wait --invite <token> [--after 0] [--seconds 20]
roomctl send --invite <token> --text "..."
roomctl final --invite <token> --file result.md
roomctl collect --invite <token> --out result.md
roomctl destroy --invite <token>
```

`create` tem saída legível e `--json`. `read` e `wait` devolvem números de mensagem. `collect` descarrega para um ficheiro temporário, valida o SHA-256, move-o para o destino e só então confirma a recolha. Se falhar, mantém a sala. Em `--json`, use apenas `stdout`; diagnósticos vão para `stderr` e erros têm código de saída não-zero.

## Expiração e apagamento

Na criação, agende um alarme para `expires_at`. Quando correr, confirme que a sala ainda existe e chame `deleteAll()`. `collect` e `destroy` fazem a mesma limpeza de imediato. Todos estes caminhos devem ser repetíveis: uma segunda tentativa recebe `410`, sem voltar a criar dados.

Não guarde transcrições, métricas com conteúdo ou cópias de segurança. Os logs podem conter estado HTTP, duração e identificador irreversível da sala.

Implemente pela ordem natural: sala e autenticação, mensagens, resultado e limpeza, CLI, testes e publicação. Perante uma escolha não especificada, prefira a solução mais pequena que mantenha o percurso principal e registe a decisão brevemente.

## Referências técnicas

- Durable Objects: <https://developers.cloudflare.com/durable-objects/>
- Armazenamento SQLite: <https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/>
- Alarmes: <https://developers.cloudflare.com/durable-objects/api/alarms/>
- Testes com Vitest: <https://developers.cloudflare.com/workers/testing/vitest-integration/>
- Preços atuais: <https://developers.cloudflare.com/durable-objects/platform/pricing/>
