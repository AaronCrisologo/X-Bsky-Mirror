process.stdout.setEncoding('utf8');
process.stderr.setEncoding('utf8');

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());

const FB_PAGE_URL = 'https://www.facebook.com/ZZZ.Official.EN';
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
     // Warn if cookies are missing — scraper will still work but images will be low-res
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

        // Phase 1: capture all feed-load images keyed by filename (for fallback)
        const capturedImages = {};

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
        await new Promise(r => setTimeout(r, 4000));

        // TEMPORARY DEBUG
        const debugInfo = await page.evaluate(() => {
            const articles = Array.from(document.querySelectorAll('[role="article"]'));
            
            return {
                totalArticles: articles.length,
                articleDetails: articles.map((a, i) => {
                    const allImgs = Array.from(a.querySelectorAll('img'));
                    return {
                        index: i,
                        imgCount: allImgs.length,
                        srcs: allImgs.map(img => ({
                            src: img.src ? img.src.substring(0, 80) : '',
                            dataSrc: img.getAttribute('data-src') ? img.getAttribute('data-src').substring(0, 80) : '',
                            lazy: img.getAttribute('loading'),
                        })),
                        hasVideo: !!a.querySelector('video, a[href*="/videos/"], a[href*="/reel/"]'),
                        outerHTMLSnippet: a.innerHTML.substring(0, 300)
                    };
                })
            };
        });
        process.stderr.write(`DEBUG Articles: ${JSON.stringify(debugInfo, null, 2)}\n`);
        
        // Phase 2: DOM identifies the correct post image element
        const postImageInfo = await page.evaluate(() => {
            // Try known pagelet names in order of preference
            const pageletNames = ['FeedUnit_0', 'TimelineFeedUnit_0', 'ProfileTimelineFeedUnit_0'];
            let latestPost = null;
            for (const name of pageletNames) {
                latestPost = document.querySelector(`[data-pagelet="${name}"]`);
                if (latestPost) break;
            }
        
            // Final fallback: first role=article that contains an fbcdn image
            if (!latestPost) {
                const articles = Array.from(document.querySelectorAll('[role="article"]'));
                latestPost = articles.find(a => a.querySelector('img[src*="fbcdn"]')) || null;
            }
        
            if (!latestPost) return null;
        
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
        
            // Collect ALL fbcdn imgs — don't require a /photo link
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
            
            // Filter out known non-post images (profile pics, icons) by src patterns
            const filtered = candidates.filter(c =>
                !c.src.includes('_s.jpg') &&   // small/square profile crops
                !c.src.includes('p40x40') &&
                !c.src.includes('p50x50') &&
                !c.src.includes('p60x60')
            );
            
            return { candidates: filtered.length ? filtered : candidates };
        });
        
        if (!postImageInfo) {
            process.stderr.write('No photo-linked images found on Facebook page.\n');
            console.log(JSON.stringify({ error: 'no_image_found' }));
            return;
        }

        // Add this check right after:
        if (postImageInfo.isVideo) {
            process.stderr.write('Latest post is a video. Skipping.\n');
            console.log(JSON.stringify({ error: 'no_image_found' }));
            return;
        }
        
        if (!postImageInfo.candidates || postImageInfo.candidates.length === 0) {
            process.stderr.write('No photo-linked images found on Facebook page.\n');
            console.log(JSON.stringify({ error: 'no_image_found' }));
            return;
        }
        
        // The first candidate in DOM order belongs to the latest post
        const firstCandidate = postImageInfo.candidates[0];
        process.stderr.write(`First post candidate: ${getFilename(firstCandidate.src)}\n`);
        
        const buf = capturedImages[getFilename(firstCandidate.src)];
        const size = buf ? buf.length : 0;
        
        if (size < 10000) {
            process.stderr.write(`Image too small (${size} bytes), likely not a post image.\n`);
            console.log(JSON.stringify({ error: 'no_image_found' }));
            return;
        }
        
        const targetFilename = getFilename(firstCandidate.src);
        const postImageInfo_resolved = { src: firstCandidate.src, photoHref: firstCandidate.photoHref };
        process.stderr.write(`Selected post image: ${targetFilename} (${size} bytes)\n`);

        // Phase 3: click through to the photo viewer to get the full-res image
        // We set up a NEW response listener that only triggers after the click,
        // so we catch exactly the full-res image Facebook loads in the viewer.
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
                // Only care about the specific image we identified
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

        // Navigate to the photo viewer — if we found a /photo link use it directly,
        // otherwise click the image itself
        if (postImageInfo_resolved.photoHref) {
            process.stderr.write(`Navigating to photo viewer: ${postImageInfo_resolved.photoHref}\n`);
            await page.goto(postImageInfo_resolved.photoHref, { waitUntil: 'networkidle2', timeout: 30000 });
        } else {
            process.stderr.write('Clicking post image to open viewer...\n');
            await page.evaluate((targetSrc) => {
                const imgs = Array.from(document.querySelectorAll('img[src*="fbcdn"]'));
                const img = imgs.find(i => i.src === targetSrc);
                if (img) {
                    // Try clicking the wrapping element
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
