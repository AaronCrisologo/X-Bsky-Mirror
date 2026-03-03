process.stdout.setEncoding('utf8');
process.stderr.setEncoding('utf8');

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());

const FB_PAGE_URL = 'https://www.facebook.com/FateGO.USA';
const OUTPUT_FILE = 'facebook_img.jpg';

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

        // Intercept ALL fbcdn image responses as the page loads.
        // Facebook generates separate signed URLs for each resolution —
        // we can't modify a signed URL. Instead we collect every fbcdn image
        // URL the browser actually fetches and pick the largest one.
        const capturedImages = []; // { url, size }

        await page.setRequestInterception(true);
        page.on('request', req => req.continue());

        page.on('response', async (res) => {
            const url = res.url();
            const contentType = res.headers()['content-type'] || '';
            if (
                url.includes('fbcdn.net') &&
                contentType.startsWith('image/') &&
                // Only full-res candidates: no stp param, or stp without a small size
                !url.includes('stp=dst-jpg_s') &&
                !url.includes('stp=p') &&
                !url.includes('_profile_') &&
                !url.includes('_icon')
            ) {
                const length = parseInt(res.headers()['content-length'] || '0');
                process.stderr.write(`Captured candidate: ${length} bytes — ${url}\n`);
                capturedImages.push({ url, size: length });
            }
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

        // Also search the page HTML for full-res fbcdn URLs embedded in JSON blobs.
        // Facebook stores image metadata as JSON inside <script> tags.
        const scriptImages = await page.evaluate(() => {
            const results = [];
            const scripts = Array.from(document.querySelectorAll('script'));
            for (const script of scripts) {
                const text = script.textContent || '';
                // Match fbcdn URLs that don't have stp resizing
                const matches = text.match(/https:\\\/\\\/[^"\\]+fbcdn\.net\\\/[^"\\]+_n\.jpg[^"\\]*/g) || [];
                for (const m of matches) {
                    // Unescape JSON-encoded URL
                    try {
                        const url = JSON.parse(`"${m}"`);
                        if (!url.includes('stp=') && url.includes('_n.jpg')) {
                            results.push(url);
                        }
                    } catch (_) {}
                }
            }
            return results;
        });

        process.stderr.write(`Script-embedded image URLs found: ${scriptImages.length}\n`);

        // Combine network-captured and script-embedded candidates
        // Prefer captured ones (they have size info), fall back to script ones
        let bestUrl = null;

        if (capturedImages.length > 0) {
            // Sort by size descending — largest = highest res
            capturedImages.sort((a, b) => b.size - a.size);
            bestUrl = capturedImages[0].url;
            process.stderr.write(`Best captured image (${capturedImages[0].size} bytes): ${bestUrl}\n`);
        }

        if (!bestUrl && scriptImages.length > 0) {
            bestUrl = scriptImages[0];
            process.stderr.write(`Using script-embedded URL: ${bestUrl}\n`);
        }

        // Last resort: fall back to the DOM thumbnail (low-res but working)
        if (!bestUrl) {
            process.stderr.write('No high-res URL found, falling back to DOM thumbnail.\n');
            bestUrl = await page.evaluate(() => {
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
        }

        if (!bestUrl) {
            process.stderr.write('No image found at all.\n');
            console.log(JSON.stringify({ error: 'no_image_found' }));
            return;
        }

        process.stderr.write(`Downloading: ${bestUrl}\n`);

        // Download using page.goto — URL is already a valid signed URL, no modifications
        const response = await page.goto(bestUrl, {
            waitUntil: 'networkidle0',
            timeout: 15000
        });

        if (response && response.ok()) {
            const buffer = await response.buffer();
            fs.writeFileSync(OUTPUT_FILE, buffer);
            process.stderr.write(`Saved to ${OUTPUT_FILE}\n`);
            console.log(JSON.stringify({ imagePath: OUTPUT_FILE }));
        } else {
            process.stderr.write(`Download failed: ${response?.status()}\n`);
            console.log(JSON.stringify({ error: 'download_failed' }));
        }

    } catch (error) {
        process.stderr.write(`Facebook scraper error: ${error.message}\n`);
        console.log(JSON.stringify({ error: error.message }));
    } finally {
        await browser.close();
    }
}

getLatestFacebookImage();
