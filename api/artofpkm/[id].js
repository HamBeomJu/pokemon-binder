const https = require('https');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');

// ── 디스크 캐시 (Vercel /tmp, 24시간) ─────────────────────────────────────
const CACHE_DIR = path.join(os.tmpdir(), 'artofpkm_cache');
try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch(e) {}

function cacheGet(key) {
    try {
        const f = path.join(CACHE_DIR, key + '.json');
        const stat = fs.statSync(f);
        if (Date.now() - stat.mtimeMs < 86400000) return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch(e) {}
    return null;
}
function cacheSet(key, data) {
    try { fs.writeFileSync(path.join(CACHE_DIR, key + '.json'), JSON.stringify(data)); } catch(e) {}
}

// ── 카드 파싱 ───────────────────────────────────────────────────────────────
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

// ── 단일 페이지 fetch ────────────────────────────────────────────────────────
function fetchPage(setId, page) {
    return new Promise((resolve, reject) => {
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
                if (newId) return fetchPage(newId[1], page).then(resolve).catch(reject);
                return reject(new Error('redirect failed'));
            }
            let html = '';
            r.setEncoding('utf8');
            r.on('data', chunk => html += chunk);
            r.on('end', () => resolve(parseCards(html)));
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    });
}

// ── 전체 세트 fetch (병렬 배치) ──────────────────────────────────────────────
async function fetchArtofpkm(setId) {
    const allCards = [];
    const seen = new Set();
    const BATCH = 5; // 5페이지씩 병렬

    for (let batch = 0; batch < 4; batch++) {         // 최대 20페이지
        const pages = Array.from({ length: BATCH }, (_, i) => batch * BATCH + i + 1);
        const results = await Promise.all(pages.map(p => fetchPage(setId, p).catch(() => [])));
        let addedInBatch = 0;
        for (const cards of results) {
            for (const card of cards) {
                if (!seen.has(card.file)) {
                    seen.add(card.file);
                    allCards.push(card);
                    addedInBatch++;
                }
            }
        }
        if (addedInBatch === 0) break;   // 이 배치에서 새 카드 없음 → 끝
    }
    return allCards;
}

// ── Vercel 핸들러 ────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
    const setId = (req.query.id || '').replace(/\D/g, '');
    if (!setId) { res.status(400).json({ error: 'bad id' }); return; }

    // 캐시 확인
    const cached = cacheGet(setId);
    if (cached) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.setHeader('X-Cache', 'HIT');
        res.json(cached);
        return;
    }

    try {
        const cards = await fetchArtofpkm(setId);
        const payload = { cards };
        cacheSet(setId, payload);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.json(payload);
    } catch (e) {
        res.status(502).json({ error: e.message });
    }
};
