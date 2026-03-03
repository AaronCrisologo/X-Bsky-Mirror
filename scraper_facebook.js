process.stdout.setEncoding('utf8');
process.stderr.setEncoding('utf8');

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());

const FB_PAGE_URL = 'https://www.facebook.com/FateGO.USA';
const OUTPUT_FILE = 'facebook_img.jpg';

// Extract just the filename from a CDN URL, e.g.
// "643884790_1004169902268124_8398176244651588543_n.jpg"
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

        // Intercept all fbcdn image responses and store them keyed by filename.
        // Multiple versions of the same image may load (thumbnail + full-res) —
        // we keep the largest buffer per filename.
        const capturedImages = {}; // filename → { buffer, url }

        page.on('response', async (response) => {
            try {
                if (response.status() !== 200) return;
                const url = response.url();
                if (!url.includes('fbcdn.net')) return;
                const ct = response.headers()['content-type'] || '';
                if (!ct.startsWith('image/')) return;
                if (url.includes('rsrc.php')) return;

                const filename = getFilename(url);
                if (!filename) return;

                const buffer = await response.buffer();

                // Keep the largest version of each unique image file
                if (!capturedImages[filename] || buffer.length > capturedImages[filename].buffer.length) {
                    capturedImages[filename] = { buffer, url };
                    process.stderr.write(`Stored ${filename} (${buffer.length} bytes)\n`);
                }
            } catch (_) {}
        });

        await page.goto(FB_PAGE_URL, { waitUntil: 'networkidle2', timeout: 30000 });

        // Dismiss cookie/login popups
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

        // Use the original DOM selector to identify the correct post image URL.
        // FeedUnit_0 targets the actual feed, not the banner/header.
        const postImageUrl = await page.evaluate(() => {
            const selectors = [
                '[data-pagelet="FeedUnit_0"] img[src*="fbcdn"]',
                '[data-pagelet^="FeedUnit"] img[src*="fbcdn"]',
            ];
            for (const selector of selectors) {
                const imgs = Array.from(document.querySelectorAll(selector));
                const postImg = imgs.find(img => {
                    const w = img.naturalWidth || parseInt(img.getAttribute('width') || '0');
                    const h = img.naturalHeight || parseInt(img.getAttribute('height') || '0');
                    return w > 200 && h > 200;
                });
                if (postImg) return postImg.src;
            }
            return null;
        });

        if (!postImageUrl) {
            process.stderr.write('DOM selector found no post image.\n');
            console.log(JSON.stringify({ error: 'no_image_found' }));
            return;
        }

        const targetFilename = getFilename(postImageUrl);
        process.stderr.write(`DOM identified post image filename: ${targetFilename}\n`);

        // Look up the intercepted bytes for exactly this filename.
        // This gives us the full-res version Facebook already loaded — no re-fetching needed.
        const captured = capturedImages[targetFilename];

        if (!captured) {
            process.stderr.write(`No intercepted bytes found for ${targetFilename}.\n`);
            console.log(JSON.stringify({ error: 'no_intercepted_image' }));
            return;
        }

        process.stderr.write(`Using intercepted image: ${captured.url} (${captured.buffer.length} bytes)\n`);
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
