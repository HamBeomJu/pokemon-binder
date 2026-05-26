const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname);

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css' : 'text/css',
    '.js'  : 'application/javascript',
    '.json': 'application/json',
    '.png' : 'image/png',
    '.jpg' : 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif' : 'image/gif',
    '.svg' : 'image/svg+xml',
    '.ico' : 'image/x-icon',
};

// In-memory cache for artofpkm scraped data
const artofpkmCache = {};

function fetchArtofpkm(setId, cb) {
    if (artofpkmCache[setId]) return cb(null, artofpkmCache[setId]);

    const options = {
        hostname: 'www.artofpkm.com',
        path: `/sets/${setId}/cards`,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'text/vnd.turbo-stream.html, text/html',
        }
    };

    const req = https.get(options, (r) => {
        // Handle redirects
        if (r.statusCode === 301 || r.statusCode === 302) {
            return fetchArtofpkmUrl(r.headers.location, cb);
        }
        let html = '';
        r.setEncoding('utf8');
        r.on('data', chunk => html += chunk);
        r.on('end', () => {
            const cards = parseCards(html);
            artofpkmCache[setId] = cards;
            cb(null, cards);
        });
    });
    req.on('error', e => cb(e));
    req.setTimeout(15000, () => { req.destroy(); cb(new Error('timeout')); });
}

function parseCards(html) {
    const cards = [];
    // Turbo-stream format: src is absolute URL with filename like 048341_P_NAZONOKUSA.jpg
    const imgRe = /src="(https:\/\/www\.artofpkm\.com\/rails\/active_storage\/[^"]+\/(\d+_[PTE]_[^"\/]+\.jpg))"/g;

    const byFile = {};
    let m;
    while ((m = imgRe.exec(html)) !== null) {
        const file = m[2];
        const thumbUrl = m[1];
        // Derive full-size by converting representation URL to blob URL
        const fullUrl = thumbUrl.replace(
            /\/rails\/active_storage\/representations\/redirect\/([^/]+)\/[^/]+\/(.+)$/,
            '/rails/active_storage/blobs/redirect/$1/$2'
        );
        if (!byFile[file]) byFile[file] = { thumb: thumbUrl, full: fullUrl };
    }

    // Preserve order by finding filenames in document order
    const orderRe = /(\d+_[PTE]_[^"\/\s]+\.jpg)/g;
    const seen = new Set();
    while ((m = orderRe.exec(html)) !== null) {
        const file = m[1];
        if (!seen.has(file) && byFile[file]) {
            seen.add(file);
            const entry = byFile[file];
            cards.push({ file, thumb: entry.thumb, full: entry.full });
        }
    }
    return cards;
}

http.createServer((req, res) => {
    const pathname = url.parse(req.url).pathname;

    // ── Artofpkm proxy ──────────────────────────────────────────
    if (pathname.startsWith('/api/artofpkm/')) {
        const setId = pathname.replace('/api/artofpkm/', '').replace(/\D/g, '');
        if (!setId) { res.writeHead(400); res.end('bad id'); return; }

        fetchArtofpkm(setId, (err, cards) => {
            if (err) {
                res.writeHead(502, {'Content-Type':'application/json'});
                res.end(JSON.stringify({error: err.message}));
                return;
            }
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'public, max-age=86400',
            });
            res.end(JSON.stringify({cards}));
        });
        return;
    }

    // ── Static files ─────────────────────────────────────────────
    const filePath = path.join(ROOT, pathname === '/' ? 'index.html' : pathname);
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
        res.end(data);
    });

}).listen(PORT, () => {
    console.log(`PokeBinder Dev  →  http://localhost:${PORT}`);
});
