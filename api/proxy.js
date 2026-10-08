// Vercel Serverless Function - CORS proxy for edestek.kocaeli.edu.tr
// Each call is a single student lookup - completes in <3s, well within Vercel limits.

const TARGET_URL = 'http://edestek.kocaeli.edu.tr/index.php';

// Vercel does NOT auto-parse req.body — we must do it manually
function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => { data += chunk; });
        req.on('end', () => {
            try { resolve(JSON.parse(data)); }
            catch { resolve({}); }
        });
        req.on('error', reject);
    });
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const body = await readBody(req);
    const { ogrno } = body;

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
            signal: AbortSignal.timeout(8000),
        });

        if (!upstream.ok) {
            return res.status(502).json({ error: `Upstream HTTP ${upstream.status}` });
        }

        const html = await upstream.text();
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(200).send(html);
    } catch (err) {
        if (err.name === 'TimeoutError' || err.name === 'AbortError') {
            return res.status(504).json({ error: 'Upstream timeout' });
        }
        return res.status(502).json({ error: err.message });
    }
};
