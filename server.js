// Servidor local sem dependências: serve o site e faz proxy /api/* -> TSE (evita CORS).
const http = require('http');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const PORT = process.env.PORT || 8080;
const TSE = 'https://resultados.tse.jus.br/oficial/ele2026/6258/dados/';
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

// ---- Coletor: grava cada atualização do TSE em data/historico.jsonl (1 JSON por linha) ----
const DATA_DIR = path.join(__dirname, 'data');
const HISTORICO = path.join(DATA_DIR, 'historico.jsonl');
const UFS = 'ac al ap am ba ce df es go ma mt ms mg pa pb pr pe pi rj rn rs ro rr sc sp se to zz'.split(' '); // zz = exterior
const num = s => parseFloat(String(s ?? '0').replace(',', '.')) || 0;

function buscar(uf) {
  return new Promise((resolve, reject) => {
    https.get(`${TSE}${uf}/${uf}-c0001-e006258-u.json`, { headers: { 'User-Agent': 'Mozilla/5.0' } }, up => {
      let body = '';
      up.on('data', d => body += d);
      up.on('end', () => up.statusCode === 200 ? resolve({ texto: body, json: JSON.parse(body) }) : reject(new Error(`${uf} HTTP ${up.statusCode}`)));
    }).on('error', reject);
  });
}

function resumir(j) {
  const cand = [];
  (j.carg?.[0]?.agr || []).forEach(a => (a.par || []).forEach(p => (p.cand || []).forEach(c => cand.push(c))));
  const L = cand.find(c => c.n === '13'), F = cand.find(c => c.n === '22'), v = j.v || {};
  return {
    lula_pct: num(L?.pvapn), flavio_pct: num(F?.pvapn),
    lula_votos: +(L?.vap || 0), flavio_votos: +(F?.vap || 0),
    secoes_apuradas_pct: num(j.s?.pstn),
    votos_validos: +(v.vvc || 0), brancos: +(v.vb || 0), nulos: +(v.tvn || 0),
    tse_hora: j.hg, tse_data: j.dg,
  };
}

// Integridade: nada é sobrescrito. Histórico só recebe append; cada linha guarda o SHA-256 da linha anterior
// (cadeia: qualquer edição/remoção posterior quebra a verificação). Respostas brutas do TSE vão em arquivos
// novos (flag 'wx' = falha se já existir) marcados como somente leitura.
const RAW_DIR = path.join(DATA_DIR, 'raw');
const sha256 = t => crypto.createHash('sha256').update(t).digest('hex');

let ultimaChave = null, ultimoSnap = null, hashAnterior = null;
try {
  const ultima = fs.readFileSync(HISTORICO, 'utf8').split('\n').filter(Boolean).pop();
  if (ultima) { ultimoSnap = JSON.parse(ultima); ultimaChave = chaveDe(ultimoSnap); hashAnterior = sha256(ultima); }
} catch {}
function chaveDe(s) { return `${s.brasil.lula_votos}|${s.brasil.flavio_votos}|${s.brasil.secoes_apuradas_pct}`; }

// ---- Anomalias: inconsistências objetivas nos dados publicados. Indício para auditoria, NÃO prova de fraude. ----
const ANOMALIAS = path.join(DATA_DIR, 'anomalias.jsonl');
function analisar(prev, snap) {
  const out = [];
  const add = (severidade, tipo, local, detalhe) => out.push({ severidade, tipo, local, detalhe });
  const locais = { BR: snap.brasil, ...snap.estados };

  // 1. Consistência interna de cada recorte
  for (const [loc, d] of Object.entries(locais)) {
    const nominais = d.lula_votos + d.flavio_votos;
    if (nominais !== d.votos_validos && d.votos_validos > 0)
      add('alta', 'soma_invalida', loc, `Lula+Flávio=${nominais} ≠ votos válidos=${d.votos_validos}`);
    if (nominais > 0) {
      const esperado = d.lula_votos / nominais * 100;
      if (Math.abs(esperado - d.lula_pct) > 0.05)
        add('media', 'percentual_incoerente', loc, `Lula% publicado=${d.lula_pct} vs calculado=${esperado.toFixed(3)}`);
    }
  }
  // 2. Soma dos estados deve bater com o Brasil
  const somaL = Object.values(snap.estados).reduce((a, e) => a + e.lula_votos, 0);
  const somaF = Object.values(snap.estados).reduce((a, e) => a + e.flavio_votos, 0);
  if (Object.keys(snap.estados).length === UFS.length) {
    if (Math.abs(somaL - snap.brasil.lula_votos) > 5000) add('media', 'soma_estados_vs_brasil', 'BR', `Lula: estados=${somaL} vs Brasil=${snap.brasil.lula_votos}`);
    if (Math.abs(somaF - snap.brasil.flavio_votos) > 5000) add('media', 'soma_estados_vs_brasil', 'BR', `Flávio: estados=${somaF} vs Brasil=${snap.brasil.flavio_votos}`);
  }
  // 3. Comparação com a atualização anterior
  if (prev) {
    const anteriores = { BR: prev.brasil, ...prev.estados };
    for (const [loc, d] of Object.entries(locais)) {
      const p = anteriores[loc]; if (!p) continue;
      if (d.lula_votos < p.lula_votos) add('alta', 'votos_diminuiram', loc, `Lula ${p.lula_votos} → ${d.lula_votos}`);
      if (d.flavio_votos < p.flavio_votos) add('alta', 'votos_diminuiram', loc, `Flávio ${p.flavio_votos} → ${d.flavio_votos}`);
      if (d.secoes_apuradas_pct < p.secoes_apuradas_pct) add('alta', 'apuracao_regrediu', loc, `Seções apuradas ${p.secoes_apuradas_pct}% → ${d.secoes_apuradas_pct}%`);
      if (d.nulos < p.nulos || d.brancos < p.brancos) add('media', 'brancos_nulos_diminuiram', loc, `nulos ${p.nulos}→${d.nulos}, brancos ${p.brancos}→${d.brancos}`);
      // Salto de percentual com muita apuração já feita (início da apuração oscila naturalmente)
      if (p.secoes_apuradas_pct >= 20 && Math.abs(d.lula_pct - p.lula_pct) > 1)
        add('media', 'salto_percentual', loc, `Lula% ${p.lula_pct} → ${d.lula_pct} com ${p.secoes_apuradas_pct}% apurado`);
      // Lote de votos com perfil muito diferente do acumulado (pode ser só zona urbana/rural)
      const dl = d.lula_votos - p.lula_votos, df = d.flavio_votos - p.flavio_votos, dn = dl + df;
      if (dn >= 20000 && p.secoes_apuradas_pct >= 10) {
        const marginal = dl / dn * 100;
        if (Math.abs(marginal - p.lula_pct) > 25)
          add('baixa', 'lote_atipico', loc, `+${dn} votos com ${marginal.toFixed(1)}% Lula (acumulado era ${p.lula_pct}%)`);
      }
      // Votos novos sem seções novas
      if (dn > 0 && d.secoes_apuradas_pct === p.secoes_apuradas_pct && dn > 5000)
        add('baixa', 'votos_sem_novas_secoes', loc, `+${dn} votos, seções apuradas estáveis em ${d.secoes_apuradas_pct}%`);
    }
  }
  return out;
}

