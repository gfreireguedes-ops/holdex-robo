/* ============================================================
   ROBÔ MTRIX — Holdex (v2 — sincronizado com o Cockpit v29)
   Gera os 7 arquivos de sellout (somente produtos Softys/Elite)
   a partir do Conta Azul e grava em ./saida/ (latin-1 + CRLF).
   Roda no GitHub Actions; o envio por e-mail é feito no workflow.

   CORREÇÕES nesta versão (vs. script anterior):
   1) Filtro "bug do orçamento": exclui orçamento/cancelado/rascunho,
      igual ao ehVendaReal() do Cockpit — CRÍTICO (evita inflar sellout).
   2) Segmentação de clientes (tipo_loja): busca real da tabela
      cliente_segmento no Supabase, com normalização tolerante.
   3) Comodato: detecta também por CFOP (5908/5909/6908/6909),
      não só pelo texto da natureza da operação.
   4) Força de Vendas: usa o vendedor real da venda mais recente
      de cada cliente (fallback: gerente), não mais nome fixo.
   5) tipo_investimento: padrão agora é "1" (igual ao Cockpit).
      Ajustável via MTX_INVESTIMENTO se precisar.
   6) Notas fiscais (comodato): busca fatiada em janelas de 15 dias
      com retry, para não truncar em períodos maiores.
   7) Vendas: paginação completa (não trava mais em 1000 registros).

   Variáveis de ambiente (GitHub Secrets):
     CA_CLIENT_ID, CA_CLIENT_SECRET, CA_REFRESH_TOKEN
   Opcionais (com padrão):
     MTX_SIGLA=MTRIX  CNPJ_FAB=44145845000221  CNPJ_HOLDEX=24525054000139
     MTX_VENDEDOR=VEND01  MTX_GERENTE=GABRIEL  MTX_INVESTIMENTO=1
     MTX_COMODATO_REGEX=DISPENSER|SABONETEIRA
     DATA_INICIO / DATA_FIM (YYYY-MM-DD) — padrão: ontem
   ============================================================ */
const fs = require('fs');

// ---------- config ----------
const CLIENT_ID = process.env.CA_CLIENT_ID;
const CLIENT_SECRET = process.env.CA_CLIENT_SECRET;
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;   // service_role (lê e grava o token, e lê segmentação)
const SIGLA = (process.env.MTX_SIGLA || 'MTRIX').toUpperCase();
const CNPJ_FAB = (process.env.CNPJ_FAB || '44145845000221').replace(/\D/g, '');
const CNPJ_HOLDEX = (process.env.CNPJ_HOLDEX || '24525054000139').replace(/\D/g, '');
const VENDEDOR = process.env.MTX_VENDEDOR || 'VEND01';
const GERENTE = process.env.MTX_GERENTE || 'GABRIEL';
const INVEST = process.env.MTX_INVESTIMENTO || '1';   // igual ao padrão do Cockpit (c.inv:'1')
const PREFIXO_SOFTYS = '789606197';                 // GS1 da Softys (EAN/DUN)
const RX_DISPENSER = new RegExp((process.env.MTX_COMODATO_REGEX || 'DISPENSER|SABONETEIRA'), 'i');
const RX_CFOP_COMODATO = /^(5908|5909|6908|6909)$/;

function ontem() {
  const d = new Date(); d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}
function normData(s) {
  s = String(s || '').trim();
  let m;
  if (m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)) return m[3] + '-' + m[2] + '-' + m[1]; // DD/MM/AAAA -> AAAA-MM-DD
  return s; // já em AAAA-MM-DD (ou vazio)
}
const DATA_INICIO = normData(process.env.DATA_INICIO) || ontem();
const DATA_FIM = normData(process.env.DATA_FIM) || DATA_INICIO;

if (!CLIENT_ID || !CLIENT_SECRET || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Faltam secrets: CA_CLIENT_ID / CA_CLIENT_SECRET / SUPABASE_URL / SUPABASE_SERVICE_KEY');
  process.exit(1);
}

