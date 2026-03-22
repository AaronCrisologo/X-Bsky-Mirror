process.stdout.setEncoding('utf8');
process.stderr.setEncoding('utf8');

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());

// ─── Logging helpers ──────────────────────────────────────────────────────────

function ts() {
    return new Date().toISOString();
}

function log(icon, tag, msg) {
    process.stderr.write(`[${ts()}] ${icon} [${tag}] ${msg}\n`);
}

function ghaGroup(name) {
    process.stderr.write(`::group::${name}\n`);
}

function ghaEndGroup() {
    process.stderr.write(`::endgroup::\n`);
}

function ghaError(msg) {
    process.stderr.write(`::error::${msg}\n`);
}

function ghaWarning(msg) {
    process.stderr.write(`::warning::${msg}\n`);
}

function timer() {
    const start = Date.now();
    return () => `${((Date.now() - start) / 1000).toFixed(2)}s`;
}

// ─── Cookie / env validation ──────────────────────────────────────────────────

function validateEnv() {
    ghaGroup('🔐 Environment Validation');
    const authToken = process.env.X_AUTH_TOKEN;
    const ct0 = process.env.X_CT0;
    let valid = true;

    if (!authToken) {
        ghaError('X_AUTH_TOKEN secret is missing or empty');
        valid = false;
    } else {
        log('✅', 'ENV', `X_AUTH_TOKEN present (length: ${authToken.length})`);
    }

    if (!ct0) {
        ghaError('X_CT0 secret is missing or empty');
        valid = false;
    } else {
        log('✅', 'ENV', `X_CT0 present (length: ${ct0.length})`);
    }

    ghaEndGroup();
    return valid;
}

// ─── Cookies ──────────────────────────────────────────────────────────────────

const rawCookies = [
    { domain: '.x.com', name: 'auth_token', value: process.env.X_AUTH_TOKEN, path: '/', secure: true, sameSite: 'Lax' },
    { domain: '.x.com', name: 'ct0',        value: process.env.X_CT0,        path: '/', secure: true, sameSite: 'Lax' }
];


// ─── Main ─────────────────────────────────────────────────────────────────────