async function coletar() {
  try {
    const res = await Promise.allSettled(['br', ...UFS].map(buscar));
    if (res[0].status !== 'fulfilled') throw res[0].reason;
    const estados = {};
    const brutos = { br: res[0].value.texto }, falhas = {};
    res.slice(1).forEach((r, i) => {
      const uf = UFS[i];
      if (r.status === 'fulfilled') { estados[uf.toUpperCase()] = resumir(r.value.json); brutos[uf] = r.value.texto; }
      else falhas[uf] = r.reason.message;
    });
    const snap = { coletado_em: new Date().toISOString(), brasil: resumir(res[0].value.json), estados };
    const chave = chaveDe(snap);
    if (chave === ultimaChave) return; // TSE ainda não publicou nada novo
    fs.mkdirSync(RAW_DIR, { recursive: true });
    // 1) respostas originais do TSE, byte a byte, num arquivo novo e imutável
    const rawNome = snap.coletado_em.replace(/[:.]/g, '-') + '.json';
    const rawTexto = JSON.stringify({ coletado_em: snap.coletado_em, falhas, arquivos: brutos });
    fs.writeFileSync(path.join(RAW_DIR, rawNome), rawTexto, { flag: 'wx', mode: 0o444 });
    snap.raw_arquivo = `raw/${rawNome}`;
    snap.raw_sha256 = sha256(rawTexto);
    snap.hash_anterior = hashAnterior;
    if (Object.keys(falhas).length) snap.falhas = falhas;
    ultimaChave = chave;
    const achados = analisar(ultimoSnap, snap);
    if (achados.length) {
      fs.appendFileSync(ANOMALIAS, JSON.stringify({ coletado_em: snap.coletado_em, tse_hora: snap.brasil.tse_hora, achados }) + '\n');
      console.log(`  ⚠ ${achados.length} anomalia(s): ${achados.filter(a => a.severidade === 'alta').length} alta(s) — ver data/anomalias.jsonl`);
    }
    ultimoSnap = snap;
    const linha = JSON.stringify(snap);
    fs.appendFileSync(HISTORICO, linha + '\n');
    hashAnterior = sha256(linha);
    console.log(`[${snap.coletado_em}] salvo: Lula ${snap.brasil.lula_pct}% x Flávio ${snap.brasil.flavio_pct}% (${snap.brasil.secoes_apuradas_pct}% apurado)`);
  } catch (e) { console.error('coleta falhou:', e.message); }
}
coletar();
setInterval(coletar, 30000);

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/historico' || url.pathname === '/anomalias') { // atualizações salvas / anomalias, como array JSON
    let linhas = [];
    try { linhas = fs.readFileSync(url.pathname === '/historico' ? HISTORICO : ANOMALIAS, 'utf8').split('\n').filter(Boolean).map(JSON.parse); } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(linhas));
  }

  if (url.pathname.startsWith('/api/')) {
    const rel = url.pathname.slice(5);
    if (!/^[a-z]{2}\/[a-z]{2}-c0001-e006258-u\.json$/.test(rel)) { res.writeHead(400); return res.end('bad path'); }
    https.get(TSE + rel, { headers: { 'User-Agent': 'Mozilla/5.0' } }, up => {
      res.writeHead(up.statusCode, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      up.pipe(res);
    }).on('error', () => { res.writeHead(502); res.end('upstream error'); });
    return;
  }

  if (url.pathname !== '/' && url.pathname !== '/index.html') { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': MIME['.html'] });
  fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
}).listen(PORT, () => console.log(`Apuração 2026 rodando em http://localhost:${PORT}`));
