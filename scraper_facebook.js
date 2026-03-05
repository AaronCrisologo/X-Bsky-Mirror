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
            // TEMP: force fallback path for diagnostics — remove after
            if (true) return null;

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

        let targetFilename = null;
        let postImageInfo_resolved = null;

        if (postImageInfo && postImageInfo.candidates && postImageInfo.candidates.length > 0) {
            // Pagelet path: pick largest captured buffer among DOM candidates
            let bestSrc = null, bestPhotoHref = null, bestSize = 0;
            for (const { src, photoHref } of postImageInfo.candidates) {
                const filename = getFilename(src);
                const size = capturedImages[filename] ? capturedImages[filename].length : 0;
                if (size > bestSize) {
                    bestSize = size;
                    bestSrc = src;
                    bestPhotoHref = photoHref;
                }
            }
            if (bestSrc && bestSize >= 10000) {
                targetFilename = getFilename(bestSrc);
                postImageInfo_resolved = { src: bestSrc, photoHref: bestPhotoHref };
                process.stderr.write(`Pagelet selected: ${targetFilename} (${bestSize} bytes)\n`);
            }
        }

        if (!postImageInfo_resolved) {
            // Network capture fallback: check article[0] (always the latest post in DOM order)
            // for video signals, then select an image from network capture.
            process.stderr.write('No pagelet found — using network capture fallback.\n');

            // Diagnostic: dump everything time-related from each article so we can
            // figure out how Facebook actually renders timestamps in this environment.
            const timeDiagnostics = await page.evaluate(() => {
                const articles = Array.from(document.querySelectorAll('[role="article"]'));
                return articles.map((article, idx) => {
                    // All <time> elements and their attributes + text
                    const timeEls = Array.from(article.querySelectorAll('time')).map(t => ({
                        datetime:  t.getAttribute('datetime'),
                        title:     t.getAttribute('title'),
                        ariaLabel: t.getAttribute('aria-label'),
                        text:      t.innerText,
                        outerHTML: t.outerHTML.slice(0, 300),
                    }));

                    // All <a> tags whose text looks like a timestamp ("33m", "2h", "March 5")
                    const timestampLinks = Array.from(article.querySelectorAll('a')).filter(a => {
                        const t = (a.innerText || '').trim();
                        return /^(\d+[mhd]|just now|yesterday|\w+ \d+)/i.test(t);
                    }).map(a => ({
                        text:      a.innerText.trim(),
                        href:      a.href,
                        ariaLabel: a.getAttribute('aria-label'),
                        title:     a.getAttribute('title'),
                    }));

                    // Any element with a title or aria-label that looks like a date
                    const dateAttrs = Array.from(article.querySelectorAll('[title],[aria-label]')).filter(el => {
                        const val = el.getAttribute('title') || el.getAttribute('aria-label') || '';
                        return /\b(january|february|march|april|may|june|july|august|september|october|november|december|\d{4}|\d+:\d+\s*(am|pm))/i.test(val);
                    }).map(el => ({
                        tag:       el.tagName,
                        title:     el.getAttribute('title'),
                        ariaLabel: el.getAttribute('aria-label'),
                        text:      (el.innerText || '').trim().slice(0, 80),
                    }));

                    return { idx, timeEls, timestampLinks, dateAttrs };
                });
            });

            timeDiagnostics.forEach(({ idx, timeEls, timestampLinks, dateAttrs }) => {
                process.stderr.write(`\n--- article[${idx}] ---\n`);
                process.stderr.write(`  <time> elements (${timeEls.length}):\n`);
                timeEls.forEach(t => process.stderr.write(`    datetime="${t.datetime}" title="${t.title}" aria="${t.ariaLabel}" text="${t.text}" html=${t.outerHTML}\n`));
                process.stderr.write(`  timestamp-like <a> tags (${timestampLinks.length}):\n`);
                timestampLinks.forEach(a => process.stderr.write(`    text="${a.text}" href="${a.href}" title="${a.title}" aria="${a.ariaLabel}"\n`));
                process.stderr.write(`  date-like title/aria-label attrs (${dateAttrs.length}):\n`);
                dateAttrs.forEach(d => process.stderr.write(`    <${d.tag}> title="${d.title}" aria="${d.ariaLabel}" text="${d.text}"\n`));
            });

            const fallbackVideoData = await page.evaluate(() => {
                const articles = Array.from(document.querySelectorAll('[role="article"]'));

                // TODO: replace with real timestamp selector once diagnostics reveal the pattern
                const winnerIdx = articles.length > 0 ? 0 : -1;
                const root = winnerIdx >= 0 ? articles[winnerIdx] : null;
                if (!root) return { totalArticles: articles.length, winnerIdx, checks: {}, noArticles: true };

                const checks = {
                    video:       !!root.querySelector('video'),
                    videoId:     !!root.querySelector('[data-video-id]'),
                    videoLink:   !!root.querySelector('a[href*="/videos/"]'),
                    reelLink:    !!root.querySelector('a[href*="/reel/"]'),
                    playVideo:   !!root.querySelector('[aria-label="Play video"]'),
                    play:        !!root.querySelector('[aria-label="Play"]'),
                    inlineVideo: !!root.querySelector('[data-sigil="inlineVideo"]'),
                };

                return { totalArticles: articles.length, winnerIdx, checks };
            });

            // Log what was found
            process.stderr.write(`fallbackVideoCheck: ${fallbackVideoData.totalArticles} total articles, checking article[${fallbackVideoData.winnerIdx}] (DOM order)\n`);
            if (fallbackVideoData.noArticles) {
                process.stderr.write('fallbackVideoCheck: no articles found at all — cannot check for video, bailing.\n');
                console.log(JSON.stringify({ error: 'no_image_found' }));
                return;
            }
            process.stderr.write(`fallbackVideoCheck signals: ${JSON.stringify(fallbackVideoData.checks)}\n`);

            const fallbackVideoCheck = Object.values(fallbackVideoData.checks).some(Boolean);

            if (fallbackVideoCheck) {
                process.stderr.write('Latest post appears to be a video. Skipping.\n');
                console.log(JSON.stringify({ error: 'no_image_found' }));
                return;
            }

            // Step 2: find the best image from network capture
            let matchCount = 0;
            const candidate = captureOrder.find(filename => {
                const size = capturedImages[filename] ? capturedImages[filename].length : 0;
                if (size < 20000) return false;
                if (filename.endsWith('.kf')) return false;
                if (filename.endsWith('.png') && size < 50000) return false;
                matchCount++;
                return matchCount === 2; // skip first match (banner), take second
            });

            if (!candidate) {
                process.stderr.write('No suitable post image found on Facebook page.\n');
                console.log(JSON.stringify({ error: 'no_image_found' }));
                return;
            }

            // Try to find a photo href for full-res navigation
            const fallbackPhotoHref = await page.evaluate((fname) => {
                const imgs = Array.from(document.querySelectorAll('img[src*="fbcdn"]'));
                const img = imgs.find(i => {
                    try { return new URL(i.src).pathname.split('/').pop() === fname; } catch(_) { return false; }
                });
                if (!img) return null;
                let el = img;
                for (let i = 0; i < 12; i++) {
                    if (!el) break;
                    if (el.tagName === 'A' && el.href && (
                        el.href.includes('/photo') ||
                        el.href.includes('/posts/') ||
                        el.href.includes('story_fbid') ||
                        el.href.includes('permalink')
                    )) return el.href;
                    el = el.parentElement;
                }
                return null;
            }, candidate);

            targetFilename = candidate;
            postImageInfo_resolved = { src: null, photoHref: fallbackPhotoHref };
            process.stderr.write(`Network fallback selected: ${targetFilename} (${capturedImages[candidate].length} bytes)${fallbackPhotoHref ? ' [photo link found]' : ''}\n`);
        }

        // Phase 3: navigate to photo viewer for full-res, if we have a link
        let fullResBuffer = null;
        let fullResBytes = 0;

        const fullResListener = async (response) => {
            try {
                if (response.status() !== 200) return;
                const url = response.url();
                if (!url.includes('fbcdn.net')) return;
                if (url.includes('rsrc.php')) return;
                const ct = response.headers()['content-type'] || '';
                if (!ct.startsWith('image/')) return;
                const filename = getFilename(url);
                if (filename !== targetFilename) return;
                const buffer = await response.buffer();
                if (buffer.length > fullResBytes) {
                    fullResBuffer = buffer;
                    fullResBytes = buffer.length;
                    process.stderr.write(`Viewer loaded ${filename} at ${buffer.length} bytes\n`);
                }
            } catch (_) {}
        };

        page.on('response', fullResListener);

        if (postImageInfo_resolved.photoHref) {
            process.stderr.write(`Navigating to photo viewer: ${postImageInfo_resolved.photoHref}\n`);
            await page.goto(postImageInfo_resolved.photoHref, { waitUntil: 'networkidle2', timeout: 30000 });
        } else if (postImageInfo_resolved.src) {
            process.stderr.write('Clicking post image to open viewer...\n');
            await page.evaluate((targetSrc) => {
                const imgs = Array.from(document.querySelectorAll('img[src*="fbcdn"]'));
                const img = imgs.find(i => i.src === targetSrc);
                if (img) {
                    let el = img;
                    for (let i = 0; i < 8; i++) {
                        if (!el) break;
                        if (el.tagName === 'A' || el.getAttribute('role') === 'link') {
                            el.click();
                            return;
                        }
                        el = el.parentElement;
                    }
                    img.click();
                }
            }, postImageInfo_resolved.src);

            try {
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
            } catch (_) {
                // Modal viewer — no navigation event
            }
        } else {
            process.stderr.write('No photo href available, using feed capture directly.\n');
        }

        // Give the viewer time to fully load the high-res image
        await new Promise(r => setTimeout(r, 4000));

        // Pick the best buffer: full-res from viewer if we got it, else feed capture
        const feedBuffer = capturedImages[targetFilename];

        if (fullResBuffer && fullResBuffer.length > (feedBuffer ? feedBuffer.length : 0)) {
            process.stderr.write(`Using full-res viewer image: ${fullResBuffer.length} bytes\n`);
            fs.writeFileSync(OUTPUT_FILE, fullResBuffer);
        } else if (feedBuffer) {
            process.stderr.write(`Viewer didn't load higher res, using feed capture: ${feedBuffer.length} bytes\n`);
            fs.writeFileSync(OUTPUT_FILE, feedBuffer);
        } else {
            process.stderr.write('No image buffer available.\n');
            console.log(JSON.stringify({ error: 'download_failed' }));
            return;
        }

        console.log(JSON.stringify({ imagePath: OUTPUT_FILE }));

    } catch (error) {
        process.stderr.write(`Facebook scraper error: ${error.message}\n`);
        console.log(JSON.stringify({ error: error.message }));
    } finally {
        await browser.close();
    }
}

getLatestFacebookImage();