// ---------- token no Supabase (lê o atual, grava o novo a cada renovação) ----------
async function sbGetRefresh() {
  const url = `${SUPABASE_URL}/rest/v1/ca_auth?id=eq.1&select=refresh_token`;
  const r = await fetch(url, {
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }
  });
  const txt = await r.text();
  if (!r.ok) {
    console.error('DIAGNÓSTICO leitura Supabase -> HTTP ' + r.status + ' | resposta: ' + txt.slice(0, 300));
    console.error('URL usada: ' + SUPABASE_URL + '/rest/v1/ca_auth | chave começa com: ' + String(SUPABASE_KEY).slice(0, 12) + '...');
  }
  let d; try { d = JSON.parse(txt); } catch (e) { d = []; }
  return (Array.isArray(d) && d[0]) ? d[0].refresh_token : '';
}
async function sbSetRefresh(token) {
  await fetch(`${SUPABASE_URL}/rest/v1/ca_auth?id=eq.1`, {
    method: 'PATCH',
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ refresh_token: token, updated_at: new Date().toISOString() })
  });
}

// ---------- segmentação de clientes (Tipo de Loja / Mtrix) — igual ao segCarregar()/mxSeg() do Cockpit ----------
async function sbCarregarSegmap() {
  const segmap = {};
  try {
    const url = `${SUPABASE_URL}/rest/v1/cliente_segmento?select=cliente,segmento`;
    const r = await fetch(url, { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY } });
    const data = await r.json().catch(() => []);
    (Array.isArray(data) ? data : []).forEach(row => { segmap[row.cliente] = row.segmento; });
  } catch (e) {
    console.error('Aviso: falha ao carregar cliente_segmento do Supabase — seguindo com GERAL. ' + e.message);
  }
  return segmap;
}
function segNorm(s) {
  return String(s || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(LTDA|ME|EPP|EIRELI|S\/?A|SA|SOCIEDADE|COND|CONDOMINIO)\b/g, '')
    .replace(/[^A-Z0-9]/g, '').trim();
}
function mxSeg(SEGMAP, nome) {
  if (SEGMAP[nome]) return String(SEGMAP[nome]).slice(0, 10);
  const alvo = segNorm(nome);
  if (alvo) { for (const k in SEGMAP) { if (segNorm(k) === alvo) return String(SEGMAP[k]).slice(0, 10); } }
  return 'GERAL';
}

