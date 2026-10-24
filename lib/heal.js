const { QUERY_IDS, TWITTER_OPENAPI_URL } = require('./config');
const { getAuthHeaders } = require('./auth');
const { httpsGet } = require('./http');
const { ghaEndGroup, ghaGroup, log } = require('./log');

// ─── QueryId auto-heal ──────────────────────────────────────────────────────────

async function healQueryIds() {
    // Env vars already applied; try remote source to get fresher IDs
    ghaGroup('[HEAL] QueryId refresh');
    let healed = false;

    // 1. Try community placeholder (no auth needed, ~1s)
    try {
        log('[INFO]', 'HEAL', `Fetching ${TWITTER_OPENAPI_URL}...`);
        const res = await httpsGet(TWITTER_OPENAPI_URL, { Accept: 'application/json' });
        if (res.status === 200) {
            const data = JSON.parse(res.body);
            let updated = 0;
            for (const op of ['UserByScreenName', 'UserTweets']) {
                const qid = data?.[op]?.queryId;
                if (qid && typeof qid === 'string' && qid !== QUERY_IDS[op]) {
                    log('[OK]', 'HEAL', `${op}: ${QUERY_IDS[op]} → ${qid} (from twitter-openapi)`);
                    QUERY_IDS[op] = qid;
                    updated++;
                }
            }
            if (updated > 0) healed = true;
            else log('[INFO]', 'HEAL', 'Remote IDs match fallback — no update needed');
        } else {
            log('[WARN]', 'HEAL', `Remote returned HTTP ${res.status}`);
        }
    } catch (e) {
        log('[WARN]', 'HEAL', `Remote fetch failed: ${e.message}`);
    }

    // 2. If remote had nothing, try scraping x.com bundles (needs auth)
    if (!healed && process.env.X_AUTH_TOKEN && process.env.X_CT0) {
        try {
            log('[INFO]', 'HEAL', 'Trying bundle scrape from x.com (fallback)...');
            const ct0 = process.env.X_CT0;
            const homeRes = await httpsGet('https://x.com/', {
                ...getAuthHeaders(ct0),
                Accept: 'text/html',
            });
            // Extract bundle URLs
            const bundleUrls = [...(homeRes.body.matchAll(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/[^"'\s]+\.js/g))].map(m => m[0]);
            const uniq = [...new Set(bundleUrls)].slice(0, 3);
            log('[INFO]', 'HEAL', `Found ${uniq.length} bundle(s)`);
            for (const url of uniq) {
                try {
                    const bRes = await httpsGet(url, {});
                    if (bRes.status !== 200) continue;
                    // Matches: queryId:"xxx",operationName:"UserTweets"  or reverse
                    const re1 = /queryId:"([^"]+)",operationName:"([^"]+)"/g;
                    const re2 = /operationName:"([^"]+)",queryId:"([^"]+)"/g;
                    for (const re of [re1, re2]) {
                        let m;
                        while ((m = re.exec(bRes.body)) !== null) {
                            const qid = re === re1 ? m[1] : m[2];
                            const op = re === re1 ? m[2] : m[1];
                            if ((op === 'UserByScreenName' || op === 'UserTweets') && qid !== QUERY_IDS[op]) {
                                log('[OK]', 'HEAL', `${op}: ${QUERY_IDS[op]} → ${qid} (from bundle ${url.split('/').pop()})`);
                                QUERY_IDS[op] = qid;
                                healed = true;
                            }
                        }
                    }
                } catch (e) {
                    log('[WARN]', 'HEAL', `Bundle fetch failed ${url}: ${e.message}`);
                }
            }
        } catch (e) {
            log('[WARN]', 'HEAL', `Bundle scrape failed: ${e.message}`);
        }
    }

    if (!healed) log('[INFO]', 'HEAL', 'Using fallback/env queryIds');
    log('[INFO]', 'HEAL', `Final: UserByScreenName=${QUERY_IDS.UserByScreenName} UserTweets=${QUERY_IDS.UserTweets}`);
    ghaEndGroup();
}

module.exports = {
    healQueryIds,
};
