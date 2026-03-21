const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');
const cors    = require('cors');

const app = express();
app.use(cors());

// ─────────────────────────────────────────────────────
//  CONFIGURAÇÕES
// ─────────────────────────────────────────────────────
const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const UA_MOBILE  = 'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

// Sites de cifra suportados — sem exposição desses nomes na interface do app
const CIFRA_SITES = [
  { host: 'cifraclub.com.br',  songRe: /^https?:\/\/(?:www\.)?cifraclub\.com\.br\/[a-z0-9-]+\/[a-z0-9-]+\/?$/i },
  { host: 'cifras.com.br',     songRe: /^https?:\/\/(?:www\.)?cifras\.com\.br\/cifra\/[a-z0-9-]+-\d+/i        },
];

function isSongUrl(url) {
  return CIFRA_SITES.some(s => s.songRe.test(url));
}

function cleanSongUrl(url) {
  // Garante barra final no Cifra Club
  if (/cifraclub\.com\.br/.test(url) && !url.endsWith('/')) return url + '/';
  return url;
}

// Capitaliza slug: "nada-pode-calar" → "Nada Pode Calar"
function slugToTitle(slug) {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ─────────────────────────────────────────────────────
//  RESOLVE LINKS CURTOS / COMPARTILHAMENTO
// ─────────────────────────────────────────────────────
async function resolveUrl(url) {
  try {
    const r = await axios.get(url, {
      headers: { 'User-Agent': UA_MOBILE },
      maxRedirects: 10, timeout: 10000,
      validateStatus: s => s < 400,
    });
    return r.request?.res?.responseUrl || r.request?.responseURL || url;
  } catch { return url; }
}

// ─────────────────────────────────────────────────────
//  BUSCA VIA DUCKDUCKGO HTML
//  Filtra resultados para URLs de música nos sites suportados
// ─────────────────────────────────────────────────────
async function searchDDG(query, pageOffset = 0) {
  // DuckDuckGo HTML endpoint — funciona sem API key
  // Usa operador site: internamente para filtrar somente cifras
  const siteFilter  = CIFRA_SITES.map(s => `site:${s.host}`).join(' OR ');
  const fullQuery   = `${query} (${siteFilter})`;
  const ddgUrl      = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(fullQuery)}&s=${pageOffset}`;

  const response = await axios.get(ddgUrl, {
    headers: {
      'User-Agent': UA_DESKTOP,
      'Accept-Language': 'pt-BR,pt;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Referer': 'https://duckduckgo.com/',
    },
    timeout: 12000,
  });

  const $       = cheerio.load(response.data);
  const results = [];

  // Resultados do DDG ficam em .result__title a ou .result__url
  $('.result').each((_, el) => {
    const $el = $(el);

    // URL real fica no atributo href do link de resultado
    let href = $el.find('a.result__url').attr('href')
             || $el.find('.result__title a').attr('href')
             || '';

    // DDG às vezes usa redirect: //duckduckgo.com/l/?uddg=URL_REAL
    if (href.includes('duckduckgo.com/l/')) {
      try {
        const u = new URL('https:' + href);
        href    = decodeURIComponent(u.searchParams.get('uddg') || href);
      } catch {}
    }
    if (href && !href.startsWith('http')) href = 'https://' + href;

    href = cleanSongUrl(href);
    if (!isSongUrl(href)) return;

    // Extrai título e artista da URL
    const path   = href.replace(/https?:\/\/[^/]+/, '').replace(/^\/|\/$/g, '');
    const parts  = path.split('/').filter(Boolean);

    let title, artist;

    if (/cifraclub\.com\.br/.test(href) && parts.length >= 2) {
      artist = slugToTitle(parts[0]);
      title  = slugToTitle(parts[1]);
    } else if (/cifras\.com\.br/.test(href)) {
      // /cifra/titulo-do-artista-123
      const slug = (parts[1] || '').replace(/-\d+$/, '');
      title      = slugToTitle(slug);
      artist     = '';
    } else {
      title  = slugToTitle(parts[parts.length - 1] || '');
      artist = '';
    }

    // Enriquece com texto visível do resultado se disponível
    const visibleTitle = $el.find('.result__title').text().trim();
    if (visibleTitle && visibleTitle.length > title.length) {
      // Usa texto do resultado se for mais descritivo
      title  = visibleTitle.split(' - ')[0]?.trim() || title;
      artist = visibleTitle.split(' - ')[1]?.trim() || artist;
    }

    if (!results.find(r => r.url === href)) {
      results.push({ title, artist, url: href });
    }
  });

  return results;
}

// ─────────────────────────────────────────────────────
//  GET /search?q=...&page=1
// ─────────────────────────────────────────────────────
app.get('/search', async (req, res) => {
  const { q, page = 1 } = req.query;
  if (!q) return res.status(400).json({ error: 'Parâmetro q é obrigatório' });

  const PAGE_SIZE  = 3;
  const pageNum    = Number(page);
  // DDG retorna ~10 por request; offset de 30 por "página" do DDG
  const ddgOffset  = Math.floor((pageNum - 1) / 3) * 30;

  try {
    const all     = await searchDDG(q, ddgOffset);
    const start   = ((pageNum - 1) % 3) * PAGE_SIZE;
    const slice   = all.slice(start, start + PAGE_SIZE);
    const hasMore = all.length > start + PAGE_SIZE;

    res.json({ results: slice, hasMore, page: pageNum });
  } catch (error) {
    res.status(500).json({ error: 'Erro na busca', details: error.message });
  }
});

// ─────────────────────────────────────────────────────
//  GET /get-cifra?url=...
// ─────────────────────────────────────────────────────
app.get('/get-cifra', async (req, res) => {
  let { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL é obrigatória' });

  try {
    // Resolve links curtos / compartilhamento
    if (/share\.google|goo\.gl|bit\.ly|tinyurl|ow\.ly|t\.co/i.test(url)) {
      url = await resolveUrl(url);
    }

    const response = await axios.get(url, {
      headers: {
        'User-Agent': UA_DESKTOP,
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      maxRedirects: 5,
      timeout: 12000,
    });

    const $        = cheerio.load(response.data);
    const finalUrl = response.request?.res?.responseUrl || url;

    let cifraHtml = null, titulo = '', artista = '';

    if (/cifraclub\.com/i.test(finalUrl)) {
      cifraHtml = $('pre').first().html();
      titulo    = $('h1.t1').text() || $('h1').first().text();
      artista   = $('h2.t3').text() || $('h2').first().text();
    } else if (/cifras\.com/i.test(finalUrl)) {
      cifraHtml = $('pre').first().html()
               || $('.cifra-content').first().html()
               || $('[class*="cifra"]').first().html();
      titulo    = $('h1').first().text();
      artista   = $('h2').first().text();
    } else {
      // Genérico: qualquer site com <pre>
      cifraHtml = $('pre').first().html();
      titulo    = $('h1').first().text();
      artista   = $('h2').first().text();
    }

    if (!cifraHtml) {
      return res.status(422).json({ error: 'Cifra não encontrada nesta página.' });
    }

    res.json({
      titulo:  titulo.trim(),
      artista: artista.trim(),
      cifra:   cifraHtml,
    });

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