// ---------- auth ----------
let TOKEN = '';
async function renovarToken() {
  const refresh = await sbGetRefresh();
  if (!refresh) throw new Error('Sem refresh token no Supabase (tabela ca_auth, id=1). Faça a semeadura conforme o README.');
  const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const body = `grant_type=refresh_token&refresh_token=${encodeURIComponent(refresh)}`;
  const r = await fetch('https://auth.contaazul.com/oauth2/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const d = await r.json().catch(() => ({}));
  if (!d.access_token) throw new Error('Falha ao renovar token Conta Azul: ' + JSON.stringify(d));
  TOKEN = d.access_token;
  // Conta Azul rotaciona o refresh: se veio um novo, guarda no Supabase para o próximo dia.
  if (d.refresh_token && d.refresh_token !== refresh) await sbSetRefresh(d.refresh_token);
}

async function get(path) {
  const r = await fetch('https://api-v2.contaazul.com/v1' + path, {
    headers: { 'Authorization': 'Bearer ' + TOKEN }
  });
  const txt = await r.text();
  try { return JSON.parse(txt); } catch (e) { return txt; }   // NF-e volta como XML (string)
}
function items(res) {
  if (!res || res.error) return [];
  if (Array.isArray(res)) return res;
  for (const k of ['itens', 'items', 'data', 'content', 'results']) if (Array.isArray(res[k])) return res[k];
  return [];
}

// ---------- filtro "bug do orçamento" — idêntico ao ehVendaReal() do Cockpit ----------
function ehVendaReal(v) {
  const s = ((v.situacao && (v.situacao.nome || v.situacao)) || '').toString().toUpperCase().trim();
  if (!s) return true;                                          // sem situação: mantém
  if (s === 'ORCAMENTO_ACEITO' || s === 'ORÇAMENTO_ACEITO') return true;   // já é venda fechada
  if (s === 'ORCAMENTO' || s === 'ORÇAMENTO') return false;      // proposta, não conta
  if (s.includes('CANCEL') || s.includes('RASCUNHO') || s.includes('ANDAMENTO')) return false;
  return true;                                                   // APROVADO, FATURADO, demais -> conta
}

// ---------- extrai nome do vendedor de uma venda (igual extrairVendedor() do Cockpit) ----------
function extrairVendedor(det) {
  if (!det || typeof det !== 'object') return '';
  const cands = [det.vendedor, det.negociante, det.seller, det.responsavel, det.vendedor_responsavel, det.consultor];
  for (const c of cands) {
    if (!c) continue;
    if (typeof c === 'string') return c;
    if (typeof c === 'object' && (c.nome || c.name)) return c.nome || c.name;
  }
  for (const k of ['nome_vendedor', 'vendedor_nome', 'nomeVendedor']) {
    if (typeof det[k] === 'string' && det[k]) return det[k];
  }
  return '';
}

// ---------- motor Mtrix (idêntico ao validado) ----------
const MX = (function () {
  function sdg(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }
  function fold(s) { return String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7E]/g, ' '); }
  function fA(v, t) { return fold(v).slice(0, t).padEnd(t, ' '); }
  function fN(v, t) { let s = sdg(v); if (s.length > t) s = s.slice(-t); return s.padStart(t, '0'); }
  function fD(v) { if (!v) return '00000000'; if (v instanceof Date) return v.getFullYear().toString().padStart(4, '0') + (v.getMonth() + 1).toString().padStart(2, '0') + v.getDate().toString().padStart(2, '0'); let s = String(v).trim().slice(0, 10), m; if (m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)) return m[1] + m[2] + m[3]; if (m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/)) return m[3] + m[2] + m[1]; let d = sdg(s); if (d.length >= 8) return d.slice(0, 8); return '00000000'; }
  function fAM(v) { return v ? fD(v).slice(0, 6) : '000000'; }
  function fDec(v, iL, dL, sep) { sep = sep === undefined ? '.' : sep; if (v === null || v === undefined || v === '') v = 0; const neg = Number(v) < 0, f = Math.pow(10, dL); let tot = Math.round(Math.abs(Number(v)) * f), int = Math.floor(tot / f), fr = tot - int * f, pi = String(int); if (neg) pi = '-' + pi.replace(/^0+/, '').padStart(iL - 1, '0'); pi = pi.padStart(iL, '0'); if (pi.length > iL) pi = pi.slice(-iL); return dL === 0 ? pi : pi + sep + String(fr).padStart(dL, '0'); }
  function fCEP(v) { let d = sdg(v).padStart(8, '0').slice(0, 8); return d.slice(0, 5) + '-' + d.slice(5); }
  const A = t => ['A', t, v => fA(v, t)], N = t => ['N', t, v => fN(v, t)], DEC = (i, d, s) => ['DEC', i + (s === undefined ? 1 : s.length) + d, v => fDec(v, i, d, s)], DT = () => ['D', 8, v => fD(v)], AM = () => ['AM', 6, v => fAM(v)], CEP = () => ['CEP', 9, v => fCEP(v)];
  const L = {
    VENDAS_H: [['tipo', A(1)], ['identificador', A(7)], ['cnpj_fornecedor', A(14)]],
    VENDAS_D: [['tipo', A(1)], ['cnpj_agente', A(14)], ['ident_cliente', A(18)], ['data_transacao', DT()], ['num_documento', A(20)], ['cod_produto', A(14)], ['quantidade', DEC(15, 4)], ['preco_venda', DEC(5, 2)], ['cod_vendedor', A(20)], ['reservado1', A(10)], ['tipo_doc', A(1)], ['cep', CEP()], ['cod_lote', A(13)], ['validade_lote', AM()], ['dia_validade', N(2)], ['pedido_sugerido', A(1)], ['preco_venda_usd', DEC(5, 2)], ['tipo_unidade', N(4)]],
    ESTOQUE_H: [['tipo', A(1)], ['identificador', A(7)], ['cnpj_fornecedor', A(14)], ['data_estoque', DT()]],
    ESTOQUE_E: [['tipo', A(1)], ['cnpj_agente', A(14)], ['cod_produto', A(14)], ['qtd_estoque', DEC(15, 4)], ['cod_lote', A(20)], ['validade_lote', DT()], ['tipo_unidade', N(4)]],
    CLIENTES_H: [['tipo', A(1)], ['identificador', A(7)], ['cnpj_fornecedor', A(14)]],
    CLIENTES_D: [['tipo', A(1)], ['cnpj_agente', A(14)], ['ident_cliente', A(18)], ['razao_social', A(40)], ['endereco', A(40)], ['bairro', A(30)], ['cep', CEP()], ['cidade', A(30)], ['estado', A(30)], ['responsavel', A(20)], ['telefones', A(40)], ['cnpj_cpf', A(18)], ['rota', A(10)], ['reservado1', A(10)], ['tipo_loja', A(10)], ['representatividade', DEC(3, 2)]],
    FV_H: [['tipo', A(1)], ['identificador', A(7)], ['cnpj_fornecedor', A(14)]],
    FV_D: [['tipo', A(1)], ['cnpj_agente', A(14)], ['ident_cliente', A(18)], ['cod_gerente', A(13)], ['nome_gerente', A(50)], ['cod_supervisor', A(13)], ['nome_supervisor', A(50)], ['cod_vendedor', A(20)], ['nome_vendedor', A(50)]],
    PRODUTOS_H: [['tipo', A(1)], ['identificador', A(10)], ['data_arquivo', DT()]],
    PRODUTOS_I: [['tipo', A(1)], ['cnpj_agente', A(14)]],
    PRODUTOS_V: [['tipo', A(1)], ['cnpj_fornecedor', A(18)], ['razao_social_forn', A(30)], ['cod_produto', A(14)], ['tipo_embalagem', N(1)], ['cod_barras', A(14)], ['tipo_cod_barras', N(1)], ['nome_produto', A(100)], ['divisao_produto', A(40)], ['reservado1', A(30)], ['status', A(1)], ['reservado2', A(27)]],
    COMODATO_H: [['tipo', A(1)], ['identificador', A(10)], ['cnpj_fornecedor', A(14)]],
    COMODATO_D: [['tipo', A(1)], ['cnpj_agente', A(14)], ['ident_cliente', A(18)], ['cnpj_intermediario', A(18)], ['data_transacao', DT()], ['num_documento', A(20)], ['cod_produto', A(14)], ['quantidade', DEC(15, 4)], ['preco_venda', DEC(5, 2)], ['cod_promotor', A(20)], ['tipo_doc', A(1)], ['cep', CEP()], ['data_fim_contrato', DT()], ['tipo_investimento', A(1)], ['cod_vendedor', A(20)], ['tipo_transacao', A(2)], ['cod_patrimonio', A(20)]],
    ESTOQUE_COM_H: [['tipo', A(1)], ['identificador', A(7)], ['cnpj_fornecedor', A(14)], ['data_estoque', DT()]],
    ESTOQUE_COM_E: [['tipo', A(1)], ['cnpj_agente', A(14)], ['cod_produto', A(14)], ['qtd_estoque', N(8)], ['tipo_transacao', A(1)], ['cod_patrimonio', A(20)]],
  };
  const T = { VENDAS_H: 22, VENDAS_D: 177, ESTOQUE_H: 30, ESTOQUE_E: 81, CLIENTES_H: 22, CLIENTES_D: 326, FV_H: 22, FV_D: 229, PRODUTOS_H: 19, PRODUTOS_I: 15, PRODUTOS_V: 277, COMODATO_H: 25, COMODATO_D: 202, ESTOQUE_COM_H: 30, ESTOQUE_COM_E: 58 };
  function linha(nome, d) { let s = ''; for (const [k, def] of L[nome]) s += def[2](d[k] !== undefined ? d[k] : ''); if (s.length !== T[nome]) throw new Error(nome + ': ' + s.length + '!=' + T[nome]); return s; }
  function nomeArq(pref, dt) { const p = (n, l) => String(n).padStart(l, '0'); const c = p(dt.getDate(), 2) + p(dt.getMonth() + 1, 2) + dt.getFullYear() + p(dt.getHours(), 2) + p(dt.getMinutes(), 2) + p(dt.getSeconds(), 2) + p(dt.getMilliseconds(), 3); return pref + SIGLA + c + '.txt'; }
  return { linha, nomeArq, T, sdg };
})();

