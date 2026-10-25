// Verifica a integridade de data/: cadeia de hashes do histórico + hash e existência de cada arquivo bruto.
// Uso: node verificar.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA = path.join(__dirname, 'data');
const sha256 = t => crypto.createHash('sha256').update(t).digest('hex');
const linhas = fs.readFileSync(path.join(DATA, 'historico.jsonl'), 'utf8').split('\n').filter(Boolean);

let erros = 0, esperado = null, comHash = 0;
linhas.forEach((l, i) => {
  const s = JSON.parse(l);
  if ('hash_anterior' in s) {
    comHash++;
    if (esperado !== null && s.hash_anterior !== esperado) { erros++; console.log(`linha ${i + 1}: cadeia quebrada (linha anterior alterada ou removida)`); }
    const f = path.join(DATA, s.raw_arquivo);
    if (!fs.existsSync(f)) { erros++; console.log(`linha ${i + 1}: arquivo bruto ausente ${s.raw_arquivo}`); }
    else if (sha256(fs.readFileSync(f, 'utf8')) !== s.raw_sha256) { erros++; console.log(`linha ${i + 1}: arquivo bruto alterado ${s.raw_arquivo}`); }
  }
  esperado = sha256(l);
});
console.log(`${linhas.length} linhas (${linhas.length - comHash} legadas sem hash), ${erros} problema(s).`);
process.exit(erros ? 1 : 0);
