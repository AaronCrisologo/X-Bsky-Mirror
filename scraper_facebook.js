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

        // Intercept responses BEFORE navigating so we catch everything that loads.
        // When Facebook renders the feed, it requests the post images directly —
        // we capture those bytes as they arrive, no re-fetching needed.
        let capturedBuffer = null;
        let capturedUrl = null;

        page.on('response', async (response) => {
            try {
                const url = response.url();
                const status = response.status();

                // Only care about successful fbcdn image responses
                if (status !== 200) return;
                if (!url.includes('fbcdn.net')) return;

                const ct = response.headers()['content-type'] || '';
                if (!ct.startsWith('image/')) return;

                // Skip static UI assets (rsrc.php = icons, sprites, etc.)
                if (url.includes('rsrc.php')) return;

                // Skip tiny avatar/icon images — profile pics use _n.jpg with cp0 crop
                // and are very small. Post images use t39.30808 content type.
                if (!url.includes('t39.30808')) return;

                // Skip anything with avatar/profile-pic sizing in stp param
                const stpMatch = url.match(/stp=([^&]+)/);
                if (stpMatch) {
                    const stp = stpMatch[1];
                    // Avatar crops look like c197.0.506.506a — post images don't have this
                    if (stp.includes('_s40x40') || stp.includes('_s60x60') || stp.includes('_s80x80')) return;
                    // Skip cover/banner — they have very wide crop ratios or specific flags
                    if (stp.includes('cp0') && stp.includes('506')) return;
                }

                const buffer = await response.buffer();

                // Only keep images larger than 20KB — rules out thumbnails and icons
                if (buffer.length < 20000) return;

                // Keep the largest image we find — prefer post images over smaller ones
                if (!capturedBuffer || buffer.length > capturedBuffer.length) {
                    capturedBuffer = buffer;
                    capturedUrl = url;
                    process.stderr.write(`Captured post image (${buffer.length} bytes): ${url}\n`);
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

        // Scroll to trigger lazy-loaded feed images
        await new Promise(r => setTimeout(r, 2000));
        await page.evaluate(() => window.scrollBy(0, 500));
        await new Promise(r => setTimeout(r, 3000));

        if (!capturedBuffer) {
            process.stderr.write('No post image was intercepted during page load.\n');
            console.log(JSON.stringify({ error: 'no_image_found' }));
            return;
        }

        // --- Attempt to get a higher resolution version ---
        // The stp param controls resize: s565x565 → try s2048x2048.
        // The oh= hash may or may not cover stp. We try — if it 403s we keep what we have.
        if (capturedUrl && capturedUrl.includes('stp=')) {
            const higherResUrl = capturedUrl.replace(
                /stp=dst-jpg_s\d+x\d+/,
                'stp=dst-jpg_s2048x2048'
            );

            if (higherResUrl !== capturedUrl) {
                process.stderr.write(`Trying higher-res stp: ${higherResUrl}\n`);
                try {
                    // Use a plain https request via Puppeteer CDP - avoids CORS, keeps cookies
                    const cdpSession = await page.createCDPSession();
                    const result = await cdpSession.send('Network.loadNetworkResource', {
                        url: higherResUrl,
                        frameId: page.mainFrame()._id || '',
                        options: { disableCache: false, includeCredentials: true }
                    });

                    if (result && result.resource && result.resource.success) {
                        process.stderr.write('Higher-res stp fetch succeeded via CDP.\n');
                        // If CDP resource fetch worked, navigate to get the bytes
                        const hResponse = await page.goto(higherResUrl, {
                            waitUntil: 'networkidle0',
                            timeout: 15000
                        });
                        if (hResponse && hResponse.ok()) {
                            const hBuffer = await hResponse.buffer();
                            if (hBuffer.length > capturedBuffer.length) {
                                capturedBuffer = hBuffer;
                                process.stderr.write(`Using higher-res image (${hBuffer.length} bytes).\n`);
                            }
                        }
                    }
                } catch (e) {
                    process.stderr.write(`Higher-res attempt failed (expected): ${e.message}\n`);
                    // Keep the already-captured buffer — this is fine
                }
            }
        }

        fs.writeFileSync(OUTPUT_FILE, capturedBuffer);
        process.stderr.write(`Saved to ${OUTPUT_FILE} (${capturedBuffer.length} bytes)\n`);
        console.log(JSON.stringify({ imagePath: OUTPUT_FILE }));

    } catch (error) {
        process.stderr.write(`Facebook scraper error: ${error.message}\n`);
        console.log(JSON.stringify({ error: error.message }));
    } finally {
        await browser.close();
    }
}

getLatestFacebookImage();
