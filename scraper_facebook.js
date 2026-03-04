process.stdout.setEncoding('utf8');
process.stderr.setEncoding('utf8');

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());

const FB_PAGE_URL = 'https://www.facebook.com/ArknightsGlobal';
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
        await new Promise(r => setTimeout(r, 2000));

        // TEMPORARY DEBUG — remove after diagnosis
        const debugInfo = await page.evaluate(() => {
            const fp0 = document.querySelector('[data-pagelet="FeedUnit_0"]');
            if (!fp0) {
                // Check what pagelets actually exist
                const allPagelets = Array.from(document.querySelectorAll('[data-pagelet]'))
                    .map(el => el.getAttribute('data-pagelet'))
                    .filter(p => p.includes('Feed'));
                return { fp0Exists: false, feedPagelets: allPagelets };
            }
            const imgs = Array.from(fp0.querySelectorAll('img'));
            const videoSignals = {
                video: !!fp0.querySelector('video'),
                dataVideoId: !!fp0.querySelector('[data-video-id]'),
                ariaPlayVideo: !!fp0.querySelector('[aria-label="Play video"]'),
                ariaPlay: !!fp0.querySelector('[aria-label="Play"]'),
                videoLink: !!fp0.querySelector('a[href*="/videos/"]'),
                reelLink: !!fp0.querySelector('a[href*="/reel/"]'),
            };
            return {
                fp0Exists: true,
                videoSignals,
                imgCount: imgs.length,
                imgSrcs: imgs.map(i => i.src).filter(s => s.includes('fbcdn')),
            };
        });
        process.stderr.write(`DEBUG FeedUnit_0: ${JSON.stringify(debugInfo, null, 2)}\n`);
        
        // Phase 2: find the best post image without relying on data-pagelet
        const postImageInfo = await page.evaluate(() => {
            // Find all fbcdn imgs that sit inside a /photo link — these are post images, not avatars/icons
            const imgs = Array.from(document.querySelectorAll('img[src*="fbcdn"]'));
        
            const candidates = [];
            for (const img of imgs) {
                let photoHref = null;
                let postContainer = null;
                let el = img;
                for (let i = 0; i < 12; i++) {
                    if (!el) break;
                    if (!photoHref && el.tagName === 'A' && el.href && el.href.includes('/photo')) {
                        photoHref = el.href;
                    }
                    // Look for a post-level container (role=article or common feed wrappers)
                    if (!postContainer && (
                        el.getAttribute('role') === 'article' ||
                        el.getAttribute('data-testid') === 'post_message' ||
                        (el.tagName === 'DIV' && el.getAttribute('aria-posinset') !== null)
                    )) {
                        postContainer = el;
                    }
                    el = el.parentElement;
                }
        
                // Only include images that have a /photo link parent
                if (!photoHref) continue;
        
                // Check the post container (or nearest ancestors) for video signals
                const searchRoot = postContainer || img.closest('div[role="feed"] > div') || img.parentElement;
                const hasVideo = searchRoot && (
                    searchRoot.querySelector('video') !== null ||
                    searchRoot.querySelector('[data-video-id]') !== null ||
                    searchRoot.querySelector('a[href*="/videos/"]') !== null ||
                    searchRoot.querySelector('a[href*="/reel/"]') !== null ||
                    searchRoot.querySelector('[aria-label="Play video"]') !== null
                );
        
                candidates.push({ src: img.src, photoHref, hasVideo: !!hasVideo });
            }
        
            return candidates;
        });
        
        if (!postImageInfo || postImageInfo.length === 0) {
            process.stderr.write('No photo-linked images found on Facebook page.\n');
            console.log(JSON.stringify({ error: 'no_image_found' }));
            return;
        }
        
        // Pick the largest captured image among candidates that aren't in a video post
        let bestSrc = null;
        let bestPhotoHref = null;
        let bestSize = 0;
        
        for (const { src, photoHref, hasVideo } of postImageInfo) {
            if (hasVideo) continue;
            const filename = getFilename(src);
            const buf = capturedImages[filename];
            const size = buf ? buf.length : 0;
            process.stderr.write(`Candidate: ${filename} (${size} bytes, video=${hasVideo})\n`);
            if (size > bestSize) {
                bestSize = size;
                bestSrc = src;
                bestPhotoHref = photoHref;
            }
        }
        
        if (!bestSrc || bestSize < 10000) {
            process.stderr.write('No suitable post image found (all posts may be videos or images too small).\n');
            console.log(JSON.stringify({ error: 'no_image_found' }));
            return;
        }
        
        const targetFilename = getFilename(bestSrc);
        const postImageInfo_resolved = { src: bestSrc, photoHref: bestPhotoHref };
        process.stderr.write(`Selected post image: ${targetFilename} (${bestSize} bytes)\n`);

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
