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

        // --- Intercept network requests to catch the high-res image URL ---
        // When the photo viewer opens, Facebook requests the full-res image.
        // We listen for that request before we even click.
        let capturedImageUrl = null;

        await page.setRequestInterception(true);
        page.on('request', req => {
            req.continue();
        });
        page.on('response', async res => {
            const url = res.url();
            const contentType = res.headers()['content-type'] || '';

            // We want large fbcdn image responses (not tiny icons/avatars)
            if (
                url.includes('fbcdn.net') &&
                contentType.startsWith('image/') &&
                // Facebook high-res photos have these patterns in their URL
                (url.includes('_n.') || url.includes('_o.') || url.includes('&oh=')) &&
                !capturedImageUrl  // Only capture the first one after click
            ) {
                // Check content-length if available to prefer larger images
                const length = parseInt(res.headers()['content-length'] || '0');
                if (length > 50000 || length === 0) { // > 50KB or unknown size
                    capturedImageUrl = url;
                    process.stderr.write(`Intercepted image: ${url}\n`);
                }
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

        // Reset capture — we only want images loaded AFTER we click the post photo
        capturedImageUrl = null;

        // --- Find a post image, explicitly excluding the profile header area ---
        const imageClicked = await page.evaluate(() => {
            // Facebook profile headers / banners sit inside these containers
            const headerSelectors = [
                '[data-pagelet="ProfileTilesFeed_0"]',
                '[data-pagelet="ProfileTilesFeed"]',
                '[data-pagelet="ProfileCoverPhoto"]',
                'header',
            ];
            const headerEls = headerSelectors.flatMap(s => Array.from(document.querySelectorAll(s)));

            const isInHeader = (el) => headerEls.some(h => h.contains(el));

            const imgs = Array.from(document.querySelectorAll('img[src*="fbcdn"]'));

            const postImg = imgs.find(img => {
                if (isInHeader(img)) return false;

                const w = img.naturalWidth || parseInt(img.getAttribute('width') || '0');
                const h = img.naturalHeight || parseInt(img.getAttribute('height') || '0');

                // Must be a reasonably sized image and not banner-shaped (very wide, short)
                if (w < 200 || h < 200) return false;
                const aspectRatio = w / h;
                if (aspectRatio > 3.5) return false; // Skip panoramic/banner images

                return true;
            });

            if (!postImg) return false;

            // Walk up to find a clickable element wrapping the image
            let el = postImg;
            for (let i = 0; i < 8; i++) {
                if (!el) break;
                if (el.tagName === 'A' || el.getAttribute('role') === 'link' || el.getAttribute('role') === 'button') {
                    el.click();
                    return true;
                }
                el = el.parentElement;
            }
            // Fallback: click the image itself
            postImg.click();
            return true;
        });

        if (!imageClicked) {
            process.stderr.write('Could not find a post image to click.\n');
            console.log(JSON.stringify({ error: 'no_image_found' }));
            return;
        }

        process.stderr.write('Clicked post image, waiting for high-res load...\n');

        // Wait for the photo viewer to open and the high-res image to be fetched
        try {
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
        } catch (_) {
            // Modal viewer — no navigation
        }

        // Give it extra time to load the full-res image
        await new Promise(r => setTimeout(r, 3000));

        // --- Use the intercepted URL if we got one ---
        let highResUrl = capturedImageUrl;

        // Fallback: if interception didn't catch it, find the photo viewer image in the DOM
        // but this time exclude anything that looks like a profile/banner image
        if (!highResUrl) {
            process.stderr.write('Network interception missed — falling back to DOM search in viewer.\n');
            highResUrl = await page.evaluate(() => {
                // The photo viewer in Facebook opens as a dialog/layer
                const viewerSelectors = [
                    '[data-pagelet="MediaViewerPhoto"] img',
                    '[role="dialog"] img[src*="fbcdn"]',
                    '[aria-label="Photo"] img[src*="fbcdn"]',
                ];
                for (const sel of viewerSelectors) {
                    const img = document.querySelector(sel);
                    if (img && img.src) return img.src;
                }
                return null;
            });
        }

        if (!highResUrl) {
            process.stderr.write('Could not find high-res image.\n');
            console.log(JSON.stringify({ error: 'no_highres_image' }));
            return;
        }

        process.stderr.write(`Downloading high-res image: ${highResUrl}\n`);

        // Download the image
        const response = await page.goto(highResUrl, {
            waitUntil: 'networkidle0',
            timeout: 15000
        });

        if (response && response.ok()) {
            const buffer = await response.buffer();
            fs.writeFileSync(OUTPUT_FILE, buffer);
            process.stderr.write(`Saved to ${OUTPUT_FILE}\n`);
            console.log(JSON.stringify({ imagePath: OUTPUT_FILE }));
        } else {
            process.stderr.write(`Failed to download (status: ${response?.status()})\n`);
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
