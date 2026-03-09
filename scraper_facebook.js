process.stdout.setEncoding('utf8');
process.stderr.setEncoding('utf8');

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());

const FB_PAGE_URL = 'https://www.facebook.com/FateGO.USA';
const OUTPUT_FILE = 'facebook_img.jpg';

const rawCookies = [
    { "domain": ".facebook.com", "name": "c_user", "value": process.env.FB_C_USER, "path": "/", "secure": true, "sameSite": "Lax" },
    { "domain": ".facebook.com", "name": "xs",     "value": process.env.FB_XS,     "path": "/", "secure": true, "sameSite": "Lax" }
];

function getFilename(url) {
    try {
        return new URL(url).pathname.split('/').pop();
    } catch (_) {
        return null;
    }
}

async function getLatestFacebookImage() {
    if (!process.env.FB_C_USER || !process.env.FB_XS) {
        process.stderr.write('⚠️  FB_C_USER or FB_XS not set — running without session cookies (low-res fallback).\n');
    }

    const browser = await puppeteer.launch({
        headless: "new",
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--single-process'
        ]
    });

    const page = await browser.newPage();

    try {
        await page.setViewport({ width: 1280, height: 1000 });
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        await page.setCookie(...rawCookies);

        // Phase 1: capture all feed-load images keyed by filename
        const capturedImages = {};
        const captureOrder = []; // first-seen insertion order

        page.on('response', async (response) => {
            try {
                if (response.status() !== 200) return;
                const url = response.url();
                if (!url.includes('fbcdn.net')) return;
                if (url.includes('rsrc.php')) return;
                const ct = response.headers()['content-type'] || '';
                if (!ct.startsWith('image/')) return;
                const filename = getFilename(url);
                if (!filename) return;
                const buffer = await response.buffer();
                if (!capturedImages[filename]) {
                    captureOrder.push(filename); // track first-seen order
                }
                if (!capturedImages[filename] || buffer.length > capturedImages[filename].length) {
                    capturedImages[filename] = buffer;
                    process.stderr.write(`Captured ${filename} (${buffer.length} bytes)\n`);
                }
            } catch (_) {}
        });

        await page.goto(FB_PAGE_URL, { waitUntil: 'networkidle2', timeout: 30000 });

        try {
            const declineBtn = await page.$('[data-cookiebanner="accept_only_essential_button"]');
            if (declineBtn) await declineBtn.click();
        } catch (_) {}
        try {
            const closeBtn = await page.$('[aria-label="Close"]');
            if (closeBtn) await closeBtn.click();
        } catch (_) {}

        await new Promise(r => setTimeout(r, 2000));
        await page.evaluate(() => window.scrollBy(0, 400));
        await new Promise(r => setTimeout(r, 2000));

        // Phase 2: try pagelet-based discovery, fall back to network capture order
        const postImageInfo = await page.evaluate(() => {
            // Try known pagelet names in order of preference
            const pageletNames = ['FeedUnit_0', 'TimelineFeedUnit_0', 'ProfileTimelineFeedUnit_0'];
            let latestPost = null;
            for (const name of pageletNames) {
                latestPost = document.querySelector(`[data-pagelet="${name}"]`);
                if (latestPost) break;
            }

            if (!latestPost) return null; // signal to use network fallback

            const hasVideo =
                latestPost.querySelector('video') !== null ||
                latestPost.querySelector('[data-video-id]') !== null ||
                latestPost.querySelector('[aria-label="Play video"]') !== null ||
                latestPost.querySelector('[aria-label="Play"]') !== null ||
                latestPost.querySelector('[data-sigil="inlineVideo"]') !== null ||
                latestPost.querySelector('a[href*="/videos/"]') !== null ||
                latestPost.querySelector('a[href*="/reel/"]') !== null;

            if (hasVideo) return { isVideo: true };

            const imgs = Array.from(latestPost.querySelectorAll('img[src*="fbcdn"]'));
            if (!imgs.length) return null;

            const candidates = imgs.map(img => {
                let photoHref = null;
                let el = img;
                for (let i = 0; i < 12; i++) {
                    if (!el) break;
                    if (el.tagName === 'A' && el.href && (
                        el.href.includes('/photo') ||
                        el.href.includes('/posts/') ||
                        el.href.includes('story_fbid') ||
                        el.href.includes('permalink')
                    )) {
                        photoHref = el.href;
                        break;
                    }
                    el = el.parentElement;
                }
                return { src: img.src, photoHref };
            });

            const filtered = candidates.filter(c =>
                !c.src.includes('_s.jpg') &&
                !c.src.includes('p40x40') &&
                !c.src.includes('p50x50') &&
                !c.src.includes('p60x60')
            );

            return { candidates: filtered.length ? filtered : candidates };
        });

        if (postImageInfo && postImageInfo.isVideo) {
            process.stderr.write('Latest post is a video. Skipping.\n');
            console.log(JSON.stringify({ error: 'no_image_found' }));
            return;
        }

        // resolvedCandidates: [{filename, src, photoHref}] — populated by pagelet or fallback path
        let resolvedCandidates = [];

        if (postImageInfo && postImageInfo.candidates && postImageInfo.candidates.length > 0) {
            // Pagelet path: collect ALL qualifying candidates, sorted by captured buffer size desc
            const ranked = [];
            for (const { src, photoHref } of postImageInfo.candidates) {
                const filename = getFilename(src);
                const size = capturedImages[filename] ? capturedImages[filename].length : 0;
                if (size >= 10000) ranked.push({ filename, src, photoHref, size });
            }
            ranked.sort((a, b) => b.size - a.size);
            resolvedCandidates = ranked.map(({ filename, src, photoHref }) => ({ filename, src, photoHref }));
            process.stderr.write(`Pagelet candidates: ${resolvedCandidates.map(c => c.filename).join(', ')}\n`);
        }

        if (resolvedCandidates.length === 0) {
            // Network capture fallback: hover each article's post-level timestamp link to get the
            // exact datetime from Facebook's tooltip, sort by it, then check the latest for video.
            process.stderr.write('No pagelet found — using network capture fallback.\n');

            // Step 1: mark each article's post-level timestamp <a> with a probe attribute
            // so Puppeteer can hover it. Post-level = aria-label matches text, no comment_id in href.
            const articleCount = await page.evaluate(() => {
                const articles = Array.from(document.querySelectorAll('[role="article"]'));
                let marked = 0;
                articles.forEach((article, idx) => {
                    const links = Array.from(article.querySelectorAll('a[aria-label]'));
                    for (const a of links) {
                        const aria = a.getAttribute('aria-label') || '';
                        const text = (a.innerText || '').trim();
                        const href = a.href || '';
                        if (aria === text && !href.includes('comment_id') && /^\d+\s*[smhdw]$/i.test(text)) {
                            a.setAttribute('data-ts-probe', `article-${idx}`);
                            marked++;
                            break;
                        }
                    }
                });
                return articles.length;
            });

            // Step 2: hover each marked link and read the exact datetime from the tooltip
            const articleTimestamps = {}; // idx -> exact ts (ms) or 0

            for (let i = 0; i < articleCount; i++) {
                const selector = `[data-ts-probe="article-${i}"]`;
                const exists = await page.evaluate((sel) => !!document.querySelector(sel), selector);
                if (!exists) {
                    process.stderr.write(`article[${i}]: no post-level timestamp link\n`);
                    articleTimestamps[i] = 0;
                    continue;
                }

                try {
                    await page.hover(selector);
                    await new Promise(r => setTimeout(r, 600));

                    const tooltipTs = await page.evaluate(() => {
                        const tooltip = document.querySelector('[role="tooltip"]');
                        if (!tooltip) return null;
                        const text = tooltip.innerText.trim();
                        // e.g. "Thursday, March 5, 2026 at 4:45 AM"
                        const ts = new Date(text.replace(' at ', ' ')).getTime();
                        return isNaN(ts) ? null : { text, ts };
                    });

                    if (tooltipTs) {
                        process.stderr.write(`article[${i}]: tooltip="${tooltipTs.text}" ts=${tooltipTs.ts}\n`);
                        articleTimestamps[i] = tooltipTs.ts;
                    } else {
                        process.stderr.write(`article[${i}]: tooltip not found or unparseable, using relative fallback\n`);
                        // Fall back to relative time approximation
                        const relTs = await page.evaluate((sel) => {
                            const a = document.querySelector(sel);
                            if (!a) return 0;
                            const text = (a.innerText || '').trim();
                            const m = text.match(/^(\d+)\s*(s|m|h|d|w)$/i);
                            if (!m) return 0;
                            const val = parseInt(m[1]);
                            const unit = m[2].toLowerCase();
                            const ms = unit === 's' ? val * 1000
                                       : unit === 'm' ? val * 60000
                                       : unit === 'h' ? val * 3600000
                                       : unit === 'd' ? val * 86400000
                                       : val * 604800000;
                            return Date.now() - ms;
                        }, selector);
                        articleTimestamps[i] = relTs;
                    }
                } catch (e) {
                    process.stderr.write(`article[${i}]: hover error — ${e.message}\n`);
                    articleTimestamps[i] = 0;
                }
            }

            // Step 3: pick the article with the highest (most recent) timestamp
            let winnerIdx = -1;
            let winnerTs = 0;
            for (let i = 0; i < articleCount; i++) {
                if (articleTimestamps[i] > winnerTs) {
                    winnerTs = articleTimestamps[i];
                    winnerIdx = i;
                }
            }
            // If no timestamps found at all, fall back to DOM order
            if (winnerIdx === -1 && articleCount > 0) {
                winnerIdx = 0;
                process.stderr.write('No timestamps resolved — falling back to article[0] (DOM order)\n');
            }
            process.stderr.write(`Latest article: index ${winnerIdx}\n`);

            // Step 4: check that article for video signals
            const videoCheck = await page.evaluate((idx) => {
                const root = document.querySelectorAll('[role="article"]')[idx];
                if (!root) return { noArticle: true };
                return {
                    video:       !!root.querySelector('video'),
                    videoId:     !!root.querySelector('[data-video-id]'),
                    videoLink:   !!root.querySelector('a[href*="/videos/"]'),
                    reelLink:    !!root.querySelector('a[href*="/reel/"]'),
                    playVideo:   !!root.querySelector('[aria-label="Play video"]'),
                    play:        !!root.querySelector('[aria-label="Play"]'),
                    inlineVideo: !!root.querySelector('[data-sigil="inlineVideo"]'),
                };
            }, winnerIdx);

            process.stderr.write(`Video signals: ${JSON.stringify(videoCheck)}\n`);

            if (videoCheck.noArticle) {
                process.stderr.write('Article not found — bailing.\n');
                console.log(JSON.stringify({ error: 'no_image_found' }));
                return;
            }

            if (Object.values(videoCheck).some(Boolean)) {
                process.stderr.write('Latest post is a video. Skipping.\n');
                console.log(JSON.stringify({ error: 'no_image_found' }));
                return;
            }

            // Step 5: collect ALL images from the winning article, cross-referenced against captures
            const articleImages = await page.evaluate((idx) => {
                const article = document.querySelectorAll('[role="article"]')[idx];
                if (!article) return [];
                const imgs = Array.from(article.querySelectorAll('img[src*="fbcdn"]'));
                return imgs
                    .filter(img =>
                        !img.src.includes('_s.jpg') &&
                        !img.src.includes('p40x40') &&
                        !img.src.includes('p50x50') &&
                        !img.src.includes('p60x60')
                    )
                    .map(img => {
                        let photoHref = null;
                        let el = img;
                        for (let i = 0; i < 12; i++) {
                            if (!el) break;
                            if (el.tagName === 'A' && el.href && (
                                el.href.includes('/photo') ||
                                el.href.includes('/posts/') ||
                                el.href.includes('story_fbid') ||
                                el.href.includes('permalink')
                            )) { photoHref = el.href; break; }
                            el = el.parentElement;
                        }
                        try {
                            return { filename: new URL(img.src).pathname.split('/').pop(), src: img.src, photoHref };
                        } catch(_) { return null; }
                    })
                    .filter(Boolean);
            }, winnerIdx);

            process.stderr.write(`Article[${winnerIdx}] DOM images: ${JSON.stringify(articleImages.map(i => i.filename))}\n`);

            // Match DOM images against network captures, sorted by buffer size desc
            const domMatched = articleImages
                .map(({ filename, src, photoHref }) => ({
                    filename, src, photoHref,
                    size: capturedImages[filename] ? capturedImages[filename].length : 0
                }))
                .filter(c => c.size >= 10000 && !c.filename.endsWith('.kf'))
                .sort((a, b) => b.size - a.size);

            if (domMatched.length > 0) {
                resolvedCandidates = domMatched.map(({ filename, src, photoHref }) => ({ filename, src, photoHref }));
                process.stderr.write(`Fallback matched ${resolvedCandidates.length} image(s) from DOM: ${resolvedCandidates.map(c => c.filename).join(', ')}\n`);
            } else {
                // DOM images not in captures — fall back to capture order, skip banner, take next
                process.stderr.write('No DOM-matched images in captures — falling back to capture order.\n');
                let matchCount = 0;
                const fallbackFile = captureOrder.find(filename => {
                    const size = capturedImages[filename] ? capturedImages[filename].length : 0;
                    if (size < 20000) return false;
                    if (filename.endsWith('.kf')) return false;
                    if (filename.endsWith('.png') && size < 50000) return false;
                    matchCount++;
                    return matchCount === 2;
                });
                if (fallbackFile) resolvedCandidates = [{ filename: fallbackFile, src: null, photoHref: null }];
            }

            if (resolvedCandidates.length === 0) {
                process.stderr.write('No suitable post image found on Facebook page.\n');
                console.log(JSON.stringify({ error: 'no_image_found' }));
                return;
            }
        }

        // Phase 3: for a single image, navigate to photo viewer to get full-res.
        // For multiple images, use feed captures directly (navigating to each viewer
        // would require multiple page loads and is not worth the added complexity).
        const outputPaths = [];

        if (resolvedCandidates.length === 1) {
            const { filename: targetFilename, src: targetSrc, photoHref: targetPhotoHref } = resolvedCandidates[0];
            let fullResBuffer = null;
            let fullResBytes = 0;

            // Capture the largest image loaded during viewer navigation.
            // The full-res file Facebook serves in the viewer has a different filename
            // than the feed thumbnail, so we don't filter by filename here.
            const fullResListener = async (response) => {
                try {
                    if (response.status() !== 200) return;
                    const url = response.url();
                    if (!url.includes('fbcdn.net')) return;
                    if (url.includes('rsrc.php')) return;
                    const ct = response.headers()['content-type'] || '';
                    if (!ct.startsWith('image/')) return;
                    const buffer = await response.buffer();
                    if (buffer.length > fullResBytes) {
                        fullResBuffer = buffer;
                        fullResBytes = buffer.length;
                        process.stderr.write(`Viewer candidate: ${getFilename(url)} at ${buffer.length} bytes\n`);
                    }
                } catch (_) {}
            };
            page.on('response', fullResListener);

            if (targetPhotoHref) {
                process.stderr.write(`Navigating to photo viewer: ${targetPhotoHref}\n`);
                await page.goto(targetPhotoHref, { waitUntil: 'networkidle2', timeout: 30000 });
            } else if (targetSrc) {
                process.stderr.write('Clicking post image to open viewer...\n');
                await page.evaluate((src) => {
                    const img = Array.from(document.querySelectorAll('img[src*="fbcdn"]')).find(i => i.src === src);
                    if (img) {
                        let el = img;
                        for (let i = 0; i < 8; i++) {
                            if (!el) break;
                            if (el.tagName === 'A' || el.getAttribute('role') === 'link') { el.click(); return; }
                            el = el.parentElement;
                        }
                        img.click();
                    }
                }, targetSrc);
                try { await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }); } catch (_) {}
            } else {
                process.stderr.write('No photo href available, using feed capture directly.\n');
            }

            await new Promise(r => setTimeout(r, 4000));

            const feedBuffer = capturedImages[targetFilename];
            const outFile = 'facebook_img_0.jpg';
            if (fullResBuffer && fullResBuffer.length > (feedBuffer ? feedBuffer.length : 0)) {
                process.stderr.write(`Using full-res viewer image: ${fullResBuffer.length} bytes\n`);
                fs.writeFileSync(outFile, fullResBuffer);
            } else if (feedBuffer) {
                process.stderr.write(`Using feed capture: ${feedBuffer.length} bytes\n`);
                fs.writeFileSync(outFile, feedBuffer);
            } else {
                process.stderr.write('No image buffer available.\n');
                console.log(JSON.stringify({ error: 'download_failed' }));
                return;
            }
            outputPaths.push(outFile);

        } else {
            // Multiple images — navigate to each photo's viewer to get full-res
            process.stderr.write(`Fetching full-res for ${resolvedCandidates.length} images.\n`);
            for (let i = 0; i < resolvedCandidates.length; i++) {
                const { filename, src, photoHref } = resolvedCandidates[i];
                const outFile = `facebook_img_${i}.jpg`;
                let fullResBuffer = null;
                let fullResBytes = 0;

                // Capture the largest image loaded during viewer navigation.
                // The full-res file Facebook serves in the viewer has a different filename
                // than the feed thumbnail, so we don't filter by filename here.
                const listener = async (response) => {
                    try {
                        if (response.status() !== 200) return;
                        const url = response.url();
                        if (!url.includes('fbcdn.net')) return;
                        if (url.includes('rsrc.php')) return;
                        const ct = response.headers()['content-type'] || '';
                        if (!ct.startsWith('image/')) return;
                        const buffer = await response.buffer();
                        if (buffer.length > fullResBytes) {
                            fullResBuffer = buffer;
                            fullResBytes = buffer.length;
                            process.stderr.write(`[${i}] Viewer candidate: ${getFilename(url)} at ${buffer.length} bytes\n`);
                        }
                    } catch (_) {}
                };
                page.on('response', listener);

                if (photoHref) {
                    process.stderr.write(`[${i}] Navigating to photo viewer: ${photoHref}\n`);
                    await page.goto(photoHref, { waitUntil: 'networkidle2', timeout: 30000 });
                } else if (src) {
                    process.stderr.write(`[${i}] No photoHref, using feed capture directly.\n`);
                } else {
                    process.stderr.write(`[${i}] No src or photoHref, skipping.\n`);
                    page.off('response', listener);
                    continue;
                }

                await new Promise(r => setTimeout(r, 3000));
                page.off('response', listener);

                const feedBuffer = capturedImages[filename];
                const feedBytes = feedBuffer ? feedBuffer.length : 0;

                if (fullResBuffer && fullResBuffer.length > feedBytes) {
                    process.stderr.write(`[${i}] Using full-res viewer image: ${fullResBuffer.length} bytes (feed was ${feedBytes})\n`);
                    fs.writeFileSync(outFile, fullResBuffer);
                } else if (feedBuffer) {
                    process.stderr.write(`[${i}] Viewer didn't improve on feed capture (viewer=${fullResBytes}, feed=${feedBytes}), using feed.\n`);
                    fs.writeFileSync(outFile, feedBuffer);
                } else {
                    process.stderr.write(`[${i}] No buffer available, skipping.\n`);
                    continue;
                }
                outputPaths.push(outFile);
            }
        }

        if (outputPaths.length === 0) {
            process.stderr.write('No images written.\n');
            console.log(JSON.stringify({ error: 'download_failed' }));
            return;
        }

        console.log(JSON.stringify({ imagePaths: outputPaths }));

    } catch (error) {
        process.stderr.write(`Facebook scraper error: ${error.message}\n`);
        console.log(JSON.stringify({ error: error.message }));
    } finally {
        await browser.close();
    }
}

getLatestFacebookImage();
