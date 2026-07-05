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
    process.stderr.write(`[${ts()}] [${icon}] [${tag}] ${msg}\n`);
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
    ghaGroup('[AUTH] Environment Validation');
    const authToken = process.env.X_AUTH_TOKEN;
    const ct0 = process.env.X_CT0;
    let valid = true;

    if (!authToken) {
        ghaError('X_AUTH_TOKEN secret is missing or empty');
        valid = false;
    } else {
        log('[OK]', 'ENV', `X_AUTH_TOKEN present (length: ${authToken.length})`);
    }

    if (!ct0) {
        ghaError('X_CT0 secret is missing or empty');
        valid = false;
    } else {
        log('[OK]', 'ENV', `X_CT0 present (length: ${ct0.length})`);
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
    log('[START]', 'START', `Scraper starting for @${username}`);

    if (!validateEnv()) {
        ghaError('Aborting — required secrets are missing');
        process.exit(1);
    }

    // ── Browser ──────────────────────────────────────────────────────────────
    ghaGroup('[BROWSER] Browser Launch');
    const launchTimer = timer();
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process']
    });
    log('[OK]', 'BROWSER', `Launched in ${launchTimer()}`);
    ghaEndGroup();

    const page = await browser.newPage();

    // ── Network monitoring ────────────────────────────────────────────────────
    let reqTotal = 0, reqFailed = 0;

    // Collect m3u8 master playlist bodies keyed by videoId.
    // We use page.waitForResponse() inside a persistent listener pattern:
    // each time an m3u8 lands we read the body immediately (waitForResponse
    // handles this safely; raw response event handlers do not).
    const m3u8Bodies = new Map(); // videoId -> array of { url, body }
    const m3u8Logs = [];          // Buffer for our background logs

    page.on('response', async (res) => {
        const url = res.url();
        // Only process relevant requests to save performance
        if (url.includes('video.twimg.com') && url.includes('.m3u8')) {
            const m = url.match(/ext_tw_video\/(\d+)\//);
            const videoId = m ? m[1] : 'unknown';
            try {
                const body = await res.text();
                if (!m3u8Bodies.has(videoId)) m3u8Bodies.set(videoId, []);
                m3u8Bodies.get(videoId).push({ url, body });
                
                // Push to buffer instead of logging immediately
                m3u8Logs.push({ icon: '[MANIFEST]', tag: 'M3U8', msg: `Captured manifest for videoId=${videoId} (${body.length} chars): ${url}` });
            } catch (e) {
                m3u8Logs.push({ icon: '[WARN]', tag: 'M3U8', msg: `Could not read body for ${url}: ${e.message}` });
            }
        }
    });

    page.on('response',      ()    => { reqTotal++; });
    page.on('requestfailed', (req) => {
        reqFailed++;
        log('[BLOCKED]', 'BLOCKED', `${req.failure()?.errorText} — ${req.url().substring(0, 100)}`);
    });
    page.on('console', (msg) => {
        if (msg.type() === 'error') log('[PAGE_ERR]', 'PAGE_ERR', msg.text());
    });

    try {
        // ── Page load ────────────────────────────────────────────────────────
        ghaGroup(`[NAV] Page Load — x.com/${username}`);
        await page.setCookie(...rawCookies);
        log('[COOKIES]', 'COOKIES', 'auth_token + ct0 injected');
        await page.setViewport({ width: 1280, height: 1000 });

        const navTimer = timer();
        await page.goto(`https://x.com/${username}`, { waitUntil: 'networkidle2' });
        log('[OK]', 'NAV', `Settled at ${page.url()} in ${navTimer()}`);

        const selectorTimer = timer();
        await page.waitForSelector('article', { timeout: 30000 });
        log('[OK]', 'DOM', `First <article> visible in ${selectorTimer()}`);
        ghaEndGroup();

        // ── Scrape ───────────────────────────────────────────────────────────
        ghaGroup('[SCRAPE] Scraping Tweets');
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

                    // Collect unique image URLs (dedupe)
                    const imageSet = new Set();
                    article.querySelectorAll('[data-testid="tweetPhoto"] img').forEach(img => {
                        if (img.src) imageSet.add(img.src);
                    });

                    // For video posts with no tweetPhoto images, grab the video poster/thumbnail.
                    // Twitter puts the thumbnail as the <video poster="..."> attribute or as
                    // a preview image inside the video player container.
                    if (imageSet.size === 0 && hasVideo) {
                        const videoEl = article.querySelector('video');
                        if (videoEl?.poster) {
                            imageSet.add(videoEl.poster);
                        } else {
                            // Try player preview images
                            const playerImgs = article.querySelectorAll('[data-testid="videoPlayer"] img, [data-testid="previewInterstitial"] img');
                            playerImgs.forEach(img => { if (img.src) imageSet.add(img.src); });
                        }
                    }
                    
                    results.push({
                        text:     tweetText,
                        time:     timeEl.getAttribute('datetime'),
                        isPinned,
                        hasVideo,
                        videoId,
                        images:   Array.from(imageSet)
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

        // Wait for m3u8 manifests triggered during scrolling to arrive
        log('[SCRAPE]', 'Waiting for m3u8 manifests to settle (2s)...');
        await new Promise(resolve => setTimeout(resolve, 2000));

        log('[SCRAPE]', 'SCRAPE', `${scrapeResult.length} unique article(s) found in ${scrapeTimer()}`);
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

        log('[SELECTED]', 'SELECTED', `time=${best.time} | video=${best.hasVideo} | videoId=${best.videoId || 'none'} | images=${best.images.length}`);
        ghaEndGroup();

        // ── FLUSH BACKGROUND LOGS HERE ────────────────────────────────────────
        if (m3u8Logs.length > 0) {
            ghaGroup('[NETWORK] Network: M3U8 Manifests');
            m3u8Logs.forEach(l => log(l.icon, l.tag, l.msg));
            ghaEndGroup();
        }

        // ── Video download ────────────────────────────────────────────────────
        log('[INFO]', 'VIDEO', `hasVideo=${best.hasVideo}`);

        if (best.hasVideo) {
            ghaGroup('[VIDEO] Video Download');
            const videoTimer = timer();

            if (!best.videoId) {
                ghaWarning('hasVideo=true but could not extract videoId from DOM — skipping video');
            } else {
                log('[INFO]', 'VIDEO', `Looking up m3u8 for videoId=${best.videoId} (collected: ${m3u8Bodies.size})`);
                m3u8Bodies.forEach((v, k) => log('  ·', 'VIDEO', `  cached: videoId=${k}`));

                const manifests = m3u8Bodies.get(best.videoId) || [];
                if (manifests.length === 0) {
                    log('[WARN]', 'VIDEO', `No m3u8 cached for videoId=${best.videoId} — bot.py will use image fallback`);
                } else {
                    log('[MANIFEST]', 'VIDEO', `Captured ${manifests.length} manifest(s) for this videoId:`);
                    manifests.forEach((m, i) => log(`  [${i}]`, 'VIDEO', m.url));

                    // Master playlist contains #EXT-X-STREAM-INF; child playlists don't
                    const m3u8 = manifests.find(m => m.body.includes('#EXT-X-STREAM-INF')) || manifests[0];
                    log('[MANIFEST]', 'VIDEO', `Selected: ${m3u8.url} (isMaster=${m3u8.body.includes('#EXT-X-STREAM-INF')})`);

                    // Parse master playlist — find highest bandwidth child playlist
                    const lines = m3u8.body.split('\n').map(l => l.trim()).filter(Boolean);
                    log('[MANIFEST]', 'VIDEO', `Master playlist body:\n${m3u8.body}`);

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

                    log('[INFO]', 'VIDEO', `Streams: ${streams.map(s => `${s.resolution}@${s.bandwidth}`).join(', ') || 'none'}`);

                    // Child playlist URLs are signed/tokenized (hash in filename) so they
                    // don't require auth cookies — plain https.get() works fine.
                    // Use cache if Chrome already fetched it, otherwise fetch directly.
                    streams.sort((a, b) => b.bandwidth - a.bandwidth);
                    const best_stream = streams[0];
                    log('[BEST]', 'VIDEO', `Best stream: ${best_stream.resolution} @ ${best_stream.bandwidth} bps → ${best_stream.url}`);

                    if (true) {
                        try {
                            const cachedChild = manifests.find(m => m.url === best_stream.url);
                            const childBody = await (cachedChild ? (
                                log('[OK]', 'VIDEO', 'Child playlist found in cache'),
                                Promise.resolve(cachedChild.body)
                            ) : new Promise((resolve, reject) => {
                                log('[DOWNLOAD]', 'VIDEO', `Fetching child playlist via https: ${best_stream.url}`);
                                const https = require('https');
                                let data = '';
                                const req = https.get(best_stream.url, res => {
                                    log('[NETWORK]', 'VIDEO', `Child playlist HTTP ${res.statusCode}`);
                                    res.on('data', chunk => { data += chunk; });
                                    res.on('end', () => resolve(data));
                                });
                                req.on('error', reject);
                                req.setTimeout(10000, () => { req.destroy(); reject(new Error('Child playlist fetch timed out')); });
                            }));

                            log('[MANIFEST]', 'VIDEO', `Child playlist body:\n${childBody}`);

                            // Compute total video duration from #EXTINF tags
                            const totalDuration = (childBody || '').split('\n')
                                .map(l => l.trim())
                                .filter(l => l.startsWith('#EXTINF:'))
                                .reduce((sum, l) => sum + parseFloat(l.replace('#EXTINF:', '').replace(',', '')), 0);
                            log('[TIME]', 'VIDEO', `Video duration: ${totalDuration.toFixed(2)}s`);

                            if (totalDuration <= 10) {
                                log('[INFO]', 'VIDEO', `Duration ≤10s — skipping video download, thumbnail will be used instead`);
                            } else {

                            // The real video file URL is in #EXT-X-MAP:URI
                            let videoUrl = null;
                            for (const line of (childBody || '').split('\n').map(l => l.trim())) {
                                const mapMatch = line.match(/^#EXT-X-MAP:URI="([^"]+\.mp4[^"]*)"/);
                                if (mapMatch) {
                                    const uri = mapMatch[1];
                                    videoUrl = uri.startsWith('https://') ? uri : new URL(uri, best_stream.url).href;
                                    log('[OK]', 'VIDEO', `Found EXT-X-MAP URI: ${videoUrl}`);
                                    break;
                                }
                            }

                            if (!videoUrl) {
                                ghaWarning('No #EXT-X-MAP .mp4 URI found in child playlist');
                            } else {
                                const { execFile } = require('child_process');
                                const ffmpegPath = require('ffmpeg-static');
                                log('[FFMPEG]', 'FFMPEG', `Using binary: ${ffmpegPath}`);

                                const fetchUrl = (url) => new Promise((resolve, reject) => {
                                    const https = require('https');
                                    const chunks = [];
                                    const req = https.get(url, res => {
                                        if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}: ${url}`)); return; }
                                        res.on('data', c => chunks.push(c));
                                        res.on('end', () => resolve(Buffer.concat(chunks)));
                                    });
                                    req.on('error', reject);
                                    req.setTimeout(30000, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
                                });

                                const downloadTrack = async (playlistBody, label) => {
                                    let initUrl = null;
                                    const segUrls = [];
                                    for (const line of playlistBody.split('\n').map(l => l.trim())) {
                                        const mapMatch = line.match(/^#EXT-X-MAP:URI="([^"]+)"/);
                                        if (mapMatch) {
                                            const u = mapMatch[1];
                                            initUrl = u.startsWith('https://') ? u : `https://video.twimg.com${u}`;
                                        } else if (!line.startsWith('#') && line.includes('.m4s')) {
                                            segUrls.push(line.startsWith('https://') ? line : `https://video.twimg.com${line}`);
                                        }
                                    }
                                    const allUrls = initUrl ? [initUrl, ...segUrls] : segUrls;
                                    log('[INFO]', label, `${allUrls.length} segment(s) to download`);
                                    const buffers = [];
                                    for (let i = 0; i < allUrls.length; i++) {
                                        buffers.push(await fetchUrl(allUrls[i]));
                                        if (i % 5 === 0) log('[INFO]', label, `${i + 1}/${allUrls.length} done`);
                                    }
                                    log('[OK]', label, 'All segments downloaded');
                                    return Buffer.concat(buffers);
                                };

                                const dlTimer = timer();
                                try {
                                    log('[DOWNLOAD]', 'VIDEO', 'Downloading video track...');
                                    const videoBuffer = await downloadTrack(childBody, 'VID');
                                    fs.writeFileSync('tweet_video_raw.mp4', videoBuffer);
                                    log('[OK]', 'VIDEO', `Raw video: ${(videoBuffer.length / 1024).toFixed(1)} KB`);

                                    const audioGroups = [];
                                    for (const match of m3u8.body.matchAll(/GROUP-ID="audio-(\d+)",AUTOSELECT=YES,URI="([^"]+)"/g)) {
                                        audioGroups.push({ bitrate: parseInt(match[1]), uri: match[2] });
                                    }
                                    audioGroups.sort((a, b) => b.bitrate - a.bitrate);
                                    log('[INFO]', 'AUDIO', `Audio groups: ${audioGroups.map(g => g.bitrate).join(', ')} bps`);

                                    if (audioGroups.length > 0) {
                                        const audioUri = audioGroups[0].uri;
                                        const audioPlaylistUrl = audioUri.startsWith('https://') ? audioUri : `https://video.twimg.com${audioUri}`;
                                        log('[DOWNLOAD]', 'AUDIO', `Playlist (${audioGroups[0].bitrate} bps): ${audioPlaylistUrl}`);
                                        const cachedAudio = manifests.find(m => m.url === audioPlaylistUrl);
                                        const audioBody = cachedAudio ? cachedAudio.body : (await fetchUrl(audioPlaylistUrl)).toString();
                                        log('[INFO]', 'AUDIO', cachedAudio ? 'Using cached playlist' : 'Fetched playlist');
                                        const audioBuffer = await downloadTrack(audioBody, 'AUD');
                                        fs.writeFileSync('tweet_audio_raw.mp4', audioBuffer);
                                        log('[OK]', 'AUDIO', `Raw audio: ${(audioBuffer.length / 1024).toFixed(1)} KB`);

                                        // -fflags +genpts regenerates timestamps so ffmpeg computes real duration
                                        log('[FFMPEG]', 'FFMPEG', 'Muxing...');
                                        await new Promise((resolve, reject) => {
                                            execFile(ffmpegPath, [
                                                '-y',
                                                '-fflags', '+genpts',
                                                '-i', 'tweet_video_raw.mp4',
                                                '-i', 'tweet_audio_raw.mp4',
                                                '-map', '0:v:0',
                                                '-map', '1:a:0',
                                                '-c:v', 'copy',
                                                '-c:a', 'aac',
                                                '-b:a', '128k',
                                                '-movflags', '+faststart',
                                                'tweet_video.mp4'
                                            ], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
                                                // Always log ffmpeg tail so we can see duration line
                                                log('[FFMPEG]', 'FFMPEG', stderr.slice(-600));
                                                if (err) { ghaError(`ffmpeg failed: ${err.message}`); reject(err); }
                                                else { log('[OK]', 'FFMPEG', 'Mux complete'); resolve(); }
                                            });
                                        });
                                        fs.unlinkSync('tweet_video_raw.mp4');
                                        fs.unlinkSync('tweet_audio_raw.mp4');
                                    } else {
                                        ghaWarning('No audio groups — using video-only');
                                        fs.renameSync('tweet_video_raw.mp4', 'tweet_video.mp4');
                                    }

                                    const finalSize = (fs.statSync('tweet_video.mp4').size / 1024).toFixed(1);
                                    log('[OK]', 'VIDEO', `Saved tweet_video.mp4 — ${finalSize} KB in ${dlTimer()}`);
                                    best.videoPath = 'tweet_video.mp4';
                                    // Pass resolution so bot.py can set correct aspect ratio without ffprobe
                                    const resParts = best_stream.resolution.split('x');
                                    if (resParts.length === 2) {
                                        best.videoWidth  = parseInt(resParts[0]);
                                        best.videoHeight = parseInt(resParts[1]);
                                        log('[DIMS]', 'VIDEO', `Resolution: ${best.videoWidth}x${best.videoHeight}`);
                                    }

                                } catch (e) {
                                    ghaError(`Video/audio download or mux failed: ${e.message}`);
                                    for (const f of ['tweet_video_raw.mp4', 'tweet_audio_raw.mp4']) {
                                        try { fs.unlinkSync(f); } catch {}
                                    }
                                }
                            } // end duration > 10 else block
                            }
                        } catch (e) {
                            ghaError(`Child playlist / video download threw: ${e.message}`);
                        }
                    }
                }
            }

            log('[TIME]', 'VIDEO', `Video section total: ${videoTimer()}`);
            ghaEndGroup();
        }

        // ── Image download ────────────────────────────────────────────────────
        if (best.images.length > 0) {
            ghaGroup(`[IMG] Image Download (${best.images.length} image(s))`);
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

                log('[DOWNLOAD]', `IMG[${i}]`, highResUrl);
                const imgTimer = timer();
                try {
                    const response = await page.goto(highResUrl, { waitUntil: 'networkidle0', timeout: 15000 });
                    if (response && response.ok()) {
                        const buffer = await response.buffer();
                        fs.writeFileSync(`tweet_img_${i}.jpg`, buffer);
                        log('[OK]', `IMG[${i}]`, `Saved tweet_img_${i}.jpg — ${(buffer.length / 1024).toFixed(1)} KB in ${imgTimer()}`);
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
        ghaGroup('[SUMMARY] Run Summary');
        log('[TIME]', 'TIMING', `Total elapsed: ${totalTimer()}`);
        log('[NETWORK]', 'NETWORK', `${reqTotal} responses, ${reqFailed} failed`);
        log('[VIDEO]', 'VIDEO',  `videoId=${best.videoId || 'none'} | videoPath=${best.videoPath || '(none)'}`);
        log('[IMG]', 'IMAGES', `${best.images.length} image(s) in tweet`);
        log('[TEXT]', 'TEXT',   `${best.text.length} chars | "${best.text.substring(0, 100).replace(/\n/g, ' ')}..."`);
        ghaEndGroup();

        console.log(JSON.stringify(best));

    } catch (error) {
        ghaError(`Unhandled exception: ${error.message}`);
        log('[FATAL]', 'FATAL', error.stack || error.message);
        console.error(`{"error": "${error.message.replace(/"/g, '\\"')}"}`);
    } finally {
        // Race browser.close against a short deadline so the process always exits cleanly.
        try {
            await Promise.race([
                browser.close(),
                new Promise(resolve => setTimeout(resolve, 6000))
            ]);
        } catch (e) {
            log('[WARN]', 'BROWSER', `Error during close: ${e.message}`);
        }
        log('[DONE]', 'DONE', `Browser closed — total: ${totalTimer()}`);
        // Force-exit in case lingering async response listeners are keeping the event loop alive after the browser is gone.
        process.exit(0);
    }
}

getLatestTweet('FateGO_USA');