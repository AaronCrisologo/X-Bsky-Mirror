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
    const m3u8Bodies = new Map(); // videoId -> array of { url, body }

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
                if (!m3u8Bodies.has(videoId)) m3u8Bodies.set(videoId, []);
                m3u8Bodies.get(videoId).push({ url, body });
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

                    // Child playlist URLs are signed/tokenized (hash in filename) so they
                    // don't require auth cookies — plain https.get() works fine.
                    // Use cache if Chrome already fetched it, otherwise fetch directly.
                    streams.sort((a, b) => b.bandwidth - a.bandwidth);
                    const best_stream = streams[0];
                    log('🏆', 'VIDEO', `Best stream: ${best_stream.resolution} @ ${best_stream.bandwidth} bps → ${best_stream.url}`);

                    if (true) {
                        try {
                            const cachedChild = manifests.find(m => m.url === best_stream.url);
                            const childBody = await (cachedChild ? (
                                log('✅', 'VIDEO', 'Child playlist found in cache'),
                                Promise.resolve(cachedChild.body)
                            ) : new Promise((resolve, reject) => {
                                log('⬇️', 'VIDEO', `Fetching child playlist via https: ${best_stream.url}`);
                                const https = require('https');
                                let data = '';
                                const req = https.get(best_stream.url, res => {
                                    log('📡', 'VIDEO', `Child playlist HTTP ${res.statusCode}`);
                                    res.on('data', chunk => { data += chunk; });
                                    res.on('end', () => resolve(data));
                                });
                                req.on('error', reject);
                                req.setTimeout(10000, () => { req.destroy(); reject(new Error('Child playlist fetch timed out')); });
                            }));

                            log('📋', 'VIDEO', `Child playlist body:\n${childBody}`);

                            // The real video file URL is in #EXT-X-MAP:URI
                            let videoUrl = null;
                            for (const line of (childBody || '').split('\n').map(l => l.trim())) {
                                const mapMatch = line.match(/^#EXT-X-MAP:URI="([^"]+\.mp4[^"]*)"/);
                                if (mapMatch) {
                                    const uri = mapMatch[1];
                                    videoUrl = uri.startsWith('https://') ? uri : new URL(uri, best_stream.url).href;
                                    log('✅', 'VIDEO', `Found EXT-X-MAP URI: ${videoUrl}`);
                                    break;
                                }
                            }

                            if (!videoUrl) {
                                ghaWarning('No #EXT-X-MAP .mp4 URI found in child playlist');
                            } else {
                                // Download video segments AND audio segments separately, then mux with ffmpeg.
                                // Twitter uses CMAF: init segment (~1KB) + .m4s chunks per track.

                                const { execFile } = require('child_process');

                                // Helper: fetch a URL and return a Buffer
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

                                // Helper: download all segments from a playlist body and concatenate
                                const downloadTrack = async (playlistBody, playlistUrl, label) => {
                                    const segUrls = [];
                                    let initUrl = null;
                                    for (const line of playlistBody.split('\n').map(l => l.trim())) {
                                        const mapMatch = line.match(/^#EXT-X-MAP:URI="([^"]+)"/);
                                        if (mapMatch) {
                                            const u = mapMatch[1];
                                            initUrl = u.startsWith('https://') ? u : `https://video.twimg.com${u}`;
                                        } else if (!line.startsWith('#') && (line.includes('.m4s') || line.includes('.mp4'))) {
                                            segUrls.push(line.startsWith('https://') ? line : `https://video.twimg.com${line}`);
                                        }
                                    }
                                    const allUrls = initUrl ? [initUrl, ...segUrls] : segUrls;
                                    log('ℹ️', label, `${allUrls.length} segment(s) to download`);
                                    const buffers = [];
                                    for (let i = 0; i < allUrls.length; i++) {
                                        const buf = await fetchUrl(allUrls[i]);
                                        buffers.push(buf);
                                        if (i % 5 === 0) log('ℹ️', label, `${i + 1}/${allUrls.length} done`);
                                    }
                                    log('✅', label, `All segments downloaded`);
                                    return Buffer.concat(buffers);
                                };

                                const dlTimer = timer();
                                try {
                                    // ── Video track ───────────────────────────────────────────────
                                    log('⬇️', 'VIDEO', 'Downloading video track...');
                                    const videoBuffer = await downloadTrack(childBody, best_stream.url, 'VID');

                                    // ── Audio track ───────────────────────────────────────────────
                                    // Find the audio playlist URL from the master — pick highest bitrate
                                    const audioMatch = m3u8.body.match(/GROUP-ID="audio-(\d+)"[^\n]*\nURIs?="([^"]+)"/s) ||
                                                       m3u8.body.match(/URI="([^"]+mp4a[^"]+\.m3u8)"/);
                                    
                                    // Parse all audio groups and pick highest bitrate
                                    const audioGroups = [];
                                    for (const match of m3u8.body.matchAll(/GROUP-ID="audio-(\d+)",AUTOSELECT=YES,URI="([^"]+)"/g)) {
                                        audioGroups.push({ bitrate: parseInt(match[1]), uri: match[2] });
                                    }
                                    audioGroups.sort((a, b) => b.bitrate - a.bitrate);
                                    log('ℹ️', 'AUDIO', `Audio groups: ${audioGroups.map(g => g.bitrate).join(', ')} bps`);

                                    let audioBuffer = null;
                                    if (audioGroups.length > 0) {
                                        const audioUri = audioGroups[0].uri;
                                        const audioPlaylistUrl = audioUri.startsWith('https://') ? audioUri : `https://video.twimg.com${audioUri}`;
                                        log('⬇️', 'AUDIO', `Fetching audio playlist (${audioGroups[0].bitrate} bps): ${audioPlaylistUrl}`);

                                        // Check cache first
                                        const cachedAudio = manifests.find(m => m.url === audioPlaylistUrl);
                                        const audioPlaylistBody = cachedAudio ? cachedAudio.body : await fetchUrl(audioPlaylistUrl).then(b => b.toString());
                                        log('ℹ️', 'AUDIO', cachedAudio ? 'Using cached audio playlist' : 'Fetched audio playlist');

                                        log('⬇️', 'AUDIO', 'Downloading audio track...');
                                        audioBuffer = await downloadTrack(audioPlaylistBody, audioPlaylistUrl, 'AUD');
                                    } else {
                                        ghaWarning('No audio groups found in master playlist — video will be silent');
                                    }

                                    // ── Write raw tracks ──────────────────────────────────────────
                                    fs.writeFileSync('tweet_video_raw.mp4', videoBuffer);
                                    log('✅', 'VIDEO', `Raw video: ${(videoBuffer.length / 1024).toFixed(1)} KB`);

                                    if (audioBuffer) {
                                        fs.writeFileSync('tweet_audio_raw.mp4', audioBuffer);
                                        log('✅', 'AUDIO', `Raw audio: ${(audioBuffer.length / 1024).toFixed(1)} KB`);

                                        // ── Mux with ffmpeg ───────────────────────────────────────
                                        log('🎞️', 'FFMPEG', 'Muxing video + audio...');
                                        await new Promise((resolve, reject) => {
                                            execFile('ffmpeg', [
                                                '-y',
                                                '-i', 'tweet_video_raw.mp4',
                                                '-i', 'tweet_audio_raw.mp4',
                                                '-c', 'copy',
                                                '-movflags', '+faststart',
                                                'tweet_video.mp4'
                                            ], (err, stdout, stderr) => {
                                                if (err) {
                                                    ghaError(`ffmpeg failed: ${err.message}`);
                                                    log('🔬', 'FFMPEG', stderr.slice(-500));
                                                    reject(err);
                                                } else {
                                                    log('✅', 'FFMPEG', 'Mux complete');
                                                    resolve();
                                                }
                                            });
                                        });

                                        // Cleanup raw tracks
                                        fs.unlinkSync('tweet_video_raw.mp4');
                                        fs.unlinkSync('tweet_audio_raw.mp4');
                                    } else {
                                        // No audio — just use video track as-is
                                        fs.renameSync('tweet_video_raw.mp4', 'tweet_video.mp4');
                                    }

                                    const finalSize = (fs.statSync('tweet_video.mp4').size / 1024).toFixed(1);
                                    log('✅', 'VIDEO', `Saved tweet_video.mp4 — ${finalSize} KB in ${dlTimer()}`);
                                    best.videoPath = 'tweet_video.mp4';

                                } catch (e) {
                                    ghaError(`Video/audio download or mux failed: ${e.message}`);
                                    // Cleanup any partial files
                                    for (const f of ['tweet_video_raw.mp4', 'tweet_audio_raw.mp4']) {
                                        try { fs.unlinkSync(f); } catch {}
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