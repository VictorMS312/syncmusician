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
// Busca músicas no Cifra Club e retorna 3 por vez
app.get('/search', async (req, res) => {
  const { q, page = 1 } = req.query;
  if (!q) return res.status(400).json({ error: 'Parâmetro q é obrigatório' });

  try {
    const searchUrl = `https://www.cifraclub.com.br/busca/?q=${encodeURIComponent(q)}&page=${page}`;
    const response  = await axios.get(searchUrl, AXIOS_CFG);
    const $         = cheerio.load(response.data);

    const results = [];

    // Seletor principal dos resultados do Cifra Club
    $('ul.js-search-results > li, .search-result, .gs-result').each((_, el) => {
      const $el   = $(el);
      const $link = $el.find('a[href*="/"]').first();
      const href  = $link.attr('href') || '';
      const title = ($el.find('b, strong, .title').first().text() || $link.text()).trim();
      const artist = $el.find('.artist, .band, em').first().text().trim();
      const url   = href.startsWith('http') ? href : 'https://www.cifraclub.com.br' + href;

      // Só URLs no formato /artista/musica/
      if (/cifraclub\.com/.test(url) && /^https:\/\/www\.cifraclub\.com\.br\/[^/]+\/[^/]+\/$/.test(url) && title) {
        if (!results.find(r => r.url === url)) {
          results.push({ title, artist, url });
        }
      }
    });

    // Fallback: varre todos os links da página
    if (results.length === 0) {
      $('a').each((_, el) => {
        const href  = $(el).attr('href') || '';
        const title = $(el).text().trim();
        const url   = href.startsWith('http') ? href : 'https://www.cifraclub.com.br' + href;
        if (/^https:\/\/www\.cifraclub\.com\.br\/[^/]+\/[^/]+\/$/.test(url) && title.length > 2) {
          if (!results.find(r => r.url === url)) {
            results.push({ title, artist: '', url });
          }
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
