const https = require('https');

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

async function fetchArtofpkm(setId) {
    const allCards = [];
    const seen = new Set();
    for (let page = 1; page <= 20; page++) {
        const cards = await fetchPage(setId, page);
        let added = 0;
        for (const card of cards) {
            if (!seen.has(card.file)) {
                seen.add(card.file);
                allCards.push(card);
                added++;
            }
        }
        if (added === 0) break;
    }
    return allCards;
}

module.exports = async (req, res) => {
    const setId = (req.query.id || '').replace(/\D/g, '');
    if (!setId) { res.status(400).json({ error: 'bad id' }); return; }
    try {
        const cards = await fetchArtofpkm(setId);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.json({ cards });
    } catch (e) {
        res.status(502).json({ error: e.message });
    }
};
