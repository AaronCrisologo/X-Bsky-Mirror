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

        // Set a realistic user agent to reduce bot detection
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        await page.goto(FB_PAGE_URL, { waitUntil: 'networkidle2', timeout: 30000 });

        // Dismiss cookie/login popups if they appear
        try {
            // "Decline optional cookies" button
            const declineBtn = await page.$('[data-cookiebanner="accept_only_essential_button"]');
            if (declineBtn) await declineBtn.click();
        } catch (_) {}

        try {
            // Close login modal if present
            const closeBtn = await page.$('[aria-label="Close"]');
            if (closeBtn) await closeBtn.click();
        } catch (_) {}

        // Wait a moment for any overlays to clear
        await new Promise(r => setTimeout(r, 2000));

        // Scroll slightly to trigger lazy loading of post images
        await page.evaluate(() => window.scrollBy(0, 400));
        await new Promise(r => setTimeout(r, 2000));

        // Find the first post image on the page
        const imageUrl = await page.evaluate(() => {
            // Facebook renders post images inside these containers
            const selectors = [
                // Standard post photo
                '[data-pagelet="FeedUnit_0"] img[src*="fbcdn"]',
                '[data-pagelet^="FeedUnit"] img[src*="fbcdn"]',
                // Fallback: any large fbcdn image in the feed
                'img[src*="fbcdn"][width]'
            ];

            for (const selector of selectors) {
                const imgs = Array.from(document.querySelectorAll(selector));
                // Filter out tiny icons, avatars, and UI images
                const postImg = imgs.find(img => {
                    const w = img.naturalWidth || parseInt(img.getAttribute('width') || '0');
                    const h = img.naturalHeight || parseInt(img.getAttribute('height') || '0');
                    // Must be a reasonably sized image (not an icon/avatar)
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

        process.stderr.write(`Found Facebook image: ${imageUrl}\n`);

        // Download the image
        const response = await page.goto(imageUrl, {
            waitUntil: 'networkidle0',
            timeout: 15000
        });

        if (response && response.ok()) {
            const buffer = await response.buffer();
            fs.writeFileSync(OUTPUT_FILE, buffer);
            process.stderr.write(`Saved Facebook image to ${OUTPUT_FILE}\n`);
            console.log(JSON.stringify({ imagePath: OUTPUT_FILE }));
        } else {
            process.stderr.write(`Failed to download image (status: ${response?.status()})\n`);
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
