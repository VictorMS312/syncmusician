const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');
const cors    = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────────────
//  VARIÁVEIS DE AMBIENTE
//  Configure no Render: Settings → Environment Variables
//  SUPABASE_URL  = https://xxxx.supabase.co
//  SUPABASE_KEY  = sua anon/public key
// ─────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
// Chave secreta para o bot — configure no Render: BOT_SECRET = qualquer string forte
const BOT_SECRET   = process.env.BOT_SECRET || 'syncmusician-bot-secret-2025';

const supa = axios.create({
  baseURL: `${SUPABASE_URL}/rest/v1`,
  headers: {
    'apikey':        SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type':  'application/json',
    'Prefer':        'return=representation',
  },
});

// ─────────────────────────────────────────────────────
//  CACHE — Supabase
//  Tabela: cifras
//  Colunas: id (uuid default), url (text unique), titulo (text),
//           artista (text), genero (text), conteudo (text),
//           acessos (int4 default 0), criado_em (timestamptz default now())
//
//  SQL para adicionar coluna de gênero (rode no Supabase SQL Editor):
//  ALTER TABLE cifras ADD COLUMN IF NOT EXISTS genero text;
//
//  RLS: certifique-se de que SELECT é público para a anon key:
//  CREATE POLICY "public read" ON cifras FOR SELECT USING (true);
//  CREATE POLICY "service write" ON cifras FOR ALL USING (true);
// ─────────────────────────────────────────────────────
async function cacheGet(url) {
  try {
    const r = await supa.get('/cifras', {
      params: { url: `eq.${url}`, select: 'id,url,titulo,artista,genero,conteudo,acessos', limit: 1 },
    });
    if (r.data?.length > 0) {
      const row = r.data[0];
      supa.patch('/cifras',
        { acessos: row.acessos + 1 },
        { params: { id: `eq.${row.id}` }, headers: { 'Prefer': 'return=minimal' } }
      ).catch(() => {});
      return row;
    }
    return null;
  } catch (e) {
    console.error('cacheGet error:', e.response?.data || e.message);
    return null;
  }
}

async function cacheSave({ url, titulo, artista, genero, conteudo }) {
  try {
    await supa.post('/cifras',
      { url, titulo, artista, genero: genero || null, conteudo, acessos: 1 },
      {
        params:  { on_conflict: 'url' },
        headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      }
    );
  } catch (e) {
    console.error('cacheSave error:', e.response?.data || e.message);
  }
}

