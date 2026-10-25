# Apurações — 2º turno 2026, Presidente

Painel ao vivo (Lula × Flávio Bolsonaro, Brasil, estados e exterior) com dados do TSE, atualizado a cada 30 s.

## Arquivos
- `index.html` — o site (estático). Busca os JSONs do TSE direto do navegador.
- `server.js` — servidor local: serve o site, faz proxy `/api/*` e **coleta** cada atualização em `data/`.
- `verificar.js` — confere a integridade de `data/` (`node verificar.js`).
- `data/` — histórico só-acréscimo (`historico.jsonl`, encadeado por SHA-256), respostas brutas do TSE (`raw/`) e `anomalias.jsonl`.

## Rodar local (coleta + site)
```
node server.js   # http://localhost:8080
```

## Vercel
Só o `index.html` funciona na Vercel (site estático). O coletor (`server.js`) precisa de um processo
contínuo com disco, então **não roda na Vercel**: rode-o localmente ou em uma VM/VPS.