const sd = v => String(v == null ? '' : v).replace(/\D/g, '');
const pick = (o, keys, def) => { if (!o) return def; for (const k of keys) { const v = k.split('.').reduce((a, c) => (a == null ? a : a[c]), o); if (v !== undefined && v !== null && v !== '') return v; } return def; };
const leadTok = s => String(s || '').split(' - ')[0].trim();
const ehSoftys = ean => sd(ean).includes(PREFIXO_SOFTYS);

// ---------- parser NF-e (regex, sem dependência) ----------
function tag(xml, t) { const m = xml.match(new RegExp('<' + t + '>([^<]*)</' + t + '>')); return m ? m[1] : ''; }
function parseNFe(xml) {
  if (typeof xml !== 'string') xml = JSON.stringify(xml);
  const ide = (xml.match(/<ide>([\s\S]*?)<\/ide>/) || [, ''])[1];
  const dest = (xml.match(/<dest>([\s\S]*?)<\/dest>/) || [, ''])[1];
  const ender = (dest.match(/<enderDest>([\s\S]*?)<\/enderDest>/) || [, ''])[1];
  const itens = [];
  const dets = xml.match(/<det[\s>][\s\S]*?<\/det>/g) || [];
  dets.forEach(d => {
    const prod = (d.match(/<prod>([\s\S]*?)<\/prod>/) || [, ''])[1];
    if (!prod) return;
    itens.push({ cProd: tag(prod, 'cProd'), cEAN: tag(prod, 'cEAN'), CFOP: tag(prod, 'CFOP'), qCom: Number(tag(prod, 'qCom') || 0) || 0, vUn: Number(tag(prod, 'vUnCom') || 0) || 0 });
  });
  return { natOp: tag(ide, 'natOp'), tpNF: tag(ide, 'tpNF'), nNF: tag(ide, 'nNF'), dhEmi: (tag(ide, 'dhEmi') || '').slice(0, 10), docDest: tag(dest, 'CNPJ') || tag(dest, 'CPF'), cepDest: tag(ender, 'CEP'), itens };
}