async function getLatestTweet(username) {
    const totalTimer = timer();
    log('🚀', 'START', `Scraper starting for @${username}`);

    if (!validateEnv()) {
        ghaError('Aborting — required secrets are missing');
        process.exit(1);
    }

    // ── Browser ──────────────────────────────────────────────────────────────
    ghaGroup('🖥️  Browser Launch');
    const launchTimer = timer();
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process']
    });
    log('✅', 'BROWSER', `Launched in ${launchTimer()}`);
    ghaEndGroup();

    const page = await browser.newPage();

    // ── Network monitoring ────────────────────────────────────────────────────
    let reqTotal = 0, reqFailed = 0;

    // Collect m3u8 master playlist bodies keyed by videoId.
    // We use page.waitForResponse() inside a persistent listener pattern:
    // each time an m3u8 lands we read the body immediately (waitForResponse
    // handles this safely; raw response event handlers do not).
    const m3u8Bodies = new Map(); // videoId -> playlist text

    const collectM3u8 = () => {
        page.waitForResponse(
            res => res.url().includes('video.twimg.com') && res.url().includes('.m3u8'),
            { timeout: 60000 }
        ).then(async (res) => {
            const url = res.url();
            const m = url.match(/ext_tw_video\/(\d+)\//);
            const videoId = m ? m[1] : 'unknown';
            try {
                const body = await res.text();
                m3u8Bodies.set(videoId, { url, body });
                log('📋', 'M3U8', `Captured manifest for videoId=${videoId} (${body.length} chars): ${url}`);
            } catch (e) {
                log('⚠️', 'M3U8', `Could not read body for ${url}: ${e.message}`);
            }
            collectM3u8(); // re-arm for next m3u8
        }).catch(() => {}); // timeout or navigation — silently ignore
    };
    collectM3u8(); // arm before page loads

    page.on('response',      ()    => { reqTotal++; });
    page.on('requestfailed', (req) => {
        reqFailed++;
        log('🚫', 'BLOCKED', `${req.failure()?.errorText} — ${req.url().substring(0, 100)}`);
    });
    page.on('console', (msg) => {
        if (msg.type() === 'error') log('🖥️', 'PAGE_ERR', msg.text());
    });

    try {
        // ── Page load ────────────────────────────────────────────────────────
        ghaGroup(`🌐 Page Load — x.com/${username}`);
        await page.setCookie(...rawCookies);
        log('🍪', 'COOKIES', 'auth_token + ct0 injected');
        await page.setViewport({ width: 1280, height: 1000 });

        const navTimer = timer();
        await page.goto(`https://x.com/${username}`, { waitUntil: 'networkidle2' });
        log('✅', 'NAV', `Settled at ${page.url()} in ${navTimer()}`);

        const selectorTimer = timer();
        await page.waitForSelector('article', { timeout: 30000 });
        log('✅', 'DOM', `First <article> visible in ${selectorTimer()}`);
        ghaEndGroup();

        // ── Scrape ───────────────────────────────────────────────────────────
        ghaGroup('🔍 Scraping Tweets');
        const scrapeTimer = timer();

        const scrapeResult = await page.evaluate(async () => {
            const results = [];
            for (let scroll = 0; scroll < 3; scroll++) {
                const articles = Array.from(document.querySelectorAll('article'));
                articles.forEach(article => {
                    const timeEl   = article.querySelector('time');
                    const textEl   = article.querySelector('[data-testid="tweetText"]');
                    const isPinned = article.innerText.includes('Pinned');
                    const hasVideo = !!article.querySelector('[data-testid="videoPlayer"], video');

                    if (!timeEl) return;

                    let tweetText = '';
                    if (textEl) {
                        const processNode = (n) => {
                            n.childNodes.forEach(child => {
                                if (child.nodeType === Node.TEXT_NODE) tweetText += child.textContent;
                                else if (child.nodeName === 'IMG')       tweetText += child.alt || '';
                                else if (child.childNodes)               processNode(child);
                            });
                        };
                        processNode(textEl);
                    }

                    // Extract video ID from video element src, poster, or thumbnail img
                    let videoId = null;
                    if (hasVideo) {
                        const videoEl = article.querySelector('video');
                        const srcMatch    = (videoEl?.src    || '').match(/ext_tw_video\/(\d+)\//);
                        const posterMatch = (videoEl?.poster || '').match(/ext_tw_video_thumb\/(\d+)\//);
                        if (srcMatch)    videoId = srcMatch[1];
                        else if (posterMatch) videoId = posterMatch[1];
                        else {
                            for (const img of article.querySelectorAll('img')) {
                                const m = (img.src || '').match(/ext_tw_video_thumb\/(\d+)\//);
                                if (m) { videoId = m[1]; break; }
                            }
                        }
                    }

                    results.push({
                        text:     tweetText,
                        time:     timeEl.getAttribute('datetime'),
                        isPinned,
                        hasVideo,
                        videoId,
                        images:   Array.from(article.querySelectorAll('[data-testid="tweetPhoto"] img')).map(img => img.src)
                    });
                });
                window.scrollBy(0, 800);
                await new Promise(r => setTimeout(r, 1500));
            }

            const unique = results.filter((v, i, a) =>
                a.findIndex(t => t.time === v.time) === i
            );
            unique.sort((a, b) => new Date(b.time) - new Date(a.time));
            return unique;
        });

        log('📋', 'SCRAPE', `${scrapeResult.length} unique article(s) found in ${scrapeTimer()}`);
        scrapeResult.forEach((t, i) => {
            log(`  [${i}]`, 'ARTICLE',
                `time=${t.time} | pinned=${t.isPinned} | video=${t.hasVideo} | videoId=${t.videoId || 'none'} | ` +
                `images=${t.images.length} | text="${t.text.substring(0, 80).replace(/\n/g, ' ')}..."`
            );
        });

        const best = scrapeResult[0];
        if (!best) {
            ghaError('No tweets found after scraping — page may not have loaded correctly');
            ghaEndGroup();
            console.log(JSON.stringify({ error: 'No tweet found' }));
            return;
        }

        log('🏆', 'SELECTED', `time=${best.time} | video=${best.hasVideo} | videoId=${best.videoId || 'none'} | images=${best.images.length}`);
        ghaEndGroup();

        // ── Video download ────────────────────────────────────────────────────
        if (best.hasVideo) {
            ghaGroup('🎬 Video Download');
            const videoTimer = timer();

            if (!best.videoId) {
                ghaWarning('hasVideo=true but could not extract videoId from DOM — skipping video');
            } else {
                log('ℹ️', 'VIDEO', `Looking up m3u8 for videoId=${best.videoId} (collected: ${m3u8Bodies.size})`);
                m3u8Bodies.forEach((v, k) => log('  ·', 'VIDEO', `  cached: videoId=${k}`));

                const manifests = m3u8Bodies.get(best.videoId) || [];
                if (manifests.length === 0) {
                    ghaWarning(`No m3u8 cached for videoId=${best.videoId} — bot.py will use image fallback`);
                } else {
                    log('📋', 'VIDEO', `Captured ${manifests.length} manifest(s) for this videoId:`);
                    manifests.forEach((m, i) => log(`  [${i}]`, 'VIDEO', m.url));

                    // Master playlist contains #EXT-X-STREAM-INF; child playlists don't
                    const m3u8 = manifests.find(m => m.body.includes('#EXT-X-STREAM-INF')) || manifests[0];
                    log('📋', 'VIDEO', `Selected: ${m3u8.url} (isMaster=${m3u8.body.includes('#EXT-X-STREAM-INF')})`);

                    // Parse master playlist — find highest bandwidth child playlist
                    const lines = m3u8.body.split('\n').map(l => l.trim()).filter(Boolean);
                    log('📋', 'VIDEO', `Master playlist body:\n${m3u8.body}`);

                    const streams = [];
                    for (let i = 0; i < lines.length; i++) {
                        if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
                            const bwMatch  = lines[i].match(/BANDWIDTH=(\d+)/);
                            const resMatch = lines[i].match(/RESOLUTION=(\d+x\d+)/);
                            const childUrl = lines[i + 1];
                            if (childUrl && !childUrl.startsWith('#')) {
                                streams.push({
                                    bandwidth:  bwMatch  ? parseInt(bwMatch[1]) : 0,
                                    resolution: resMatch ? resMatch[1] : 'unknown',
                                    url: childUrl.startsWith('https://') ? childUrl : new URL(childUrl, m3u8.url).href
                                });
                            }
                        }
                    }

                    log('ℹ️', 'VIDEO', `Streams: ${streams.map(s => `${s.resolution}@${s.bandwidth}`).join(', ') || 'none'}`);

                    if (streams.length === 0) {
                        ghaWarning('No streams found in master playlist');
                    } else {
                        streams.sort((a, b) => b.bandwidth - a.bandwidth);
                        const best_stream = streams[0];
                        log('🏆', 'VIDEO', `Best stream: ${best_stream.resolution} @ ${best_stream.bandwidth} bps`);
                        log('⬇️', 'VIDEO', `Fetching child playlist: ${best_stream.url}`);

                        // Fetch child playlist via page.goto (auth cookies included)
                        try {
                            const childRes = await page.goto(best_stream.url, { waitUntil: 'networkidle0', timeout: 15000 });
                            const childBody = childRes ? await childRes.text() : null;
                            log('📋', 'VIDEO', `Child playlist body:
${childBody}`);

                            // Find the real .mp4?tag= URL
                            let videoUrl = null;
                            for (const line of (childBody || '').split('').map(l => l.trim())) {
                                if (!line.startsWith('#') && line.includes('.mp4')) {
                                    videoUrl = line.startsWith('https://') ? line : new URL(line, best_stream.url).href;
                                    break;
                                }
                            }

                            if (!videoUrl) {
                                ghaWarning('No .mp4 URL found in child playlist');
                            } else {
                                log('✅', 'VIDEO', `Resolved: ${videoUrl}`);
                                const dlTimer = timer();
                                const response = await page.goto(videoUrl, { waitUntil: 'networkidle0', timeout: 60000 });

                                if (!response || !response.ok()) {
                                    ghaError(`Video download HTTP ${response?.status()} — ${videoUrl}`);
                                } else {
                                    const buffer = await response.buffer();
                                    const sizeKb = (buffer.length / 1024).toFixed(1);
                                    if (buffer.length < 10000) {
                                        ghaWarning(`Response is only ${sizeKb} KB — likely an error page, not a video`);
                                        log('🔬', 'VIDEO', `First 300 bytes: ${buffer.slice(0, 300).toString('utf8')}`);
                                    } else {
                                        fs.writeFileSync('tweet_video.mp4', buffer);
                                        log('✅', 'VIDEO', `Saved tweet_video.mp4 — ${sizeKb} KB in ${dlTimer()}`);
                                        best.videoPath = 'tweet_video.mp4';
                                    }
                                }
                            }
                        } catch (e) {
                            ghaError(`Child playlist / video download threw: ${e.message}`);
                        }
                    }
                }
            }

            log('⏱️', 'VIDEO', `Video section total: ${videoTimer()}`);
            ghaEndGroup();
        }

        // ── Image download ────────────────────────────────────────────────────
        if (best.images.length > 0) {
            ghaGroup(`🖼️  Image Download (${best.images.length} image(s))`);
            for (let i = 0; i < best.images.length; i++) {
                const originalUrl = best.images[i];
                let highResUrl;
                if (originalUrl.includes('?')) {
                    const [base, params] = originalUrl.split('?');
                    const urlParams = new URLSearchParams(params);
                    urlParams.set('name', 'orig');
                    highResUrl = `${base}?${urlParams.toString()}`;
                } else {
                    highResUrl = `${originalUrl}?format=jpg&name=orig`;
                }

                log('⬇️', `IMG[${i}]`, highResUrl);
                const imgTimer = timer();
                try {
                    const response = await page.goto(highResUrl, { waitUntil: 'networkidle0', timeout: 15000 });
                    if (response && response.ok()) {
                        const buffer = await response.buffer();
                        fs.writeFileSync(`tweet_img_${i}.jpg`, buffer);
                        log('✅', `IMG[${i}]`, `Saved tweet_img_${i}.jpg — ${(buffer.length / 1024).toFixed(1)} KB in ${imgTimer()}`);
                    } else {
                        ghaError(`IMG[${i}]: HTTP ${response?.status()} — ${highResUrl}`);
                    }
                } catch (e) {
                    ghaError(`IMG[${i}]: ${e.message} — ${highResUrl}`);
                }
            }
            ghaEndGroup();
        }

        // ── Summary ──────────────────────────────────────────────────────────
        ghaGroup('📊 Run Summary');
        log('⏱️', 'TIMING', `Total elapsed: ${totalTimer()}`);
        log('🌐', 'NETWORK', `${reqTotal} responses, ${reqFailed} failed`);
        log('🎥', 'VIDEO',  `videoId=${best.videoId || 'none'} | videoPath=${best.videoPath || '(none)'}`);
        log('🖼️', 'IMAGES', `${best.images.length} image(s) in tweet`);
        log('📝', 'TEXT',   `${best.text.length} chars | "${best.text.substring(0, 100).replace(/\n/g, ' ')}..."`);
        ghaEndGroup();

        console.log(JSON.stringify(best));

    } catch (error) {
        ghaError(`Unhandled exception: ${error.message}`);
        log('💥', 'FATAL', error.stack || error.message);
        console.error(`{"error": "${error.message.replace(/"/g, '\\"')}"}`);
    } finally {
        await browser.close();
        log('🛑', 'DONE', `Browser closed — total: ${totalTimer()}`);
    }
}

getLatestTweet('FateGO_USA');