const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors()); // Isso resolve o problema de bloqueio no seu App

app.get('/get-cifra', async (req, res) => {
    const { url } = req.query;

    if (!url) {
        return res.status(400).json({ error: 'URL é obrigatória' });
    }

    try {
        // Simulando um User-Agent de navegador para evitar bloqueio 403
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        const $ = cheerio.load(response.data);

        // O Cifra Club geralmente coloca a cifra dentro da tag <pre>
        const cifraHtml = $('pre').html();
        const titulo = $('h1.t1').text() || $('h1').text();
        const artista = $('h2.t3').text() || $('h2').text();

        if (!cifraHtml) {
            throw new Error('Não foi possível encontrar a cifra nesta página.');
        }

        res.json({
            titulo: titulo.trim(),
            artista: artista.trim(),
            cifra: cifraHtml
        });

    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar cifra', details: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));