async function cacheSearch(q) {
  try {
    const query = q.trim();
    if (!query) return [];

    const terms = query.split(/\s+/).filter(Boolean).slice(0, 5);
    // Para queries curtas (1-2 chars), busca prefix; para maiores, usa contains
    const main  = [...terms].sort((a, b) => b.length - a.length)[0];
    const isShort = main.length <= 2;

    // Busca prefix E contains para cobrir os dois casos
    const orFilter = isShort
      ? `(titulo.ilike.${main}%,titulo.ilike.%${main}%,artista.ilike.${main}%)`
      : `(titulo.ilike.%${main}%,artista.ilike.%${main}%)`;

    const r = await supa.get('/cifras', {
      params: {
        or:     orFilter,
        select: 'url,titulo,artista,genero,acessos',
        limit:  50,               // busca mais para compensar filtro local
        order:  'acessos.desc',
      },
    });

    if (!r.data?.length) return [];

    // Filtra pelos outros termos localmente
    const others = terms.filter(t => t !== main);
    const filtered = r.data.filter(row => {
      const text = `${row.titulo} ${row.artista}`.toLowerCase();
      return others.every(t => text.includes(t.toLowerCase()));
    });

    // Ordena: começa com o termo > contém o termo
    filtered.sort((a, b) => {
      const aStarts = a.titulo.toLowerCase().startsWith(query.toLowerCase()) ? 0 : 1;
      const bStarts = b.titulo.toLowerCase().startsWith(query.toLowerCase()) ? 0 : 1;
      if (aStarts !== bStarts) return aStarts - bStarts;
      return b.acessos - a.acessos;
    });

    return filtered;
  } catch (e) {
    console.error('cacheSearch error:', e.response?.data || e.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const SONG_URL_RES = [
  /^https?:\/\/(?:www\.)?cifraclub\.com\.br\/[a-z0-9-]+\/[a-z0-9-]+\/?$/i,
  /^https?:\/\/(?:www\.)?cifras\.com\.br\/cifra\/[a-z0-9-]+-\d+/i,
];

function isSongUrl(url) { return SONG_URL_RES.some(re => re.test(url)); }

function normalizeUrl(url) {
  if (/cifraclub\.com\.br/.test(url) && !url.endsWith('/')) return url + '/';
  return url;
}

function slugToTitle(slug) {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function htmlParaTexto(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<b>([^<]*)<\/b>/gi, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .trim();
}

// ─────────────────────────────────────────────────────
//  SCRAPING
// ─────────────────────────────────────────────────────
async function scrapeCifra(url) {
  const response = await axios.get(url, {
    headers: {
      'User-Agent':      UA,
      'Accept-Language': 'pt-BR,pt;q=0.9',
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    maxRedirects: 5,
    timeout: 12000,
  });

  const $        = cheerio.load(response.data);
  const finalUrl = response.request?.res?.responseUrl || url;
  let cifraHtml  = null, titulo = '', artista = '', genero = '';

  if (/cifraclub\.com/i.test(finalUrl)) {
    cifraHtml = $('pre').first().html();
    titulo    = $('h1.t1').text() || $('h1').first().text();
    artista   = $('h2.t3').text() || $('h2').first().text();
    // Extrai gênero: breadcrumb, meta tag, ou link de categoria
    genero    = $('meta[property="music:genre"]').attr('content')
             || $('a[href*="/estilo/"]').first().text()
             || $('a[href*="/genero/"]').first().text()
             || $('a[href*="/estilo"]').first().text()
             || $('div.genre').first().text()
             || $('span.genre').first().text()
             || '';
    // Tenta pegar do breadcrumb (ex: Gospel > Adoração)
    if (!genero) {
      $('nav a, .breadcrumb a, ol.breadcrumb a').each((_, el) => {
        const text = $(el).text().trim().toLowerCase();
        const known = ['gospel','cristã','sertanejo','mpb','pop','rock','pagode','axé','forró','clássica','infantil'];
        if (known.some(k => text.includes(k))) { genero = text; return false; }
      });
    }
  } else if (/cifras\.com/i.test(finalUrl)) {
    cifraHtml = $('pre').first().html() || $('.cifra-content').first().html();
    titulo    = $('h1').first().text();
    artista   = $('h2').first().text();
    genero    = $('a[href*="estilo"]').first().text() || '';
  } else {
    cifraHtml = $('pre').first().html();
    titulo    = $('h1').first().text();
    artista   = $('h2').first().text();
  }

  if (!cifraHtml) throw new Error('Cifra não encontrada nesta página.');

  return {
    titulo:   titulo.trim(),
    artista:  artista.trim(),
    genero:   genero.trim().toLowerCase() || null,
    conteudo: htmlParaTexto(cifraHtml),
  };
}

// ─────────────────────────────────────────────────────
//  BUSCA VIA DUCKDUCKGO
// ─────────────────────────────────────────────────────
async function searchDDG(query) {
  const siteFilter = 'site:cifraclub.com.br OR site:cifras.com.br';
  const ddgUrl     = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`${query} (${siteFilter})`)}`;

  const response = await axios.get(ddgUrl, {
    headers: {
      'User-Agent':      UA,
      'Accept-Language': 'pt-BR,pt;q=0.9',
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Referer':         'https://duckduckgo.com/',
    },
    timeout: 12000,
  });

  const $       = cheerio.load(response.data);
  const results = [];

  $('.result').each((_, el) => {
    const $el = $(el);
    let href  = $el.find('a.result__url').attr('href')
             || $el.find('.result__title a').attr('href') || '';

    if (href.includes('duckduckgo.com/l/')) {
      try {
        href = decodeURIComponent(new URL('https:' + href).searchParams.get('uddg') || href);
      } catch {}
    }
    if (href && !href.startsWith('http')) href = 'https://' + href;
    href = normalizeUrl(href);
    if (!isSongUrl(href)) return;

    const path  = href.replace(/https?:\/\/[^/]+/, '').replace(/^\/|\/$/g, '');
    const parts = path.split('/').filter(Boolean);
    let title = '', artist = '';

    if (/cifraclub\.com\.br/.test(href) && parts.length >= 2) {
      artist = slugToTitle(parts[0]);
      title  = slugToTitle(parts[1]);
    } else {
      title = slugToTitle(parts[parts.length - 1] || '');
    }

    const visible = $el.find('.result__title').text().trim();
    if (visible) {
      const vp = visible.split(/\s*[-–]\s*/);
      if (vp[0]) title  = vp[0].trim();
      if (vp[1]) artist = vp[1].trim();
    }

    if (!results.find(r => r.url === href)) {
      results.push({ title, artist, url: href });
    }
  });

  return results;
}

// ─────────────────────────────────────────────────────
//  RESOLVE LINKS CURTOS
// ─────────────────────────────────────────────────────
async function resolveUrl(url) {
  try {
    const r = await axios.get(url, {
      headers: { 'User-Agent': UA },
      maxRedirects: 10, timeout: 10000,
      validateStatus: s => s < 400,
    });
    return r.request?.res?.responseUrl || r.request?.responseURL || url;
  } catch { return url; }
}

// ─────────────────────────────────────────────────────
//  ROTAS
// ─────────────────────────────────────────────────────

// GET /search?q=...&page=1
app.get('/search', async (req, res) => {
  const { q, page = 1 } = req.query;
  if (!q) return res.status(400).json({ error: 'Parâmetro q é obrigatório' });

  const PAGE_SIZE = 8;   // aumentado de 3 para 8
  const pageNum   = Number(page);

  try {
    // 1. Busca no Supabase primeiro
    const cached = await cacheSearch(q);
    const cacheResults = cached.map(r => ({
      title:  r.titulo,
      artist: r.artista,
      url:    r.url,
      genero: r.genero || null,
      source: 'db',
    }));

    const start = (pageNum - 1) * PAGE_SIZE;

    // 2. Se cache satisfaz a página inteira, retorna só ele
    if (cacheResults.length >= start + PAGE_SIZE) {
      return res.json({
        results: cacheResults.slice(start, start + PAGE_SIZE),
        hasMore: cacheResults.length > start + PAGE_SIZE,
        page:    pageNum,
        total:   cacheResults.length,
      });
    }

    // 3. Complementa com DuckDuckGo (só na primeira página ou se cache insuficiente)
    let webResults = [];
    try { webResults = await searchDDG(q); } catch {}

    // Merge sem duplicatas (cache tem prioridade)
    const seen  = new Set(cacheResults.map(r => r.url));
    const merged = [...cacheResults];
    for (const r of webResults) {
      if (!seen.has(r.url)) {
        merged.push({ title: r.title, artist: r.artist, url: r.url, genero: null, source: 'web' });
        seen.add(r.url);
      }
    }

    res.json({
      results: merged.slice(start, start + PAGE_SIZE),
      hasMore: merged.length > start + PAGE_SIZE,
      page:    pageNum,
      total:   merged.length,
    });

  } catch (error) {
    res.status(500).json({ error: 'Erro na busca', details: error.message });
  }
});

// GET /get-cifra?url=...
app.get('/get-cifra', async (req, res) => {
  let { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL é obrigatória' });

  try {
    if (/share\.google|goo\.gl|bit\.ly|tinyurl|ow\.ly|t\.co/i.test(url)) {
      url = await resolveUrl(url);
    }
    url = normalizeUrl(url);

    // 1. Verifica cache
    const hit = await cacheGet(url);
    if (hit) {
      return res.json({
        titulo:  hit.titulo,
        artista: hit.artista,
        genero:  hit.genero || null,
        cifra:   hit.conteudo,
      });
    }

    // 2. Scraping
    const { titulo, artista, genero, conteudo } = await scrapeCifra(url);

    // 3. Salva no cache em background
    cacheSave({ url, titulo, artista, genero, conteudo }).catch(() => {});

    res.json({ titulo, artista, genero: genero || null, cifra: conteudo });

  } catch (error) {
    res.status(error.response?.status || 500).json({
      error:   'Erro ao buscar cifra',
      details: error.message,
    });
  }
});

// ─────────────────────────────────────────────────────
//  BOT ENDPOINT — adiciona/atualiza músicas em massa
//  Autenticação: header x-bot-secret = BOT_SECRET (env)
//
//  Uso no bot:
//    POST https://syncmusician.onrender.com/bot/cifra
//    Headers: { "Content-Type": "application/json", "x-bot-secret": "SEU_SECRET" }
//    Body:    { "url": "...", "titulo": "...", "artista": "...", "genero": "...", "conteudo": "..." }
//
//  Também aceita array para inserção em lote:
//    Body: [ { url, titulo, artista, genero, conteudo }, ... ]
// ─────────────────────────────────────────────────────
function botAuth(req, res, next) {
  const secret = req.headers['x-bot-secret'];
  if (!secret || secret !== BOT_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.post('/bot/cifra', botAuth, async (req, res) => {
  const items = Array.isArray(req.body) ? req.body : [req.body];
  if (!items.length) return res.status(400).json({ error: 'Body vazio' });

  const errors = [], saved = [];

  for (const item of items) {
    const { url, titulo, artista, genero, conteudo } = item;
    if (!url || !conteudo) {
      errors.push({ url, error: 'url e conteudo são obrigatórios' });
      continue;
    }
    try {
      await supa.post('/cifras',
        { url: normalizeUrl(url), titulo: titulo || '', artista: artista || '', genero: genero || null, conteudo, acessos: 0 },
        {
          params:  { on_conflict: 'url' },
          headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        }
      );
      saved.push(url);
    } catch (e) {
      errors.push({ url, error: e.response?.data || e.message });
    }
  }

  res.json({ saved: saved.length, errors: errors.length, details: errors });
});

// GET /cifras/count — quantas músicas no banco (útil para debug)
app.get('/cifras/count', async (req, res) => {
  try {
    const r = await supa.get('/cifras', {
      params: { select: 'id' },
      headers: { 'Prefer': 'count=exact' },
    });
    const count = parseInt(r.headers['content-range']?.split('/')[1] || '0');
    res.json({ count });
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// ─────────────────────────────────────────────────────
//  HEALTH CHECK — testa conexão com Supabase
// ─────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    const r = await supa.get('/cifras', {
      params: { select: 'id' },
      headers: { 'Prefer': 'count=exact' },
    });
    const count = parseInt(r.headers['content-range']?.split('/')[1] || r.data?.length || 0);
    res.json({
      status:   'ok',
      supabase: 'connected',
      cifras:   count,
      env: {
        supabase_url: SUPABASE_URL ? 'set' : 'MISSING',
        supabase_key: SUPABASE_KEY ? 'set' : 'MISSING',
        bot_secret:   BOT_SECRET   ? 'set' : 'MISSING',
      },
    });
  } catch (e) {
    res.status(500).json({
      status:   'error',
      supabase: 'failed',
      detail:   e.response?.data || e.message,
      env: {
        supabase_url: SUPABASE_URL ? 'set' : 'MISSING',
        supabase_key: SUPABASE_KEY ? 'set' : 'MISSING',
        bot_secret:   BOT_SECRET   ? 'set' : 'MISSING',
      },
    });
  }
});

// ─────────────────────────────────────────────────────
//  VOTAÇÃO DE TOM ORIGINAL
//  Tabela Supabase: tone_votes
//  SQL: CREATE TABLE tone_votes (
//         url   text NOT NULL,
//         tone  text NOT NULL,
//         votes integer NOT NULL DEFAULT 1,
//         PRIMARY KEY (url, tone)
//       );
// ─────────────────────────────────────────────────────

// POST /tone-vote  body: { url, tone }
app.post('/tone-vote', async (req, res) => {
  const { url, tone } = req.body;
  if (!url || !tone) return res.status(400).json({ error: 'url e tone obrigatórios' });
  try {
    // Tenta incrementar voto existente
    const existing = await supa.get('/tone_votes', {
      params: { url: `eq.${url}`, tone: `eq.${tone}`, select: 'votes', limit: 1 },
    });
    if (existing.data?.length > 0) {
      await supa.patch('/tone_votes',
        { votes: existing.data[0].votes + 1 },
        { params: { url: `eq.${url}`, tone: `eq.${tone}` }, headers: { 'Prefer': 'return=minimal' } }
      );
    } else {
      await supa.post('/tone_votes',
        { url, tone, votes: 1 },
        { headers: { 'Prefer': 'return=minimal' } }
      );
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.response?.data || e.message }); }
});

// GET /tone-vote?url=...  — retorna o tom com mais votos
app.get('/tone-vote', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url obrigatória' });
  try {
    const r = await supa.get('/tone_votes', {
      params: { url: `eq.${url}`, select: 'tone,votes', order: 'votes.desc', limit: 1 },
    });
    if (r.data?.length > 0 && r.data[0].votes >= 2) {
      // Só retorna como "comunitário" se tiver pelo menos 2 votos
      res.json({ tone: r.data[0].tone, votes: r.data[0].votes });
    } else {
      res.json({ tone: null }); // sem consenso ainda
    }
  } catch (e) { res.status(500).json({ error: e.response?.data || e.message }); }
});

// ─────────────────────────────────────────────────────
//  DESCOBERTA DE LÍDERES
// ─────────────────────────────────────────────────────

// POST /leader/online  body: { peerId, name }
app.post('/leader/online', async (req, res) => {
  const { peerId, name } = req.body;
  if (!peerId) return res.status(400).json({ error: 'peerId obrigatório' });
  try {
    await supa.post('/leaders_online',
      { peer_id: peerId, name: name || 'Líder', updated_at: new Date().toISOString() },
      { params: { on_conflict: 'peer_id' }, headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' } }
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.response?.data || e.message }); }
});

// DELETE /leader/offline  body: { peerId }
app.delete('/leader/offline', async (req, res) => {
  const { peerId } = req.body;
  if (!peerId) return res.status(400).json({ error: 'peerId obrigatório' });
  try {
    await supa.delete('/leaders_online', { params: { peer_id: `eq.${peerId}` } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.response?.data || e.message }); }
});

// GET /leaders  — líderes ativos nos últimos 3 minutos
app.get('/leaders', async (req, res) => {
  try {
    const since = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    const r = await supa.get('/leaders_online', {
      params: { select: 'peer_id,name', updated_at: `gte.${since}`, order: 'updated_at.desc', limit: 20 },
    });
    res.json({ leaders: r.data || [] });
  } catch (e) { res.status(500).json({ error: e.response?.data || e.message }); }
});

// ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
