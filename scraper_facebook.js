process.stdout.setEncoding('utf8');
process.stderr.setEncoding('utf8');

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());

const FB_PAGE_URL = 'https://www.facebook.com/FateGO.USA';
const OUTPUT_FILE = 'facebook_img.jpg';

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

        // Track all intercepted images keyed by filename, keeping the largest buffer.
        // Also track the ORDER in which filenames first appear — post images load before
        // the banner's full-res version, so first-seen order is a useful signal.
        const capturedImages = {};   // filename → { buffer, url }
        const captureOrder = [];     // filenames in order of first capture, for fallback

        page.on('response', async (response) => {
            try {
                if (response.status() !== 200) return;
                const url = response.url();
                if (!url.includes('fbcdn.net')) return;
                const ct = response.headers()['content-type'] || '';
                if (!ct.startsWith('image/')) return;
                if (url.includes('rsrc.php')) return;
                if (!url.includes('t39.30808')) return; // post images only

                const filename = getFilename(url);
                if (!filename) return;

                const buffer = await response.buffer();
                if (buffer.length < 1000) return; // skip empty/broken responses

                if (!capturedImages[filename]) {
                    captureOrder.push(filename);
                    capturedImages[filename] = { buffer, url };
                } else if (buffer.length > capturedImages[filename].buffer.length) {
                    // Same image loaded at higher res — upgrade
                    capturedImages[filename] = { buffer, url };
                }

                process.stderr.write(`Stored ${filename} (${buffer.length} bytes)\n`);
            } catch (_) {}
        });

        await page.goto(FB_PAGE_URL, { waitUntil: 'networkidle2', timeout: 30000 });

        // Dismiss popups
        try {
            const declineBtn = await page.$('[data-cookiebanner="accept_only_essential_button"]');
            if (declineBtn) await declineBtn.click();
        } catch (_) {}
        try {
            const closeBtn = await page.$('[aria-label="Close"]');
            if (closeBtn) await closeBtn.click();
        } catch (_) {}

        await new Promise(r => setTimeout(r, 2000));
        await page.evaluate(() => window.scrollBy(0, 500));
        await new Promise(r => setTimeout(r, 3000));

        // --- Strategy 1: DOM selector to identify exact post image filename ---
        const postImageUrl = await page.evaluate(() => {
            // Try many selectors from most to least specific
            const selectors = [
                '[data-pagelet="FeedUnit_0"] img[src*="fbcdn"]',
                '[data-pagelet^="FeedUnit"] img[src*="fbcdn"]',
                '[role="feed"] img[src*="fbcdn"]',
                '[data-pagelet="ProfileTimeline"] img[src*="fbcdn"]',
                'div[data-ad-preview] img[src*="fbcdn"]',
                // Last resort: any fbcdn img not inside the cover photo or profile pic areas
                'img[src*="t39.30808"]',
            ];

            // Also log all data-pagelet values present on the page to help debug
            const pagelets = Array.from(document.querySelectorAll('[data-pagelet]'))
                .map(el => el.getAttribute('data-pagelet'));
            console.log('PAGELETS:' + JSON.stringify(pagelets));

            for (const selector of selectors) {
                const imgs = Array.from(document.querySelectorAll(selector));
                const postImg = imgs.find(img => {
                    // Skip profile pics (circular avatars) - they use _n.jpg with very small dimensions
                    const src = img.src || '';
                    if (src.includes('profile') || src.includes('_s40x40') || src.includes('_s60x60')) return false;

                    const w = img.naturalWidth || parseInt(img.getAttribute('width') || '0');
                    const h = img.naturalHeight || parseInt(img.getAttribute('height') || '0');
                    return w > 100 && h > 100;
                });
                if (postImg) {
                    console.log('MATCHED_SELECTOR:' + selector);
                    return postImg.src;
                }
            }
            return null;
        });

        // Capture pagelet debug info from console
        page.on('console', msg => {
            const text = msg.text();
            if (text.startsWith('PAGELETS:') || text.startsWith('MATCHED_SELECTOR:')) {
                process.stderr.write(`DOM debug: ${text}\n`);
            }
        });

        let targetFilename = null;

        if (postImageUrl) {
            targetFilename = getFilename(postImageUrl);
            process.stderr.write(`DOM identified: ${targetFilename}\n`);
        } else {
            process.stderr.write('DOM selector failed — using first-captured fallback.\n');
        }

        // --- Strategy 2: First-captured fallback ---
        // Post images load before the banner's full-res in the network waterfall.
        // Pick the first captured image that isn't a tiny avatar.
        if (!targetFilename) {
            for (const filename of captureOrder) {
                const entry = capturedImages[filename];
                if (entry && entry.buffer.length > 5000) {
                    targetFilename = filename;
                    process.stderr.write(`First-capture fallback chose: ${targetFilename}\n`);
                    break;
                }
            }
        }

        if (!targetFilename) {
            process.stderr.write('No image could be identified.\n');
            console.log(JSON.stringify({ error: 'no_image_found' }));
            return;
        }

        const captured = capturedImages[targetFilename];
        if (!captured) {
            process.stderr.write(`No intercepted bytes for ${targetFilename}.\n`);
            console.log(JSON.stringify({ error: 'no_intercepted_image' }));
            return;
        }

        process.stderr.write(`Saving ${targetFilename} (${captured.buffer.length} bytes)\n`);
        fs.writeFileSync(OUTPUT_FILE, captured.buffer);
        console.log(JSON.stringify({ imagePath: OUTPUT_FILE }));

    } catch (error) {
        process.stderr.write(`Facebook scraper error: ${error.message}\n`);
        console.log(JSON.stringify({ error: error.message }));
    } finally {
        await browser.close();
    }
}

getLatestFacebookImage();
