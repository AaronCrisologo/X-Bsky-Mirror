process.stdout.setEncoding('utf8');
process.stderr.setEncoding('utf8');

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());

const FB_PAGE_URL = 'https://www.facebook.com/FateGO.USA';
const OUTPUT_FILE = 'facebook_img.jpg';

// Facebook session cookies — same pattern as X's auth_token/ct0.
// Add FB_C_USER and FB_XS as GitHub Actions secrets.
// To get these: log into Facebook in Chrome → DevTools → Application →
// Cookies → facebook.com → copy values for "c_user" and "xs".
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

        // Inject session cookies before navigating — this is what gives us a logged-in
        // session so Facebook serves full-resolution images instead of compressed previews.
        await page.setCookie(...rawCookies);

        // Intercept all fbcdn image responses, store by filename keeping the largest buffer.
        // With a logged-in session Facebook loads the full-res post image directly in the
        // feed — we capture those bytes as they arrive so we never need to re-fetch.
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
                    process.stderr.write(`Captured ${filename} (${buffer.length} bytes)\n`);
                }
            } catch (_) {}
        });

        await page.goto(FB_PAGE_URL, { waitUntil: 'networkidle2', timeout: 30000 });

        // No cookie/login popups expected with a valid session, but dismiss just in case
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

        // Use the original v1 DOM selector that reliably identifies the correct post image.
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
        process.stderr.write(`DOM identified post image: ${targetFilename}\n`);

        // Use the intercepted buffer for this exact filename.
        // With a logged-in session this will be the full-resolution version.
        const buffer = capturedImages[targetFilename];

        if (buffer) {
            process.stderr.write(`Saving intercepted image: ${buffer.length} bytes\n`);
            fs.writeFileSync(OUTPUT_FILE, buffer);
            console.log(JSON.stringify({ imagePath: OUTPUT_FILE }));
        } else {
            // Fallback: image wasn't intercepted (e.g. lazy loaded after networkidle2).
            // page.goto() with the session cookies still active should work fine here.
            process.stderr.write(`No intercepted buffer for ${targetFilename}, downloading directly.\n`);
            const response = await page.goto(imageUrl, { waitUntil: 'networkidle0', timeout: 15000 });
            if (response && response.ok()) {
                const dlBuffer = await response.buffer();
                fs.writeFileSync(OUTPUT_FILE, dlBuffer);
                process.stderr.write(`Saved via direct download: ${dlBuffer.length} bytes\n`);
                console.log(JSON.stringify({ imagePath: OUTPUT_FILE }));
            } else {
                process.stderr.write(`Direct download failed (status: ${response?.status()})\n`);
                console.log(JSON.stringify({ error: 'download_failed' }));
            }
        }

    } catch (error) {
        process.stderr.write(`Facebook scraper error: ${error.message}\n`);
        console.log(JSON.stringify({ error: error.message }));
    } finally {
        await browser.close();
    }
}

getLatestFacebookImage();