// ---------- detalhe de pessoa ----------
async function pessoaDet(id) {
  try {
    const pd = await get('/pessoas/' + id);
    const e = (Array.isArray(pd.enderecos) ? pd.enderecos[0] : {}) || {};
    const log = pick(e, ['logradouro', 'endereco', 'rua'], ''), num = pick(e, ['numero'], '');
    return {
      doc: sd(pick(pd, ['documento', 'cpf_cnpj'], '')),
      razao: pick(pd, ['nome', 'razao_social', 'nome_empresa'], ''),
      endereco: (log + (num ? ', ' + num : '')).trim(),
      bairro: pick(e, ['bairro'], ''), cep: sd(pick(e, ['cep'], '')),
      cidade: pick(e, ['cidade', 'municipio'], ''), estado: pick(e, ['estado', 'uf'], ''),
      responsavel: pick(pd, ['nome_contato', 'contato'], ''),
      telefone: pick(pd, ['telefone_comercial', 'telefone_celular', 'telefone'], '')
    };
  } catch (e) { return { doc: '', razao: '', endereco: '', bairro: '', cep: '', cidade: '', estado: '', responsavel: '', telefone: '' }; }
}

// ---------- notas fiscais fatiadas por período (igual mxBuscarNotasFatiado do Cockpit) ----------
async function buscarNotasFatiado(deStr, ateStr) {
  const todas = []; const vistos = new Set(); const jan = 15;
  let ini = new Date(deStr + 'T12:00:00'); const fim = new Date(ateStr + 'T12:00:00');
  let guarda = 0;
  while (ini <= fim && guarda < 80) {
    guarda++;
    let f = new Date(ini); f.setDate(f.getDate() + jan - 1);
    if (f > fim) f = new Date(fim);
    const d1 = ini.toISOString().split('T')[0], d2 = f.toISOString().split('T')[0];
    for (let pg = 1; pg <= 40; pg++) {
      let r = null;
      for (let tent = 1; tent <= 3; tent++) {
        try { r = await get('/notas-fiscais?data_inicial=' + d1 + '&data_final=' + d2 + '&pagina=' + pg + '&tamanho_pagina=50'); } catch (e) { r = null; }
        if (r && !r.error) break;
        await new Promise(res => setTimeout(res, 300));
      }
      if (!r || r.error) { console.log('[NOTAS] fatia ' + d1 + '..' + d2 + ' pg' + pg + ' falhou'); break; }
      const it = items(r);
      it.forEach(n => { const k = n.chave_acesso || n.chave || n.id || JSON.stringify(n); if (!vistos.has(k)) { vistos.add(k); todas.push(n); } });
      if (it.length < 50) break;
    }
    ini = new Date(f); ini.setDate(ini.getDate() + 1);
  }
  return todas;
}

