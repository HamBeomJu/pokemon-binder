const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');
const zlib  = require('zlib');

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

// In-memory cache
const artofpkmCache = {};

// ── Artofpkm helpers ────────────────────────────────────────────────────────

function fetchArtofpkmPage(setId, page, cb, attempt) {
    attempt = attempt || 1;
    const options = {
        hostname: 'www.artofpkm.com',
        path: `/sets/${setId}/cards` + (page > 1 ? `?page=${page}` : ''),
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'text/html',
        }
    };
    const req = https.get(options, (r) => {
        if (r.statusCode === 301 || r.statusCode === 302) {
            const loc = r.headers.location;
            const newId = loc && loc.match(/\/sets\/(\d+)\//);
            if (newId) return fetchArtofpkmPage(newId[1], page, cb, attempt);
            return cb(new Error('redirect failed'));
        }
        let html = '';
        r.setEncoding('utf8');
        r.on('data', chunk => html += chunk);
        r.on('end', () => cb(null, parseCards(html)));
    });
    req.on('error', (e) => {
        if (attempt < 3) {
            setTimeout(() => fetchArtofpkmPage(setId, page, cb, attempt + 1), 2000 * attempt);
        } else {
            cb(e);
        }
    });
    req.setTimeout(20000, () => { req.destroy(); });
}

// Promise 래퍼
function fetchArtofpkmPageP(setId, page) {
    return new Promise((resolve) => {
        fetchArtofpkmPage(setId, page, (err, cards) => resolve(err ? [] : cards));
    });
}

async function fetchArtofpkmAsync(setId) {
    if (artofpkmCache[setId]) return artofpkmCache[setId];
    const allCards = [];
    const seen = new Set();
    const BATCH = 5;

    for (let batch = 0; batch < 4; batch++) {
        const pages = Array.from({ length: BATCH }, (_, i) => batch * BATCH + i + 1);
        const results = await Promise.all(pages.map(p => fetchArtofpkmPageP(setId, p)));
        let added = 0;
        for (const cards of results) {
            for (const card of cards) {
                if (!seen.has(card.file)) { seen.add(card.file); allCards.push(card); added++; }
            }
        }
        if (added === 0) break;
    }
    if (allCards.length > 0) artofpkmCache[setId] = allCards;
    return allCards;
}

function fetchArtofpkm(setId, cb) {
    fetchArtofpkmAsync(setId).then(cards => cb(null, cards)).catch(e => cb(e));
}

function parseCards(html) {
    const cards = [];
    const imgRe = /src="(https:\/\/www\.artofpkm\.com\/rails\/active_storage\/[^"]+\/(\d+_[PTE]_[^"\/]+\.jpg))"/g;
    const byFile = {};
    let m;
    while ((m = imgRe.exec(html)) !== null) {
        const file = m[2];
        const thumbUrl = m[1];
        const fullUrl = thumbUrl.replace(
            /\/rails\/active_storage\/representations\/redirect\/([^/]+)\/[^/]+\/(.+)$/,
            '/rails/active_storage/blobs/redirect/$1/$2'
        );
        if (!byFile[file]) byFile[file] = { thumb: thumbUrl, full: fullUrl };
    }
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

// ── pokemontcg.io proxy ─────────────────────────────────────────────────────

function fetchPokemontcg(setId, cb) {
    const options = {
        hostname: 'api.pokemontcg.io',
        path: `/v2/cards?q=set.id:${encodeURIComponent(setId)}&pageSize=250&orderBy=number&select=id,name,images`,
        headers: {
            'User-Agent': 'Mozilla/5.0',
            'Accept': 'application/json',
        }
    };
    const req = https.get(options, (r) => {
        let body = '';
        r.setEncoding('utf8');
        r.on('data', chunk => body += chunk);
        r.on('end', () => {
            try { cb(null, JSON.parse(body)); }
            catch(e) { cb(new Error('parse error')); }
        });
    });
    req.on('error', cb);
    req.setTimeout(20000, () => { req.destroy(); cb(new Error('timeout')); });
}

// ── HTTP server ─────────────────────────────────────────────────────────────

http.createServer((req, res) => {
    const parsed   = url.parse(req.url, true);
    const pathname = parsed.pathname;

    // Artofpkm proxy
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

    // pokemontcg.io proxy
    if (pathname === '/api/pokemontcg') {
        const setId = (parsed.query.setId || '').replace(/[^a-zA-Z0-9_.-]/g, '');
        if (!setId) { res.writeHead(400); res.end('bad setId'); return; }

        fetchPokemontcg(setId, (err, data) => {
            if (err) {
                res.writeHead(502, {'Content-Type':'application/json'});
                res.end(JSON.stringify({error: err.message}));
                return;
            }
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'public, max-age=3600',
            });
            res.end(JSON.stringify(data));
        });
        return;
    }

    // Static files (gzip for JSON/HTML)
    const filePath = path.join(ROOT, pathname === '/' ? 'index.html' : pathname);
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        const ext = path.extname(filePath).toLowerCase();
        const mime = MIME[ext] || 'text/plain';
        const acceptsGzip = /gzip/.test(req.headers['accept-encoding'] || '');
        // JSON/HTML만 압축 (이미지는 제외)
        if (acceptsGzip && (ext === '.json' || ext === '.html' || ext === '.js' || ext === '.css')) {
            zlib.gzip(data, (zerr, compressed) => {
                if (zerr) {
                    res.writeHead(200, { 'Content-Type': mime });
                    res.end(data);
                    return;
                }
                res.writeHead(200, {
                    'Content-Type': mime,
                    'Content-Encoding': 'gzip',
                    'Vary': 'Accept-Encoding',
                });
                res.end(compressed);
            });
        } else {
            res.writeHead(200, { 'Content-Type': mime });
            res.end(data);
        }
    });

}).listen(PORT, () => {
    console.log(`PokeBinder Dev  →  http://localhost:${PORT}`);
});
