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

        // Find the first clickable post image in the feed (not an avatar/icon)
        const imageClicked = await page.evaluate(() => {
            const imgs = Array.from(document.querySelectorAll('img[src*="fbcdn"]'));
            const postImg = imgs.find(img => {
                const w = img.naturalWidth || parseInt(img.getAttribute('width') || '0');
                const h = img.naturalHeight || parseInt(img.getAttribute('height') || '0');
                return w > 200 && h > 200;
            });
            if (!postImg) return false;
            // Walk up to find a clickable anchor/div wrapping the image
            let el = postImg;
            for (let i = 0; i < 6; i++) {
                if (el.tagName === 'A' || el.getAttribute('role') === 'link') {
                    el.click();
                    return true;
                }
                el = el.parentElement;
                if (!el) break;
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

        process.stderr.write('Clicked post image, waiting for photo viewer...\n');

        // Wait for the photo viewer / lightbox to open
        // Facebook may navigate to a /photo/ URL, or open a modal in-place
        try {
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
        } catch (_) {
            // Modal-style viewer — no navigation, keep going
        }

        await new Promise(r => setTimeout(r, 2000));

        // Grab the largest fbcdn image now visible — this is the full-res viewer image
        const highResUrl = await page.evaluate(() => {
            const imgs = Array.from(document.querySelectorAll('img[src*="fbcdn"]'));
            // Sort by pixel area descending
            imgs.sort((a, b) => {
                const areaA = (a.naturalWidth || 0) * (a.naturalHeight || 0);
                const areaB = (b.naturalWidth || 0) * (b.naturalHeight || 0);
                return areaB - areaA;
            });
            // Pick the largest image — should be the full-res photo in the viewer
            const best = imgs.find(img => (img.naturalWidth || 0) > 400);
            return best ? best.src : null;
        });

        if (!highResUrl) {
            process.stderr.write('Could not find high-res image in photo viewer.\n');
            console.log(JSON.stringify({ error: 'no_highres_image' }));
            return;
        }

        process.stderr.write(`Found high-res Facebook image: ${highResUrl}\n`);

        // Download it
        const response = await page.goto(highResUrl, {
            waitUntil: 'networkidle0',
            timeout: 15000
        });

        if (response && response.ok()) {
            const buffer = await response.buffer();
            fs.writeFileSync(OUTPUT_FILE, buffer);
            process.stderr.write(`Saved high-res Facebook image to ${OUTPUT_FILE}\n`);
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