// ---------- geração ----------
async function gerar() {
  await renovarToken();
  console.log('Período:', DATA_INICIO, 'a', DATA_FIM);
  const dt = new Date();
  const H = ex => Object.assign({ tipo: 'H', cnpj_fornecedor: CNPJ_FAB }, ex);
  const D = o => Object.assign({ tipo: 'D', cnpj_agente: CNPJ_HOLDEX }, o);

  const SEGMAP = await sbCarregarSegmap();
  console.log('Segmentação carregada:', Object.keys(SEGMAP).length, 'clientes');

  // catálogo
  let prods = [], pg = 1;
  for (let i = 0; i < 12; i++) { const r = await get('/produtos?pagina=' + pg + '&tamanho_pagina=500'); const it = items(r); prods = prods.concat(it); if (it.length < 500) break; pg++; }
  const prodByCode = {};
  prods.forEach(p => {
    const rec = { ean: sd(p.ean), codigo: String(p.codigo || ''), nome: p.nome || '', saldo: Number(p.saldo != null ? p.saldo : 0) || 0, status: (p.status === 'INATIVO' ? 'I' : 'A') };
    rec.cod = rec.ean || rec.codigo;
    const pref = leadTok(p.nome); if (pref) prodByCode[pref] = rec;
    if (rec.codigo) { prodByCode[rec.codigo] = rec; prodByCode[rec.codigo.replace(/^0+/, '')] = rec; }
  });
  const resolveProd = it => { const t = leadTok(it.nome); return prodByCode[t] || prodByCode[t.replace(/^0+/, '')] || null; };

  // vendas (sellout) — paginação completa
  let vendasTodas = items(await get('/venda/busca?pagina=1&tamanho_pagina=1000&data_inicio=' + DATA_INICIO + '&data_fim=' + DATA_FIM + '&campo_ordenado_descendente=DATA'));
  if (vendasTodas.length >= 1000) {
    for (let p = 2; p <= 30; p++) {
      const r = await get('/venda/busca?pagina=' + p + '&tamanho_pagina=1000&data_inicio=' + DATA_INICIO + '&data_fim=' + DATA_FIM + '&campo_ordenado_descendente=DATA');
      const it = items(r); vendasTodas = vendasTodas.concat(it); if (it.length < 1000) break;
    }
  }
  const vendas = vendasTodas.filter(ehVendaReal);       // exclui orçamento/cancelado/rascunho
  console.log('[VENDAS] total bruto:', vendasTodas.length, '-> vendas reais:', vendas.length);

  const clienteIds = {}, cache = [], vendedorPorCli = {};
  for (const v of vendas) {
    const cliId = pick(v, ['cliente.id'], ''), cliNome = pick(v, ['cliente.nome'], '');
    if (cliId) clienteIds[cliId] = cliNome;
    const dataV = pick(v, ['data', 'data_venda', 'criado_em'], dt);
    let vend = extrairVendedor(v);
    if (!vend && v.id) { try { const det = await get('/venda/' + v.id); vend = extrairVendedor(det); } catch (e) { } }
    if (cliId && vend) { if (!vendedorPorCli[cliId] || dataV > vendedorPorCli[cliId].data) vendedorPorCli[cliId] = { nome: vend, data: dataV }; }
    let r = {}; try { r = await get('/venda/' + v.id + '/itens?pagina=1&tamanho_pagina=200'); } catch (e) { }
    const linhasItens = [];
    (pick(r, ['itens', 'produtos'], []) || []).forEach(it => {
      if (it.tipo && it.tipo !== 'PRODUTO') return;
      const pr = resolveProd(it); if (!pr) return;
      if (!ehSoftys(pr.ean)) return;                 // SÓ SOFTYS
      if (RX_DISPENSER.test(pr.nome)) return;        // dispenser não é sellout
      linhasItens.push({ cod: pr.cod, qtd: Number(it.quantidade || 0) || 0, preco: Number(it.valor || 0) || 0 });
    });
    if (linhasItens.length) cache.push({ cliId, data: pick(v, ['data', 'criado_em'], dt), num: String(pick(v, ['numero', 'id'], '')), itens: linhasItens });
  }

  // clientes (detalhe)
  const clientesDict = {}, cliInfo = {}, vendedorPorDoc = {}, nomeVendaPorDoc = {};
  for (const id of Object.keys(clienteIds)) {
    const ci = await pessoaDet(id); cliInfo[id] = ci;
    if (ci.doc) {
      clientesDict[ci.doc] = ci;
      if (vendedorPorCli[id]) vendedorPorDoc[ci.doc] = vendedorPorCli[id].nome;
      if (clienteIds[id]) nomeVendaPorDoc[ci.doc] = clienteIds[id];
    }
  }

  // comodato (NFs de remessa) — fatiado + detecção por CFOP ou natOp
  const nfs = await buscarNotasFatiado(DATA_INICIO, DATA_FIM);
  const lnK = [MX.linha('COMODATO_H', H({ identificador: 'COMODATO13' }))];
  let nCom = 0;
  const capNF = Math.min(nfs.length, 250);
  for (let i = 0; i < capNF; i++) {
    const nf = nfs[i];
    const chave = pick(nf, ['chave_acesso', 'chave', 'chave_nfe'], ''); if (!chave) continue;
    let xml; try { xml = await get('/notas-fiscais/' + chave); } catch (e) { continue; }
    let info; try { info = parseNFe(xml); } catch (e) { continue; }
    const ehComodato = (info.itens || []).some(it => RX_CFOP_COMODATO.test(String(it.CFOP || '').trim())) || /comodato/i.test(info.natOp);
    if (!ehComodato) continue;
    const transac = info.tpNF === '0' ? '2' : '1';
    const doc = sd(info.docDest);
    if (doc && !clientesDict[doc]) clientesDict[doc] = { doc, razao: pick(nf, ['nome_destinatario'], ''), endereco: '', bairro: '', cep: sd(info.cepDest), cidade: '', estado: '', responsavel: '', telefone: '' };
    info.itens.forEach(it => {
      if (!ehSoftys(it.cEAN)) return;
      const eanOk = /^\d{13,14}$/.test(it.cEAN);
      lnK.push(MX.linha('COMODATO_D', D({ ident_cliente: doc, cnpj_intermediario: '', data_transacao: info.dhEmi, num_documento: String(info.nNF || pick(nf, ['numero_nota'], '')), cod_produto: eanOk ? it.cEAN : it.cProd, quantidade: it.qCom, preco_venda: it.vUn, cod_promotor: VENDEDOR, tipo_doc: 'C', cep: sd(info.cepDest), data_fim_contrato: '', tipo_investimento: INVEST, cod_vendedor: VENDEDOR, tipo_transacao: transac, cod_patrimonio: '' })));
      nCom++;
    });
  }

  // monta arquivos
  const out = [];
  // VENDAS
  let ln = [MX.linha('VENDAS_H', H({ identificador: 'VENDA11' }))];
  cache.forEach(s => { const ci = cliInfo[s.cliId] || {}; s.itens.forEach(it => { ln.push(MX.linha('VENDAS_D', D({ ident_cliente: ci.doc, data_transacao: s.data, num_documento: s.num, cod_produto: it.cod, quantidade: it.qtd, preco_venda: it.preco, cod_vendedor: VENDEDOR, tipo_doc: 'N', cep: ci.cep, tipo_unidade: '0001' }))); }); });
  out.push(['VENDAS', ln]);
  // CLIENTES (com segmentação real)
  ln = [MX.linha('CLIENTES_H', H({ identificador: 'PDV10' }))];
  Object.keys(clientesDict).forEach(doc => {
    const ci = clientesDict[doc];
    const nomeSeg = nomeVendaPorDoc[doc] || ci.razao;
    ln.push(MX.linha('CLIENTES_D', D({ ident_cliente: ci.doc, razao_social: ci.razao, endereco: ci.endereco, bairro: ci.bairro, cep: ci.cep, cidade: ci.cidade, estado: ci.estado, responsavel: ci.responsavel, telefones: ci.telefone, cnpj_cpf: ci.doc, rota: 'BH', tipo_loja: mxSeg(SEGMAP, nomeSeg) })));
  });
  out.push(['CLIENTES', ln]);
  // PRODUTOS (só Softys)
  ln = [MX.linha('PRODUTOS_H', { tipo: 'H', identificador: 'CADPROD', data_arquivo: dt }), MX.linha('PRODUTOS_I', { tipo: 'I', cnpj_agente: CNPJ_HOLDEX })];
  prods.forEach(p => { const ean = sd(p.ean); if (!ehSoftys(ean)) return; const tcb = ean.length === 13 ? '1' : ean.length === 14 ? '2' : '3'; ln.push(MX.linha('PRODUTOS_V', { tipo: 'V', cnpj_fornecedor: CNPJ_FAB, razao_social_forn: 'SOFTYS BRASIL', cod_produto: String(p.codigo || ''), tipo_embalagem: '0', cod_barras: ean, tipo_cod_barras: tcb, nome_produto: p.nome || '', divisao_produto: 'HOLDEX', status: (p.status === 'INATIVO' ? 'I' : 'A') })); });
  out.push(['PRODUTOS', ln]);
  // ESTOQUE (Softys, não-dispenser) + ESTOQUE COMODATO (Softys dispensers)
  ln = [MX.linha('ESTOQUE_H', H({ identificador: 'ESTOQ11', data_estoque: dt }))];
  let lnEC = [MX.linha('ESTOQUE_COM_H', H({ identificador: 'ESTOQ12', data_estoque: dt }))];
  prods.forEach(p => {
    const ean = sd(p.ean); if (!ehSoftys(ean)) return;
    const cod = ean || String(p.codigo || '');
    const q = Math.max(0, Number(p.saldo != null ? p.saldo : 0) || 0);
    if (RX_DISPENSER.test(p.nome || '')) { lnEC.push(MX.linha('ESTOQUE_COM_E', { tipo: 'E', cnpj_agente: CNPJ_HOLDEX, cod_produto: cod, qtd_estoque: Math.round(q), tipo_transacao: 'C', cod_patrimonio: '' })); }
    else { ln.push(MX.linha('ESTOQUE_E', { tipo: 'E', cnpj_agente: CNPJ_HOLDEX, cod_produto: cod, qtd_estoque: q, tipo_unidade: '0001' })); }
  });
  out.push(['ESTOQUE', ln]);
  // FORÇA DE VENDAS (vendedor real por cliente, fallback gerente)
  ln = [MX.linha('FV_H', H({ identificador: 'FV10' }))];
  Object.keys(clientesDict).forEach(doc => {
    const vendReal = vendedorPorDoc[doc] || GERENTE;
    ln.push(MX.linha('FV_D', D({ ident_cliente: doc, cod_gerente: 'GER01', nome_gerente: GERENTE, cod_supervisor: 'SUP01', nome_supervisor: GERENTE, cod_vendedor: VENDEDOR, nome_vendedor: vendReal })));
  });
  out.push(['FORCAVENDAS', ln]);
  // COMODATO
  out.push(['COMODATO', lnK]);
  // ESTOQUE COMODATO
  out.push(['ESTOQUECOM', lnEC]);

  // grava em latin-1 + CRLF
  fs.mkdirSync('saida', { recursive: true });
  const resumo = [];
  out.forEach(([pref, linhas]) => {
    const nome = MX.nomeArq(pref, dt);
    const texto = linhas.join('\r\n') + '\r\n';
    fs.writeFileSync('saida/' + nome, Buffer.from(texto, 'latin1'));
    resumo.push(`${nome}  (${linhas.length - 1} registros)`);
  });
  console.log('Arquivos gerados:\n  ' + resumo.join('\n  '));
  console.log(`\nResumo: ${cache.length} vendas Softys, ${nCom} itens de comodato, ${Object.keys(clientesDict).length} clientes.`);
}

gerar().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
