const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');
const cors    = require('cors');

const app = express();
app.use(cors());

const UA = 'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

const AXIOS_CFG = {
  headers: {
    'User-Agent': UA,
    'Accept-Language': 'pt-BR,pt;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  },
  maxRedirects: 10,
  timeout: 12000,
};

// ── Resolve links curtos/compartilhamento seguindo redirects ──
async function resolveUrl(url) {
  try {
    const r = await axios.get(url, { ...AXIOS_CFG, validateStatus: s => s < 400 });
    return r.request?.res?.responseUrl || r.request?.responseURL || url;
  } catch { return url; }
}

// ── GET /search?q=nome+artista&page=1 ──
app.get('/search', async (req, res) => {
  const { q, page = 1 } = req.query;
  if (!q) return res.status(400).json({ error: 'Parâmetro q é obrigatório' });

  try {
    const searchUrl = `https://www.cifraclub.com.br/busca/?q=${encodeURIComponent(q)}`;
    const response  = await axios.get(searchUrl, AXIOS_CFG);
    const $         = cheerio.load(response.data);

    const results = [];

    // Cifra Club: resultados de músicas ficam em <a> dentro de .gs-title
    // com URL no formato /artista/musica/
    const SONG_URL_RE = /^https?:\/\/(?:www\.)?cifraclub\.com\.br\/[a-z0-9-]+\/[a-z0-9-]+\/$/i;

    // Tenta seletores específicos de resultados do Cifra Club
    const selectors = [
      '.gs-webResult .gs-title a',
      '.gs-result .gs-title a',
      '.search-results a',
      'article a[href]',
      '.result a[href]',
    ];

    for (const sel of selectors) {
      $(sel).each((_, el) => {
        const $el    = $(el);
        let   href   = $el.attr('href') || '';
        if (!href.startsWith('http')) href = 'https://www.cifraclub.com.br' + href;

        if (!SONG_URL_RE.test(href)) return; // só URLs de música

        // Extrai artista e título do próprio href: /artista/musica/
        const parts  = href.replace(/https?:\/\/[^/]+/, '').split('/').filter(Boolean);
        if (parts.length !== 2) return;

        const title  = ($el.text().trim() || parts[1].replace(/-/g, ' ')).replace(/\s+/g, ' ');
        const artist = parts[0].replace(/-/g, ' ');

        if (!results.find(r => r.url === href)) {
          results.push({ title, artist, url: href });
        }
      });
      if (results.length >= 9) break; // suficiente para 3 páginas
    }

    // Fallback final: varre a página inteira mas com URL estrita
    if (results.length === 0) {
      $('a[href]').each((_, el) => {
        let href = $(el).attr('href') || '';
        if (!href.startsWith('http')) href = 'https://www.cifraclub.com.br' + href;

        if (!SONG_URL_RE.test(href)) return;

        const parts = href.replace(/https?:\/\/[^/]+/, '').split('/').filter(Boolean);
        if (parts.length !== 2) return;

        const title  = parts[1].replace(/-/g, ' ');
        const artist = parts[0].replace(/-/g, ' ');

        if (!results.find(r => r.url === href)) {
          results.push({ title, artist, url: href });
        }
      });
    }

    const PAGE_SIZE = 3;
    const start     = (Number(page) - 1) * PAGE_SIZE;
    const slice     = results.slice(start, start + PAGE_SIZE);
    const hasMore   = results.length > start + PAGE_SIZE;

    res.json({ results: slice, hasMore, page: Number(page) });
  } catch (error) {
    res.status(500).json({ error: 'Erro na busca', details: error.message });
  }
});

// ── GET /get-cifra?url=... ──
app.get('/get-cifra', async (req, res) => {
  let { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL é obrigatória' });

  try {
    // Resolve links curtos antes de buscar
    if (/share\.google|goo\.gl|bit\.ly|tinyurl|ow\.ly|t\.co/i.test(url)) {
      url = await resolveUrl(url);
    }

    const response = await axios.get(url, AXIOS_CFG);
    const $        = cheerio.load(response.data);
    const finalUrl = response.request?.res?.responseUrl || url;

    let cifraHtml = null, titulo = '', artista = '';

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

    if (!cifraHtml) {
      return res.status(422).json({ error: 'Cifra não encontrada nesta página.' });
    }

    res.json({ titulo: titulo.trim(), artista: artista.trim(), cifra: cifraHtml });
  } catch (error) {
    res.status(error.response?.status || 500).json({ error: 'Erro ao buscar cifra', details: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
