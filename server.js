const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');
const cors    = require('cors');

const app = express();
app.use(cors());

const UA = 'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

// Resolve links curtos/compartilhamento seguindo redirects manualmente
async function resolveUrl(url) {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      maxRedirects: 10,
      timeout: 12000,
      // Captura a URL final após todos os redirects
      validateStatus: status => status < 400,
    });
    // axios armazena a URL final após redirects aqui:
    return response.request?.res?.responseUrl
        || response.request?.responseURL
        || url;
  } catch (e) {
    // Se falhou na resolução, devolve a original e deixa o próximo passo tentar
    return url;
  }
}

app.get('/get-cifra', async (req, res) => {
  let { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL é obrigatória' });

  try {
    // Passo 1: resolve links curtos/compartilhamento para URL final
    const isShortLink = /share\.google|goo\.gl|bit\.ly|tinyurl|ow\.ly|t\.co|short/i.test(url);
    if (isShortLink) {
      url = await resolveUrl(url);
    }

    // Passo 2: busca o conteúdo da página final
    const response = await axios.get(url, {
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      maxRedirects: 5,
      timeout: 12000,
    });

    const $ = cheerio.load(response.data);
    const finalUrl = response.request?.res?.responseUrl || url;

    let cifraHtml = null;
    let titulo    = '';
    let artista   = '';

    // ── Cifra Club ──
    if (/cifraclub\.com/i.test(finalUrl)) {
      cifraHtml = $('pre').first().html();
      titulo    = $('h1.t1').text() || $('h1').first().text();
      artista   = $('h2.t3').text() || $('h2').first().text();
    }

    // ── Cifras.com ──
    else if (/cifras\.com/i.test(finalUrl)) {
      cifraHtml = $('pre').first().html()
               || $('.cifra-content').first().html()
               || $('[class*="cifra"]').first().html();
      titulo  = $('h1').first().text();
      artista = $('h2').first().text() || $('[class*="artist"]').first().text();
    }

    // ── Genérico: qualquer site com <pre> ──
    else {
      cifraHtml = $('pre').first().html();
      titulo    = $('h1').first().text();
      artista   = $('h2').first().text();
    }

    if (!cifraHtml) {
      return res.status(422).json({ error: 'Cifra não encontrada nesta página.' });
    }

    res.json({
      titulo:   titulo.trim(),
      artista:  artista.trim(),
      cifra:    cifraHtml,
      urlFinal: finalUrl, // útil para debug
    });

  } catch (error) {
    const status = error.response?.status || 500;
    res.status(status).json({ error: 'Erro ao buscar cifra', details: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
