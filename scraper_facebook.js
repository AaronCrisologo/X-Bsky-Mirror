process.stdout.setEncoding('utf8');
process.stderr.setEncoding('utf8');

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());

const FB_PAGE_URL = 'https://www.facebook.com/FateGO.USA';
const OUTPUT_FILE = 'facebook_img.jpg';

/**
 * Takes a Facebook CDN thumbnail URL and attempts to upgrade it to full resolution.
 * Facebook CDN URLs often contain size hints like p526x395, s480x480, p320x320 etc.
 * Replacing these with a very large value (or removing them) fetches the original.
 */
function upgradeToHighRes(url) {
    try {
        const parsed = new URL(url);
        // The stp param is what forces Facebook to serve a resized/compressed version.
        // Removing it causes Facebook to serve the original full-resolution image.
        parsed.searchParams.delete('stp');
        return parsed.toString();
    } catch (_) {
        return url;
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

        await page.goto(FB_PAGE_URL, { waitUntil: 'networkidle2', timeout: 30000 });

        // Dismiss cookie/login popups if they appear
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

        // Find the first post image — same logic as the original working version
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

        // Upgrade the URL to request the highest resolution version
        const highResUrl = upgradeToHighRes(imageUrl);
        process.stderr.write(`Original URL: ${imageUrl}\n`);
        process.stderr.write(`High-res URL: ${highResUrl}\n`);

        // Try high-res first, fall back to original if it fails
        let downloaded = false;
        for (const url of [highResUrl, imageUrl]) {
            try {
                const response = await page.goto(url, {
                    waitUntil: 'networkidle0',
                    timeout: 15000
                });

                if (response && response.ok()) {
                    const buffer = await response.buffer();
                    fs.writeFileSync(OUTPUT_FILE, buffer);
                    process.stderr.write(`Saved image from: ${url}\n`);
                    console.log(JSON.stringify({ imagePath: OUTPUT_FILE }));
                    downloaded = true;
                    break;
                } else {
                    process.stderr.write(`Failed (status ${response?.status()}) for: ${url}\n`);
                }
            } catch (e) {
                process.stderr.write(`Error fetching ${url}: ${e.message}\n`);
            }
        }

        if (!downloaded) {
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
