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

        // Intercept all fbcdn image responses and store by filename.
        // We keep the largest buffer seen per filename (Facebook often loads
        // a small thumbnail first, then a larger version — we want the largest).
        const capturedImages = {}; // filename → largest buffer seen

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
        await page.evaluate(() => window.scrollBy(0, 400));
        await new Promise(r => setTimeout(r, 2000));

        // Original working DOM selector — unchanged from first implementation
        const imageUrl = await page.evaluate(() => {
            const selectors = [
                '[data-pagelet="FeedUnit_0"] img[src*="fbcdn"]',
                '[data-pagelet^="FeedUnit"] img[src*="fbcdn"]',
                'img[src*="fbcdn"][width]'
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

        if (!imageUrl) {
            process.stderr.write('No suitable post image found on Facebook page.\n');
            console.log(JSON.stringify({ error: 'no_image_found' }));
            return;
        }

        const targetFilename = getFilename(imageUrl);
        process.stderr.write(`DOM identified: ${targetFilename}\n`);

        // Look up the intercepted buffer for this exact filename.
        // This avoids re-fetching the URL (which would 403 without the session)
        // and gives us the largest version Facebook already loaded.
        const buffer = capturedImages[targetFilename];

        if (!buffer) {
            process.stderr.write(`No intercepted bytes for ${targetFilename} — falling back to direct download.\n`);
            // Last resort: direct download with original URL (will be low-res but works)
            const response = await page.goto(imageUrl, { waitUntil: 'networkidle0', timeout: 15000 });
            if (response && response.ok()) {
                const fallbackBuffer = await response.buffer();
                fs.writeFileSync(OUTPUT_FILE, fallbackBuffer);
                process.stderr.write(`Saved via direct download (${fallbackBuffer.length} bytes)\n`);
                console.log(JSON.stringify({ imagePath: OUTPUT_FILE }));
            } else {
                console.log(JSON.stringify({ error: 'download_failed' }));
            }
            return;
        }

        process.stderr.write(`Saving intercepted image: ${targetFilename} (${buffer.length} bytes)\n`);
        fs.writeFileSync(OUTPUT_FILE, buffer);
        console.log(JSON.stringify({ imagePath: OUTPUT_FILE }));

    } catch (error) {
        process.stderr.write(`Facebook scraper error: ${error.message}\n`);
        console.log(JSON.stringify({ error: error.message }));
    } finally {
        await browser.close();
    }
}

getLatestFacebookImage();
