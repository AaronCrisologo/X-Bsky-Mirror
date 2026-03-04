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
        
        // Phase 2: DOM identifies the correct post image element
        const postImageInfo = await page.evaluate(() => {
            const latestPost = document.querySelector('[data-pagelet="TimelineFeedUnit_0"]');
        
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
        
            const candidates = imgs.map(img => {
                let photoHref = null;
                let el = img;
                for (let i = 0; i < 8; i++) {
                    if (!el) break;
                    if (el.tagName === 'A' && el.href && el.href.includes('/photo')) {
                        photoHref = el.href;
                        break;
                    }
                    el = el.parentElement;
                }
                return { src: img.src, photoHref };
            });
        
            return { candidates };
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
