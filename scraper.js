process.stdout.setEncoding('utf8');
process.stderr.setEncoding('utf8');

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const https = require('https');
const http = require('http');

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

// ─── File downloader (avoids page.goto so we keep the tweet page open) ────────

function downloadFile(url, destPath, redirectDepth = 0) {
    if (redirectDepth > 5) return Promise.reject(new Error('Too many redirects'));
    return new Promise((resolve, reject) => {
        const proto = url.startsWith('https') ? https : http;
        const file = fs.createWriteStream(destPath);

        proto.get(url, (response) => {
            log('📡', 'HTTP', `${response.statusCode} ← ${url}`);

            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                file.close();
                fs.unlinkSync(destPath);
                log('↪️', 'REDIRECT', response.headers.location);
                downloadFile(response.headers.location, destPath, redirectDepth + 1).then(resolve).catch(reject);
                return;
            }
            if (response.statusCode !== 200) {
                file.close();
                fs.unlinkSync(destPath);
                reject(new Error(`HTTP ${response.statusCode} for ${url}`));
                return;
            }
            response.pipe(file);
            file.on('finish', () => {
                file.close(() => {
                    const bytes = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
                    log('💾', 'SAVE', `${destPath} — ${(bytes / 1024).toFixed(1)} KB`);
                    resolve();
                });
            });
        }).on('error', (err) => {
            fs.unlink(destPath, () => {});
            reject(err);
        });
    });
}

// ─── Video URL picker ─────────────────────────────────────────────────────────

