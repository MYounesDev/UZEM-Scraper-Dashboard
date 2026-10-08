// Vercel Serverless Function - CORS proxy for edestek.kocaeli.edu.tr
// Each call is a single student lookup - completes in <3s, well within Vercel limits.

const TARGET_URL = 'http://edestek.kocaeli.edu.tr/index.php';

module.exports = async function handler(req, res) {
    // Allow CORS from any origin (our own frontend calls this)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { ogrno } = req.body || {};
    if (!ogrno || typeof ogrno !== 'string' || !/^\d{8,10}$/.test(ogrno)) {
        return res.status(400).json({ error: 'Geçersiz ogrno' });
    }

    try {
        const upstream = await fetch(TARGET_URL, {
            method: 'POST',
            headers: {
                'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'content-type': 'application/x-www-form-urlencoded',
                'cache-control': 'no-cache',
            },
            body: `ogrno=${encodeURIComponent(ogrno)}`,
            // 8 second timeout to stay safely within Vercel's 10s hobby limit
            signal: AbortSignal.timeout(8000),
        });

        if (!upstream.ok) {
            return res.status(502).json({ error: `Upstream HTTP ${upstream.status}` });
        }

        const html = await upstream.text();
        // Return raw HTML - client does all parsing with native DOMParser
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(200).send(html);
    } catch (err) {
        if (err.name === 'TimeoutError' || err.name === 'AbortError') {
            return res.status(504).json({ error: 'Upstream timeout' });
        }
        return res.status(502).json({ error: err.message });
    }
};
