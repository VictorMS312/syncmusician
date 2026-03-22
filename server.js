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
//           artista (text), conteudo (text), acessos (int4 default 0),
//           criado_em (timestamptz default now())
// ─────────────────────────────────────────────────────
async function cacheGet(url) {
  try {
    const r = await supa.get('/cifras', {
      params: { url: `eq.${url}`, select: '*', limit: 1 },
    });
    if (r.data?.length > 0) {
      // Incrementa acessos em background
      supa.patch('/cifras', { acessos: r.data[0].acessos + 1 }, {
        params: { url: `eq.${url}` },
      }).catch(() => {});
      return r.data[0];
    }
    return null;
  } catch { return null; }
}

async function cacheSave({ url, titulo, artista, conteudo }) {
  try {
    await supa.post('/cifras',
      { url, titulo, artista, conteudo, acessos: 1 },
      { headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' } }
    );
  } catch (e) {
    console.error('Cache save error:', e.message);
  }
}

async function cacheSearch(q) {
  try {
    const terms = q.trim().split(/\s+/).filter(Boolean).slice(0, 5);
    // Busca por cada termo no título ou artista (OR entre campos, AND entre termos)
    // Estratégia: pega o termo principal (mais longo) e filtra
    const main  = terms.sort((a, b) => b.length - a.length)[0];
    const r     = await supa.get('/cifras', {
      params: {
        or:     `titulo.ilike.%${main}%,artista.ilike.%${main}%`,
        select: 'url,titulo,artista,acessos',
        limit:  20,
        order:  'acessos.desc',
      },
    });
    if (!r.data?.length) return [];

    // Filtra localmente pelos outros termos
    const others = terms.filter(t => t !== main);
    return r.data.filter(row => {
      const text = `${row.titulo} ${row.artista}`.toLowerCase();
      return others.every(t => text.includes(t.toLowerCase()));
    });
  } catch { return []; }
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
  let cifraHtml  = null, titulo = '', artista = '';

  if (/cifraclub\.com/i.test(finalUrl)) {
    cifraHtml = $('pre').first().html();
    titulo    = $('h1.t1').text() || $('h1').first().text();
    artista   = $('h2.t3').text() || $('h2').first().text();
  } else if (/cifras\.com/i.test(finalUrl)) {
    cifraHtml = $('pre').first().html() || $('.cifra-content').first().html();
    titulo    = $('h1').first().text();
    artista   = $('h2').first().text();
  } else {
    cifraHtml = $('pre').first().html();
    titulo    = $('h1').first().text();
    artista   = $('h2').first().text();
  }

  if (!cifraHtml) throw new Error('Cifra não encontrada nesta página.');

  return {
    titulo:   titulo.trim(),
    artista:  artista.trim(),
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

  const PAGE_SIZE = 3;
  const pageNum   = Number(page);

  try {
    // 1. Busca no cache primeiro
    const cached = await cacheSearch(q);
    const cacheResults = cached.map(r => ({
      title:  r.titulo,
      artist: r.artista,
      url:    r.url,
    }));

    const start = (pageNum - 1) * PAGE_SIZE;

    // 2. Se cache satisfaz a página pedida, retorna sem ir à internet
    if (cacheResults.length >= start + PAGE_SIZE) {
      return res.json({
        results: cacheResults.slice(start, start + PAGE_SIZE),
        hasMore: cacheResults.length > start + PAGE_SIZE,
        page:    pageNum,
      });
    }

    // 3. Complementa com DuckDuckGo
    let webResults = [];
    try { webResults = await searchDDG(q); } catch {}

    // Merge sem duplicatas (cache tem prioridade)
    const seen  = new Set(cacheResults.map(r => r.url));
    const merged = [...cacheResults];
    for (const r of webResults) {
      if (!seen.has(r.url)) {
        merged.push({ title: r.title, artist: r.artist, url: r.url });
        seen.add(r.url);
      }
    }

    res.json({
      results: merged.slice(start, start + PAGE_SIZE),
      hasMore: merged.length > start + PAGE_SIZE,
      page:    pageNum,
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

    // 1. Verifica cache — retorna imediatamente se encontrado
    const hit = await cacheGet(url);
    if (hit) {
      return res.json({
        titulo:  hit.titulo,
        artista: hit.artista,
        cifra:   hit.conteudo,
      });
    }

    // 2. Scraping
    const { titulo, artista, conteudo } = await scrapeCifra(url);

    // 3. Salva no cache em background (não bloqueia a resposta)
    cacheSave({ url, titulo, artista, conteudo }).catch(() => {});

    res.json({ titulo, artista, cifra: conteudo });

  } catch (error) {
    res.status(error.response?.status || 500).json({
      error:   'Erro ao buscar cifra',
      details: error.message,
    });
  }
});

// ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
