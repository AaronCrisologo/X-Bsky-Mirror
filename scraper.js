process.stdout.setEncoding('utf8');
process.stderr.setEncoding('utf8');

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const https = require('https');
const { execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

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


// ─── Helper: Download file via HTTPS ──────────────────────────────────────────

function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        https.get(url, (res) => {
            if (res.statusCode !== 200) {
                fs.unlink(destPath, () => {});
                reject(new Error(`HTTP ${res.statusCode}: ${url}`));
                return;
            }
            res.pipe(file);
            file.on('finish', () => file.close(() => resolve(destPath)));
        }).on('error', (err) => {
            fs.unlink(destPath, () => {});
            reject(err);
        });
    });
}

// ─── Helper: Download HLS playlist ────────────────────────────────────────────

function downloadPlaylist(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

// ─── Helper: Parse master playlist, return sorted streams ─────────────────────

function parseMasterPlaylist(body, baseUrl) {
    const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
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
                    url: childUrl.startsWith('https://') ? childUrl : new URL(childUrl, baseUrl).href
                });
            }
        }
    }
    return streams.sort((a, b) => b.bandwidth - a.bandwidth);
}

// ─── Helper: Parse child playlist for segments and init segment ───────────────

function parseChildPlaylist(body) {
    const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
    let initUrl = null;
    const segUrls = [];
    for (const line of lines) {
        const mapMatch = line.match(/^#EXT-X-MAP:URI="([^"]+)"/);
        if (mapMatch) {
            initUrl = mapMatch[1];
        } else if (!line.startsWith('#') && line.includes('.m4s')) {
            segUrls.push(line);
        }
    }
    return { initUrl, segUrls };
}

// ─── Helper: Download segments and concat ─────────────────────────────────────

async function downloadSegments(baseUrl, { initUrl, segUrls }, label) {
    const allUrls = initUrl ? [initUrl, ...segUrls] : segUrls;
    log('[INFO]', label, `${allUrls.length} segment(s) to download`);
    const buffers = [];
    for (let i = 0; i < allUrls.length; i++) {
        const url = allUrls[i].startsWith('https://') ? allUrls[i] : new URL(allUrls[i], baseUrl).href;
        const data = await new Promise((resolve, reject) => {
            https.get(url, (res) => {
                if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}: ${url}`)); return; }
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => resolve(Buffer.concat(chunks)));
            }).on('error', reject);
        });
        buffers.push(data);
        if (i % 5 === 0) log('[INFO]', label, `${i + 1}/${allUrls.length} done`);
    }
    log('[OK]', label, 'All segments downloaded');
    return Buffer.concat(buffers);
}

// ─── Helper: Mux video + audio with ffmpeg ────────────────────────────────────

function muxVideo(videoPath, audioPath, outputPath) {
    return new Promise((resolve, reject) => {
        execFile(ffmpegPath, [
            '-y',
            '-fflags', '+genpts',
            '-i', videoPath,
            '-i', audioPath,
            '-map', '0:v:0',
            '-map', '1:a:0',
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-movflags', '+faststart',
            outputPath
        ], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            log('[FFMPEG]', 'FFMPEG', stderr.slice(-600));
            if (err) reject(err);
            else resolve();
        });
    });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function getLatestTweets(username, maxTweets = 5) {
    const totalTimer = timer();
    log('[START]', 'START', `Scraper starting for @${username} (max ${maxTweets} tweets)`);

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

    // ── Network monitoring: capture ALL m3u8 manifests ────────────────────────
    const m3u8Bodies = new Map(); // videoId -> array of { url, body }
    const m3u8Logs = [];

    page.on('response', async (res) => {
        const url = res.url();
        if (url.includes('video.twimg.com') && url.includes('.m3u8')) {
            const m = url.match(/ext_tw_video\/(\d+)\//);
            const videoId = m ? m[1] : 'unknown';
            try {
                const body = await res.text();
                if (!m3u8Bodies.has(videoId)) m3u8Bodies.set(videoId, []);
                m3u8Bodies.get(videoId).push({ url, body });
                m3u8Logs.push({ icon: '[MANIFEST]', tag: 'M3U8', msg: `Captured manifest for videoId=${videoId} (${body.length} chars): ${url}` });
            } catch (e) {
                m3u8Logs.push({ icon: '[WARN]', tag: 'M3U8', msg: `Could not read body for ${url}: ${e.message}` });
            }
        }
    });

    let reqTotal = 0, reqFailed = 0;
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

        const scrapeResult = await page.evaluate(async (maxTweets) => {
            const results = [];
            for (let scroll = 0; scroll < 5; scroll++) {
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

            // Deduplicate by time, sort newest first
            const unique = results.filter((v, i, a) => a.findIndex(t => t.time === v.time) === i);
            unique.sort((a, b) => new Date(b.time) - new Date(a.time));
            // Filter out pinned, return up to maxTweets
            const nonPinned = unique.filter(t => !t.isPinned);
            return nonPinned.slice(0, maxTweets);
        }, maxTweets);

        // Wait for m3u8 manifests triggered during scrolling to arrive
        log('[SCRAPE]', 'WAIT', 'Waiting for m3u8 manifests to settle (2s)...');
        await new Promise(resolve => setTimeout(resolve, 2000));

        log('[SCRAPE]', 'SCRAPE', `${scrapeResult.length} non-pinned tweet(s) found in ${scrapeTimer()}`);
        scrapeResult.forEach((t, i) => {
            log(`  [${i}]`, 'ARTICLE',
                `time=${t.time} | video=${t.hasVideo} | videoId=${t.videoId || 'none'} | ` +
                `images=${t.images.length} | text="${t.text.substring(0, 80).replace(/\n/g, ' ')}..."`
            );
        });

        if (scrapeResult.length === 0) {
            ghaError('No non-pinned tweets found after scraping');
            ghaEndGroup();
            console.log(JSON.stringify({ error: 'No tweets found' }));
            return;
        }

        ghaEndGroup();

        // ── FLUSH BACKGROUND LOGS ────────────────────────────────────────────
        if (m3u8Logs.length > 0) {
            ghaGroup('[NETWORK] Network: M3U8 Manifests');
            m3u8Logs.forEach(l => log(l.icon, l.tag, l.msg));
            ghaEndGroup();
        }

        // ── Download images for ALL tweets ───────────────────────────────────
        ghaGroup('[IMG] Image Download (all tweets)');
        for (let tweetIdx = 0; tweetIdx < scrapeResult.length; tweetIdx++) {
            const tweet = scrapeResult[tweetIdx];
            for (let imgIdx = 0; imgIdx < tweet.images.length; imgIdx++) {
                const originalUrl = tweet.images[imgIdx];
                let highResUrl;
                if (originalUrl.includes('?')) {
                    const [base, params] = originalUrl.split('?');
                    const urlParams = new URLSearchParams(params);
                    urlParams.set('name', 'orig');
                    highResUrl = `${base}?${urlParams.toString()}`;
                } else {
                    highResUrl = `${originalUrl}?format=jpg&name=orig`;
                }

                const filename = `tweet_img_${tweetIdx}_${imgIdx}.jpg`;
                log('[DOWNLOAD]', `IMG[t${tweetIdx}_${imgIdx}]`, highResUrl);
                const imgTimer = timer();
                try {
                    const response = await page.goto(highResUrl, { waitUntil: 'networkidle0', timeout: 15000 });
                    if (response && response.ok()) {
                        const buffer = await response.buffer();
                        fs.writeFileSync(filename, buffer);
                        log('[OK]', `IMG[t${tweetIdx}_${imgIdx}]`, `Saved ${filename} — ${(buffer.length / 1024).toFixed(1)} KB in ${imgTimer()}`);
                    } else {
                        ghaError(`IMG[t${tweetIdx}_${imgIdx}]: HTTP ${response?.status()} — ${highResUrl}`);
                    }
                } catch (e) {
                    ghaError(`IMG[t${tweetIdx}_${imgIdx}]: ${e.message} — ${highResUrl}`);
                }
            }
        }
        ghaEndGroup();

        // ── Prepare m3u8 data for videos ─────────────────────────────────────
        // For each tweet with video, find its m3u8 data
        const videoManifests = {};
        for (const tweet of scrapeResult) {
            if (tweet.hasVideo && tweet.videoId) {
                const manifests = m3u8Bodies.get(tweet.videoId) || [];
                if (manifests.length > 0) {
                    // Find master playlist
                    const master = manifests.find(m => m.body.includes('#EXT-X-STREAM-INF')) || manifests[0];
                    videoManifests[tweet.videoId] = {
                        masterUrl: master.url,
                        masterBody: master.body,
                        // Also include all captured manifests for this videoId
                        allManifests: manifests.map(m => ({ url: m.url, body: m.body }))
                    };
                    log('[INFO]', 'VIDEO', `Prepared m3u8 data for videoId=${tweet.videoId} (${manifests.length} manifest(s))`);
                } else {
                    log('[WARN]', 'VIDEO', `No m3u8 captured for videoId=${tweet.videoId}`);
                }
            }
        }

        // ── Download videos for ALL tweets that have videos ─────────────────────
        for (let tweetIdx = 0; tweetIdx < scrapeResult.length; tweetIdx++) {
            const tweet = scrapeResult[tweetIdx];
            if (!tweet.hasVideo || !tweet.videoId) continue;

            const manifestData = videoManifests[tweet.videoId];
            if (!manifestData) {
                log('[WARN]', 'VIDEO', `Skipping video download for tweet ${tweetIdx}: no manifest data`);
                continue;
            }

            ghaGroup(`[VIDEO] Video Download for tweet ${tweetIdx} (videoId=${tweet.videoId})`);
            const videoTimer = timer();

            try {
                // Parse master playlist — find highest bandwidth child playlist
                const streams = parseMasterPlaylist(manifestData.masterBody, manifestData.masterUrl);
                log('[INFO]', 'VIDEO', `Streams: ${streams.map(s => `${s.resolution}@${s.bandwidth}`).join(', ') || 'none'}`);

                if (streams.length === 0) {
                    ghaWarning('No streams found in master playlist');
                    ghaEndGroup();
                    continue;
                }

                // Child playlist URLs are signed/tokenized so they don't require auth cookies —
                // plain https.get() works fine.
                // Use cache if Chrome already fetched it, otherwise fetch directly.
                streams.sort((a, b) => b.bandwidth - a.bandwidth);
                const bestStream = streams[0];
                log('[BEST]', 'VIDEO', `Best stream: ${bestStream.resolution} @ ${bestStream.bandwidth} bps → ${bestStream.url}`);

                // Fetch child playlist
                let childBody;
                const cachedChild = manifestData.allManifests.find(m => m.url === bestStream.url);
                if (cachedChild) {
                    log('[OK]', 'VIDEO', 'Child playlist found in cache');
                    childBody = cachedChild.body;
                } else {
                    log('[DOWNLOAD]', 'VIDEO', `Fetching child playlist via https: ${bestStream.url}`);
                    childBody = await downloadPlaylist(bestStream.url);
                }

                log('[MANIFEST]', 'VIDEO', `Child playlist body:\n${childBody}`);

                // Compute total video duration from #EXTINF tags
                const totalDuration = (childBody || '').split('\n')
                    .map(l => l.trim())
                    .filter(l => l.startsWith('#EXTINF:'))
                    .reduce((sum, l) => sum + parseFloat(l.replace('#EXTINF:', '').replace(',', '')), 0);
                log('[TIME]', 'VIDEO', `Video duration: ${totalDuration.toFixed(2)}s`);

                if (totalDuration <= 10) {
                    log('[INFO]', 'VIDEO', `Duration ≤10s — skipping video download, thumbnail will be used instead`);
                    ghaEndGroup();
                    continue;
                }

                // Parse child playlist for segments
                const childParsed = parseChildPlaylist(childBody);
                const videoBaseUrl = bestStream.url.substring(0, bestStream.url.lastIndexOf('/') + 1);

                // Download video segments
                log('[DOWNLOAD]', 'VIDEO', 'Downloading video track...');
                const videoBuffer = await downloadSegments(videoBaseUrl, childParsed, 'VID');
                const videoRawPath = `tweet_video_${tweetIdx}_raw.mp4`;
                fs.writeFileSync(videoRawPath, videoBuffer);
                log('[OK]', 'VIDEO', `Raw video: ${(videoBuffer.length / 1024).toFixed(1)} KB`);

                // Find audio groups in master playlist
                const audioGroups = [];
                for (const match of manifestData.masterBody.matchAll(/GROUP-ID="audio-(\d+)",AUTOSELECT=YES,URI="([^"]+)"/g)) {
                    audioGroups.push({ bitrate: parseInt(match[1]), uri: match[2] });
                }
                audioGroups.sort((a, b) => b.bitrate - a.bitrate);
                log('[INFO]', 'AUDIO', `Audio groups: ${audioGroups.map(g => g.bitrate).join(', ')} bps`);

                let audioBuffer = null;
                if (audioGroups.length > 0) {
                    const audioUri = audioGroups[0].uri;
                    const audioPlaylistUrl = audioUri.startsWith('https://') ? audioUri : `https://video.twimg.com${audioUri}`;
                    log('[DOWNLOAD]', 'AUDIO', `Playlist (${audioGroups[0].bitrate} bps): ${audioPlaylistUrl}`);
                    const cachedAudio = manifestData.allManifests.find(m => m.url === audioPlaylistUrl);
                    const audioBody = cachedAudio ? cachedAudio.body : await downloadPlaylist(audioPlaylistUrl);
                    log('[INFO]', 'AUDIO', cachedAudio ? 'Using cached playlist' : 'Fetched playlist');
                    audioBuffer = await downloadSegments(audioPlaylistUrl.substring(0, audioPlaylistUrl.lastIndexOf('/') + 1), parseChildPlaylist(audioBody), 'AUD');
                    fs.writeFileSync(`tweet_audio_${tweetIdx}_raw.mp4`, audioBuffer);
                    log('[OK]', 'AUDIO', `Raw audio: ${(audioBuffer.length / 1024).toFixed(1)} KB`);
                } else {
                    ghaWarning('No audio groups — using video-only');
                }

                // Mux with ffmpeg
                log('[FFMPEG]', 'FFMPEG', 'Muxing...');
                const videoOutPath = `tweet_video_${tweetIdx}.mp4`;
                await muxVideo(
                    videoRawPath,
                    audioBuffer ? `tweet_audio_${tweetIdx}_raw.mp4` : videoRawPath,
                    videoOutPath
                );

                // Cleanup raw files
                fs.unlinkSync(videoRawPath);
                if (audioBuffer) fs.unlinkSync(`tweet_audio_${tweetIdx}_raw.mp4`);

                const finalSize = (fs.statSync(videoOutPath).size / 1024).toFixed(1);
                log('[OK]', 'VIDEO', `Saved ${videoOutPath} — ${finalSize} KB in ${videoTimer()}`);

                // Store video path and resolution in tweet object
                tweet.videoPath = videoOutPath;
                const resParts = bestStream.resolution.split('x');
                if (resParts.length === 2) {
                    tweet.videoWidth = parseInt(resParts[0]);
                    tweet.videoHeight = parseInt(resParts[1]);
                    log('[DIMS]', 'VIDEO', `Resolution: ${tweet.videoWidth}x${tweet.videoHeight}`);
                }

            } catch (e) {
                ghaError(`Video download/mux failed for tweet ${tweetIdx}: ${e.message}`);
                // Cleanup on error
                for (const f of [`tweet_video_${tweetIdx}_raw.mp4`, `tweet_audio_${tweetIdx}_raw.mp4`]) {
                    try { fs.unlinkSync(f); } catch {}
                }
            }
            ghaEndGroup();
        }

        // ── Summary ──────────────────────────────────────────────────────────
        ghaGroup('[SUMMARY] Run Summary');
        log('[TIME]', 'TIMING', `Total elapsed: ${totalTimer()}`);
        log('[NETWORK]', 'NETWORK', `${reqTotal} responses, ${reqFailed} failed`);
        log('[TWEETS]', 'TWEETS', `${scrapeResult.length} tweet(s) returned`);
        ghaEndGroup();

        // Return array of tweets with metadata + video manifests
        const output = {
            tweets: scrapeResult,
            videoManifests
        };
        console.log(JSON.stringify(output));

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

getLatestTweets('FateGO_USA', 8);