function pickBestVideoUrl(urls, videoId) {
    log('🎬', 'VIDEO', `Ranking ${urls.length} candidate URL(s) | target videoId: ${videoId || '(unknown)'}`);
    urls.forEach((u, i) => log('  •', `URL[${i}]`, u));

    // Step 1: filter to the correct tweet's video using its ID (avoids picking
    // videos from other posts that scrolled into view during scraping)
    let candidates = urls;
    if (videoId) {
        const byId = urls.filter(u => u.includes(`/${videoId}/`));
        if (byId.length > 0) {
            log('🔍', 'VIDEO', `Filtered to ${byId.length} URL(s) matching videoId ${videoId}`);
            candidates = byId;
        } else {
            ghaWarning(`No URLs matched videoId ${videoId} — using all candidates`);
        }
    }

    // Step 2: drop audio-only tracks (/aud/mp4a/) — keep only video tracks
    const videoOnly = candidates.filter(u => !u.includes('/aud/mp4a/'));
    if (videoOnly.length > 0) {
        log('🎞️', 'VIDEO', `Dropped ${candidates.length - videoOnly.length} audio-only track(s)`);
        candidates = videoOnly;
    } else {
        ghaWarning('No video-track URLs after filtering audio — keeping audio tracks as fallback');
    }

    // Step 3: prefer real video over animated GIFs (/tweet_video/)
    const mainVideos = candidates.filter(u => !u.includes('/tweet_video/'));
    if (mainVideos.length > 0) {
        candidates = mainVideos;
    } else {
        ghaWarning('Only animated GIF (tweet_video) URLs remain — using those as fallback');
    }

    // Step 4: rank by resolution (highest pixel area wins)
    const ranked = [...candidates].sort((a, b) => {
        const matchA = a.match(/(\d{3,4})x(\d{3,4})/);
        const matchB = b.match(/(\d{3,4})x(\d{3,4})/);
        const areaA = matchA ? parseInt(matchA[1]) * parseInt(matchA[2]) : 0;
        const areaB = matchB ? parseInt(matchB[1]) * parseInt(matchB[2]) : 0;
        return areaB - areaA;
    });

    log('🏆', 'VIDEO', `Best URL selected: ${ranked[0]}`);
    return ranked[0];
}

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
    const capturedVideoUrls = new Set();
    let reqTotal = 0, reqFailed = 0;

    // Capture both .m3u8 manifests (contain the real full-file URLs)
    // and .mp4 chunks (fallback if manifest parsing fails)
    const capturedM3u8Urls = new Set();

    page.on('response', async (response) => {
        reqTotal++;
        const url = response.url();
        if (!url.includes('video.twimg.com')) return;

        if (url.includes('.m3u8')) {
            capturedM3u8Urls.add(url);
            log('📋', 'INTERCEPT', `M3U8 manifest captured (${capturedM3u8Urls.size} total): ${url}`);
            // Eagerly parse the playlist to extract real video URLs
            try {
                const text = await response.text();
                const lines = text.split('\n');
                lines.forEach(line => {
                    line = line.trim();
                    // Real video lines: full https URL or relative path ending in .mp4?tag=
                    if (line.startsWith('https://') && line.includes('.mp4')) {
                        capturedVideoUrls.add(line);
                        log('🎥', 'M3U8_PARSE', `Real video URL found: ${line}`);
                    } else if (line.endsWith('.mp4') || line.includes('.mp4?')) {
                        // Relative URL — make absolute using the manifest base
                        try {
                            const abs = new URL(line, url).href;
                            capturedVideoUrls.add(abs);
                            log('🎥', 'M3U8_PARSE', `Real video URL (resolved): ${abs}`);
                        } catch {}
                    }
                });
            } catch (e) {
                log('⚠️', 'M3U8_PARSE', `Could not read manifest body: ${e.message}`);
            }
        } else if (url.includes('.mp4') && !url.match(/\/\d+\/\d+\/[^/]+\.mp4/)) {
            // Only capture .mp4 URLs that do NOT have the HLS chunk pattern (/0/0/ etc.)
            capturedVideoUrls.add(url);
            log('🎥', 'INTERCEPT', `MP4 captured (${capturedVideoUrls.size} total): ${url}`);
        }
    });

    page.on('requestfailed', (req) => {
        reqFailed++;
        log('🚫', 'BLOCKED', `${req.failure()?.errorText} — ${req.url().substring(0, 100)}`);
    });

    page.on('console', (msg) => {
        if (msg.type() === 'error') {
            log('🖥️', 'PAGE_ERR', msg.text());
        }
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

                    // Extract video ID from the video player src or thumbnail URL.
                    // Thumbnails use pattern: ext_tw_video_thumb/{VIDEO_ID}/
                    // Video player <video> src uses: ext_tw_video/{VIDEO_ID}/
                    let videoId = null;
                    if (hasVideo) {
                        const videoEl = article.querySelector('video');
                        if (videoEl && videoEl.src) {
                            const m = videoEl.src.match(/ext_tw_video\/(\d+)\//);
                            if (m) videoId = m[1];
                        }
                        // Fallback: read ID from the poster/thumbnail attribute
                        if (!videoId && videoEl && videoEl.poster) {
                            const m = videoEl.poster.match(/ext_tw_video_thumb\/(\d+)\//);
                            if (m) videoId = m[1];
                        }
                        // Fallback: read from any img src in the article that looks like a video thumb
                        if (!videoId) {
                            const imgs = Array.from(article.querySelectorAll('img'));
                            for (const img of imgs) {
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
                `time=${t.time} | pinned=${t.isPinned} | video=${t.hasVideo} | ` +
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

        log('🏆', 'SELECTED', `time=${best.time} | video=${best.hasVideo} | images=${best.images.length}`);
        ghaEndGroup();

        // ── Video ────────────────────────────────────────────────────────────
        if (best.hasVideo) {
            ghaGroup('🎬 Video Download');
            log('ℹ️', 'VIDEO', `${capturedVideoUrls.size} MP4 URL(s) intercepted so far`);

            const tryDownload = async (label) => {
                if (capturedVideoUrls.size === 0) {
                    ghaWarning(`${label}: no MP4 URLs available yet`);
                    return false;
                }
                log('ℹ️', 'VIDEO', `Tweet videoId: ${best.videoId || '(not detected)'}`);
                const bestUrl = pickBestVideoUrl(Array.from(capturedVideoUrls), best.videoId);
                const dlTimer = timer();
                try {
                    // Use page.goto() so Twitter's auth cookies are sent with the request.
                    // Plain https.get() has no cookies and gets a redirect/error page (~1 KB)
                    // instead of the actual video.
                    log('⬇️', 'VIDEO', `Fetching via browser (with cookies): ${bestUrl}`);
                    const response = await page.goto(bestUrl, { waitUntil: 'networkidle0', timeout: 30000 });
                    if (!response || !response.ok()) {
                        ghaError(`${label}: HTTP ${response?.status()} — ${bestUrl}`);
                        return false;
                    }
                    const buffer = await response.buffer();
                    const sizeKb = (buffer.length / 1024).toFixed(1);
                    log('ℹ️', 'VIDEO', `Response size: ${sizeKb} KB`);
                    if (buffer.length < 10000) {
                        // Suspiciously small — log first 200 bytes as text to diagnose
                        ghaWarning(`${label}: file is only ${sizeKb} KB — may be an error response`);
                        log('🔬', 'VIDEO', `First 200 bytes: ${buffer.slice(0, 200).toString('utf8', 0, 200)}`);
                        return false;
                    }
                    fs.writeFileSync('tweet_video.mp4', buffer);
                    log('💾', 'VIDEO', `Saved tweet_video.mp4 — ${sizeKb} KB`);
                    log('✅', 'VIDEO', `${label} succeeded in ${dlTimer()}`);
                    best.videoPath = 'tweet_video.mp4';
                    return true;
                } catch (e) {
                    ghaError(`${label} failed: ${e.message}`);
                    return false;
                }
            };

            let ok = await tryDownload('Passive intercept');

            if (!ok) {
                log('🔄', 'VIDEO', 'Clicking player to trigger stream URL...');
                try {
                    await page.click('[data-testid="videoPlayer"]');
                    log('✅', 'VIDEO', 'Click sent — waiting 4s...');
                    await new Promise(r => setTimeout(r, 4000));
                    log('ℹ️', 'VIDEO', `MP4 URLs after click: ${capturedVideoUrls.size}`);
                    ok = await tryDownload('Post-click intercept');
                } catch (e) {
                    ghaError(`Player click threw: ${e.message}`);
                }
            }

            if (!ok) {
                ghaWarning('Video download failed — bot.py will fall back to thumbnail/image');
            }
            ghaEndGroup();
        }

        // ── Images ───────────────────────────────────────────────────────────
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
        log('🎥', 'VIDEO', `${capturedVideoUrls.size} real video URL(s) | ${capturedM3u8Urls.size} M3U8 manifest(s) | videoPath: ${best.videoPath || '(none)'}`);
        log('🖼️', 'IMAGES', `${best.images.length} image(s) in tweet`);
        log('📝', 'TEXT', `${best.text.length} chars | "${best.text.substring(0, 100).replace(/\n/g, ' ')}..."`);
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