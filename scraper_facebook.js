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
        const postData = await page.evaluate(() => {
            
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

            if (hasVideo) {
                console.log('Latest post is a video.');
                return { isVideo: true };
            }

            // Extract text content from the post
            const textEl = latestPost.querySelector('[data-testid="post_message"]') ||
                           latestPost.querySelector('.xdj266r.x11i5rnm.xat24cr.x1mh8g0r.x1vvkbs') ||
                           latestPost.querySelector('div[data-ad-preview="message"]') ||
                           latestPost.querySelector('[data-ad-comet-preview="message"]');
            
            let postText = '';
            if (textEl) {
                // Get text content, preserving line breaks
                postText = textEl.innerText.trim();
                // Clean up excessive whitespace
                postText = postText.replace(/\s+/g, ' ').trim();
            }

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

            return { candidates: filtered.length ? filtered : candidates, text: postText };
        });

        if (postData && postData.isVideo) {
            console.log('Latest post is a video. Skipping.');
            console.log(JSON.stringify({ error: 'no_image_found' }));
            return;
        }

        let targetFilename = null;
        let postImageInfo_resolved = null;
        let fbPostText = '';

        if (postData && postData.candidates && postData.candidates.length > 0) {
            // Pagelet path: pick largest captured buffer among DOM candidates
            let bestSrc = null, bestPhotoHref = null, bestSize = 0;
            for (const { src, photoHref } of postData.candidates) {
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
                console.log(`Pagelet selected: ${targetFilename} (${bestSize} bytes)`);
            }
        }

        // Store the Facebook post text if available from pagelet path
        if (postData && postData.text) {
            fbPostText = postData.text;
            console.log(`Facebook post text: ${fbPostText.substring(0, 100)}...`);
        }

        if (!postImageInfo_resolved) {
            // Network capture fallback: hover each article's post-level timestamp link to get the
            // exact datetime from Facebook's tooltip, sort by it, then check the latest for video.
            console.log('No pagelet found — using network capture fallback.');

            // Step 1: mark each article's post-level timestamp <a> with a probe attribute
            // so Puppeteer can hover it. Post-level = aria-label matches text, no comment_id in href.
            // Try multiple selectors for articles (Facebook changes these periodically)
            const articleDebug = await page.evaluate(() => {
                const selectors = [
                    '[role="article"]',
                    '[data-pagelet="FeedUnit"]',
                    '[data-pagelet^="FeedUnit_"]',
                    '.x1lliihq',  // Common FB post class
                    'div[tabindex="-1"][data-visualcompletion="ignore-dynamic"]'
                ];
                const results = {};
                for (const sel of selectors) {
                    results[sel] = document.querySelectorAll(sel).length;
                }
                // Also get the page HTML structure hints
                const bodyChildren = document.body ? document.body.children.length : 0;
                const mainContent = document.querySelector('main') || document.querySelector('[role="main"]');
                results['mainExists'] = !!mainContent;
                results['bodyChildren'] = bodyChildren;
                return results;
            });
            console.log(`Article selector debug: ${JSON.stringify(articleDebug)}`);

            const articleCount = await page.evaluate(() => {
                // Try multiple selectors for finding posts
                let articles = Array.from(document.querySelectorAll('[role="article"]'));
                if (articles.length === 0) {
                    articles = Array.from(document.querySelectorAll('[data-pagelet^="FeedUnit"]'));
                }
                if (articles.length === 0) {
                    // Fallback: look for post containers by common patterns
                    articles = Array.from(document.querySelectorAll('div[tabindex="-1"][data-visualcompletion="ignore-dynamic"]'));
                }
                
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
                console.log(`Found ${articles.length} articles, marked ${marked} with timestamps`);
                return articles.length;
            });

            // Step 2: hover each marked link and read the exact datetime from the tooltip
            const articleTimestamps = {}; // idx -> exact ts (ms) or 0

            for (let i = 0; i < articleCount; i++) {
                const selector = `[data-ts-probe="article-${i}"]`;
                const exists = await page.evaluate((sel) => !!document.querySelector(sel), selector);
                if (!exists) {
                    console.log(`article[${i}]: no post-level timestamp link`);
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
                        console.log(`article[${i}]: tooltip="${tooltipTs.text}" ts=${tooltipTs.ts}`);
                        articleTimestamps[i] = tooltipTs.ts;
                    } else {
                        console.log(`article[${i}]: tooltip not found or unparseable, using relative fallback`);
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
                    console.log(`article[${i}]: hover error — ${e.message}`);
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
                console.log('No timestamps resolved — falling back to article[0] (DOM order)');
            }
            console.log(`Latest article: index ${winnerIdx}`);

            // Step 4: check that article for video signals
            const videoCheck = await page.evaluate((idx) => {
                // Try multiple selectors for finding posts
                let articles = Array.from(document.querySelectorAll('[role="article"]'));
                if (articles.length === 0) {
                    articles = Array.from(document.querySelectorAll('[data-pagelet^="FeedUnit"]'));
                }
                if (articles.length === 0) {
                    articles = Array.from(document.querySelectorAll('div[tabindex="-1"][data-visualcompletion="ignore-dynamic"]'));
                }
                const root = articles[idx];
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

            console.log(`Video signals: ${JSON.stringify(videoCheck)}`);

            if (videoCheck.noArticle) {
                console.log('Article not found — bailing.');
                console.log(JSON.stringify({ error: 'no_image_found' }));
                return;
            }

            if (Object.values(videoCheck).some(Boolean)) {
                console.log('Latest post is a video. Skipping.');
                console.log(JSON.stringify({ error: 'no_image_found' }));
                return;
            }

            // Step 5: Extract text from the winning article
            const extractedText = await page.evaluate((idx) => {
                // Try multiple selectors for finding posts
                let articles = Array.from(document.querySelectorAll('[role="article"]'));
                if (articles.length === 0) {
                    articles = Array.from(document.querySelectorAll('[data-pagelet^="FeedUnit"]'));
                }
                if (articles.length === 0) {
                    articles = Array.from(document.querySelectorAll('div[tabindex="-1"][data-visualcompletion="ignore-dynamic"]'));
                }
                const article = articles[idx];
                if (!article) return '';

                // Try multiple selectors for post text
                const textEl = article.querySelector('[data-testid="post_message"]') ||
                              article.querySelector('.xdj266r.x11i5rnm.xat24cr.x1mh8g0r.x1vvkbs') ||
                              article.querySelector('div[data-ad-preview="message"]') ||
                              article.querySelector('[data-ad-comet-preview="message"]');
                
                if (!textEl) return '';
                
                let text = textEl.innerText.trim();
                // Clean up whitespace
                text = text.replace(/\s+/g, ' ').trim();
                return text;
            }, winnerIdx);

            // Store the extracted text
            fbPostText = extractedText;
            console.log(`Facebook post text: ${fbPostText.substring(0, 100)}...`);

            // Step 5: find the best image from network capture, scoped to the winning article.
            // We query images directly inside the latest article element — this naturally excludes
            // the banner, profile picture, and all other posts regardless of file type.
            const articleImageInfo = await page.evaluate((idx) => {
                // Try multiple selectors for finding posts
                let articles = Array.from(document.querySelectorAll('[role="article"]'));
                if (articles.length === 0) {
                    articles = Array.from(document.querySelectorAll('[data-pagelet^="FeedUnit"]'));
                }
                if (articles.length === 0) {
                    articles = Array.from(document.querySelectorAll('div[tabindex="-1"][data-visualcompletion="ignore-dynamic"]'));
                }
                const article = articles[idx];
                if (!article) return null;

                const imgs = Array.from(article.querySelectorAll('img[src*="fbcdn"]'));
                const results = [];

                for (const img of imgs) {
                    // Skip tiny avatars/icons
                    if (img.naturalWidth > 0 && img.naturalWidth < 100) continue;
                    if (img.width > 0 && img.width < 100) continue;

                    let photoHref = null;
                    let el = img.parentElement;
                    for (let i = 0; i < 15; i++) {
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

                    try {
                        const fn = new URL(img.src).pathname.split('/').pop();
                        results.push({ fn, photoHref, src: img.src });
                    } catch(_) {}
                }
                return results;
            }, winnerIdx);

            console.log(`[FALLBACK] Images inside winning article: ${JSON.stringify((articleImageInfo || []).map(x => x.fn))}`);

            if (!articleImageInfo || articleImageInfo.length === 0) {
                console.log('No images found inside winning article.');
                console.log(JSON.stringify({ error: 'no_image_found' }));
                return;
            }

            // Pick the largest captured buffer among images found in the winning article
            let bestFn = null, bestPhotoHref = null, bestSrc = null, bestSize = 0;
            for (const { fn, photoHref, src } of articleImageInfo) {
                const size = capturedImages[fn] ? capturedImages[fn].length : 0;
                console.log(`[FALLBACK]   ${fn}: ${size} bytes captured`);
                if (size > bestSize) {
                    bestSize = size;
                    bestFn = fn;
                    bestPhotoHref = photoHref;
                    bestSrc = src;
                }
            }

            if (!bestFn || bestSize < 5000) {
                console.log('No suitable post image captured from winning article.');
                console.log(JSON.stringify({ error: 'no_image_found' }));
                return;
            }
            targetFilename = bestFn;
            postImageInfo_resolved = { src: bestSrc, photoHref: bestPhotoHref };
            console.log(`Network fallback selected: ${targetFilename} (${bestSize} bytes)${bestPhotoHref ? ' [photo link found]' : ''}`);
        }

        // Phase 3: open the modal viewer by clicking the post image, then capture the
        // full-res image via a Puppeteer response listener.
        // Key points:
        //  - We NEVER navigate away (page.goto) — that triggers a login redirect.
        //  - We disable Puppeteer's cache before clicking so the modal's image request
        //    hits the network and fires a response event (cached responses emit nothing).
        //  - We avoid in-page fetch() which is blocked by fbcdn CORS headers.

        let fullResBuffer = null;

        // Disable cache NOW, before the click, so modal image requests go over the wire.
        await page.setCacheEnabled(false);
        process.stderr.write('[VIEWER] Cache disabled — modal image requests will hit network.\n');

        // Set up the response listener BEFORE clicking, so we don't miss early responses.
        let fullResBytes = 0;
        const modalResponseListener = async (response) => {
            try {
                if (response.status() !== 200) return;
                const url = response.url();
                if (!url.includes('fbcdn.net')) return;
                if (url.includes('rsrc.php')) return;
                const ct = response.headers()['content-type'] || '';
                if (!ct.startsWith('image/')) return;
                const fn = getFilename(url);
                if (!fn || fn.endsWith('.kf')) return;
                // Only accept the target image — carousel neighbours will also load but we ignore them
                if (fn !== targetFilename) {
                    process.stderr.write(`[VIEWER] Skipping non-target response: ${fn}\n`);
                    return;
                }
                const buffer = await response.buffer();
                if (buffer.length < 30000) return;
                process.stderr.write(`[VIEWER] Response captured: ${fn} (${buffer.length} bytes)\n`);
                if (buffer.length > fullResBytes) {
                    fullResBuffer = buffer;
                    fullResBytes = buffer.length;
                    process.stderr.write(`[VIEWER] → New best: ${fn} at ${buffer.length} bytes\n`);
                }
            } catch (_) {}
        };
        page.on('response', modalResponseListener);

        const navigateToViewer = async () => {
            // Always click the image on the feed page to open the modal viewer inline.
            // We never do a full page.goto() to the photo URL because Facebook redirects
            // direct photo navigations to the login page when using session cookies this way.
            // The modal opens within the already-authenticated feed page, so no re-auth occurs.

            const targetSrc = postImageInfo_resolved.src;
            const targetFn  = targetFilename;

            // Find the image in the DOM by src match, or fall back to filename match in src
            const clicked = await page.evaluate((src, fn) => {
                let img = null;
                if (src) {
                    img = Array.from(document.querySelectorAll('img[src*="fbcdn"]'))
                             .find(i => i.src === src);
                }
                if (!img && fn) {
                    img = Array.from(document.querySelectorAll('img[src*="fbcdn"]'))
                             .find(i => {
                                 try { return new URL(i.src).pathname.split('/').pop() === fn; }
                                 catch(_) { return false; }
                             });
                }
                if (!img) return 'not_found';

                // Walk up to find a clickable ancestor (link or role=link)
                let el = img;
                for (let i = 0; i < 12; i++) {
                    if (!el) break;
                    if (el.tagName === 'A' || el.getAttribute('role') === 'link') {
                        el.click();
                        return 'clicked_ancestor';
                    }
                    el = el.parentElement;
                }
                img.click();
                return 'clicked_img';
            }, targetSrc, targetFn);

            process.stderr.write(`[VIEWER] Click result: ${clicked}\n`);

            if (clicked === 'not_found') {
                process.stderr.write('[VIEWER] Image not found in DOM — cannot open modal.\n');
                return false;
            }

            // Wait for the modal/dialog to appear in the DOM
            try {
                await page.waitForSelector('[role="dialog"] img[src*="fbcdn"], [role="main"] img[src*="fbcdn.net/v"]', { timeout: 8000 });
                process.stderr.write('[VIEWER] Modal detected.\n');
            } catch (_) {
                process.stderr.write('[VIEWER] Modal wait timed out — proceeding anyway.\n');
            }

            return true;
        };

        const didNavigate = await navigateToViewer();

        if (didNavigate) {
            // Wait for the modal's full-res image to arrive over the network.
            // The response listener above will populate fullResBuffer as responses come in.
            process.stderr.write('[VIEWER] Waiting for modal image responses...\n');
            await new Promise(r => setTimeout(r, 5000));
            process.stderr.write(`[VIEWER] Wait complete. Best response so far: ${fullResBytes} bytes\n`);

            // Diagnostic: dump what's in the modal DOM for debugging
            const modalImgs = await page.evaluate(() => {
                const dialog = document.querySelector('[role="dialog"]');
                const root = dialog || document;
                return Array.from(root.querySelectorAll('img[src*="fbcdn"]')).map(img => ({
                    fn: (() => { try { return new URL(img.src).pathname.split('/').pop(); } catch(_) { return '?'; } })(),
                    naturalW: img.naturalWidth,
                    naturalH: img.naturalHeight,
                    complete: img.complete,
                }));
            });
            process.stderr.write(`[VIEWER DIAG] Modal DOM imgs (${modalImgs.length}):\n`);
            modalImgs.forEach((img, idx) => {
                process.stderr.write(`  [${idx}] ${img.naturalW}x${img.naturalH} complete=${img.complete} fn=${img.fn}\n`);
            });
        }

        page.off('response', modalResponseListener);

        // Validate we have a target filename
        if (!targetFilename) {
            process.stderr.write('No target filename selected — cannot retrieve image.\n');
            console.log(JSON.stringify({ error: 'no_image_selected' }));
            return;
        }

        // Pick the best buffer: full-res from viewer if larger than feed capture, else feed capture
        const feedBuffer = capturedImages[targetFilename];

        if (fullResBuffer && fullResBuffer.length > (feedBuffer ? feedBuffer.length : 0)) {
            process.stderr.write(`Using full-res viewer image: ${fullResBuffer.length} bytes\n`);
            fs.writeFileSync(OUTPUT_FILE, fullResBuffer);
        } else if (feedBuffer) {
            process.stderr.write(`Using feed capture: ${feedBuffer.length} bytes\n`);
            fs.writeFileSync(OUTPUT_FILE, feedBuffer);
        } else {
            process.stderr.write('No image buffer available.\n');
            console.log(JSON.stringify({ error: 'download_failed' }));
            return;
        }

        console.log(JSON.stringify({ imagePath: OUTPUT_FILE, text: fbPostText }));

    } catch (error) {
        process.stderr.write(`Facebook scraper error: ${error.message}\n`);
        console.log(JSON.stringify({ error: error.message }));
    } finally {
        await browser.close();
    }
}

getLatestFacebookImage();
