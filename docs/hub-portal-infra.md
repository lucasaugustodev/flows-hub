# Flows Hub / Pageflows do Hub Portal

Este documento descreve a instancia Pageflows usada pelo Hub Portal para
validacoes E2E reais.

## Repositorio correto

O codigo/fork usado pelo Hub Portal esta no GitHub em:

```text
lucasaugustodev/flows-hub
```

Branch operacional:

```text
feature/hub-fork-v0.1
```

Evidencia de producao em 2026-06-12:

- a VM roda `APP_VERSION=232cb6dac019e5d60c97e031e339468bd07b9f00`;
- esse SHA existe em `lucasaugustodev/flows-hub`;
- o mesmo SHA nao existe em `lucasaugustodev/pageflows` nem em
  `lucasaugustodev/pageflows-hub`.

Repositorios relacionados, mas com papeis diferentes:

| Repositorio | Papel |
|---|---|
| `lucasaugustodev/flows-hub` | fork/codigo usado pelo Hub Portal |
| `lucasaugustodev/pageflows` | projeto base/original |
| `lucasaugustodev/pageflows-hub` | backup historico de flows e vars |

## Infra de producao

| Campo | Valor |
|---|---|
| URL publica | `https://testes.somosahub.us` |
| Host Tailscale | `hub-tester` |
| Tailnet IP | `100.114.196.58` |
| Path da app | `/opt/flows-hub` |
| Processo | PM2 `flows-hub` |
| Script | `/opt/flows-hub/src/server.js` |
| Porta interna | `4000` |
| Proxy | Nginx `testes.somosahub.us` -> `http://127.0.0.1:4000` |
| Logs stdout | `/var/log/flows-hub/out.log` |
| Logs erro | `/var/log/flows-hub/error.log` |

Acesso operacional:

```bash
tailscale ssh root@hub-tester
```

Comandos uteis na VM:

```bash
pm2 status
pm2 describe flows-hub
pm2 logs flows-hub --lines 200
sudo nginx -T | grep -n "testes.somosahub.us"
```

## Storage

O banco SQLite ativo da instancia fica no diretorio da aplicacao:

```text
/opt/flows-hub/data/pageflows.db
```

Em 2026-06-12 esse banco continha:

- projeto `hub-v2`;
- 28 flows;
- historico de runs reais.

Artefatos de runs e screenshots tambem existem em:

```text
/var/lib/flows-hub/runs
```

Observacao: existe tambem `/var/lib/flows-hub/pageflows.db`, mas ele nao era o
banco com o historico operacional recente na conferencia de 2026-06-12.

## Como o Portal aciona os flows

O repositorio do frontend do Portal (`reuter1987/hub-portal-v2`) contem o
cliente que dispara os Pageflows:

```text
scripts/run-flows-hub.mjs
```

Script npm:

```bash
npm run flows:e2e
```

Exemplo de execucao:

```bash
FLOWS_HUB_BASE_URL=https://testes.somosahub.us \
FLOWS_HUB_PROJECT=hub-v2 \
FLOWS_HUB_TOKEN=<token> \
npm run flows:e2e -- --portal-base https://testeportal.somosahub.us --flows validated
```

O script chama:

```text
POST /api/flows/:flowId/replay
```

Headers usados:

- `Authorization: Bearer <token>`;
- `X-API-Key: <token>`;
- `X-Project: hub-v2`.

Variaveis enviadas para o flow:

- `PORTAL_BASE`;
- `CI_BRANCH`;
- `CI_SHA`;
- `CI_RUN_ID`;
- `CI_RUN_ATTEMPT`.

## GitHub Actions

No frontend do Portal existe um workflow manual:

```text
.github/workflows/pageflows.yml
```

Ele permite rodar Pageflows contra:

- `dev` -> `https://testeportal.somosahub.us`;
- `production` -> `https://portal.somosahub.com.br`;
- `custom` -> URL informada manualmente.

O deploy automatico do frontend ja teve Pageflows como gate, mas esse step foi
removido em:

```text
eab2482 ci(front): remover pageflows de cobranca do deploy
```

Estado em 2026-06-12:

- deploy do frontend nao roda Pageflows automaticamente;
- Pageflows rodam via workflow manual `Pageflows` ou por chamada local ao
  `scripts/run-flows-hub.mjs`.

## Flows mutativos

Alguns flows geram cobrancas ou alteram estado financeiro real/sandbox. O
cliente do Portal bloqueia esses flows por padrao.

Para uma execucao manual controlada pode ser necessario liberar:

```bash
ALLOW_BILLING_MUTATING_FLOWS=true
```

Para producao, ha uma protecao adicional:

```bash
ALLOW_PRODUCTION_BILLING_MUTATING_FLOWS=true
```

Essas flags so devem ser usadas com aprovacao explicita, porque flows de Pix,
boleto, cartao, HubCash ou recorrencia podem criar cobrancas em provedores.

## Operacao do servidor

Health publico:

```bash
curl https://testes.somosahub.us/health
```

Interface:

```text
https://testes.somosahub.us/app/
```

Runs publicos:

```text
https://testes.somosahub.us/runs/<run_id>
```

O servidor usa Express + Playwright. O fluxo de replay:

1. recebe `POST /api/flows/:id/replay`;
2. carrega o flow do SQLite;
3. resolve variaveis dinamicas;
4. executa a sequencia de steps com Playwright;
5. grava status, eventos, screenshots e resultado;
6. retorna `status` e `runUrl`.

## Pontos de atencao

1. A instalacao ativa em `/opt/flows-hub` nao esta como checkout Git. Nao ha
   `.git` no diretorio. Para atualizar com seguranca, alinhar antes a estrategia
   de deploy da app.
2. A branch operacional do repo e `feature/hub-fork-v0.1`, nao `main`.
3. Existe cron antigo apontando para `/opt/pageflows-hub`, enquanto a app ativa
   esta em `/opt/flows-hub`. Antes de confiar em backup automatico, validar e
   corrigir esse cron.
4. Nao registrar tokens, service role keys, JWT secrets ou credenciais de
   projeto em documentacao ou commits.

