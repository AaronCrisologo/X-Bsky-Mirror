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

        // Find the first post image — original working logic
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

        process.stderr.write(`Found image URL: ${imageUrl}\n`);

        // --- Enable request interception on a fresh page ---
        // We open a new page just for downloading so the FB session page stays intact.
        // The interceptor strips 'stp' from the URL before it leaves the browser,
        // so the CDN returns full-res. No CORS, no 403 — it's a native browser request.
        const downloadPage = await browser.newPage();
        await downloadPage.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        // Copy cookies from the main page session to the download page
        const cookies = await page.cookies();
        if (cookies.length > 0) {
            await downloadPage.setCookie(...cookies);
        }

        await downloadPage.setRequestInterception(true);
        downloadPage.on('request', (req) => {
            const url = req.url();
            if (url.includes('fbcdn.net') && url.includes('stp=')) {
                try {
                    const parsed = new URL(url);
                    parsed.searchParams.delete('stp');
                    const newUrl = parsed.toString();
                    process.stderr.write(`Rewrote request to: ${newUrl}\n`);
                    req.continue({ url: newUrl });
                } catch (_) {
                    req.continue();
                }
            } else {
                req.continue();
            }
        });

        // Navigate to the original URL — the interceptor will strip stp before it's sent
        const response = await downloadPage.goto(imageUrl, {
            waitUntil: 'networkidle0',
            timeout: 15000
        });

        if (response && response.ok()) {
            const buffer = await response.buffer();
            fs.writeFileSync(OUTPUT_FILE, buffer);
            process.stderr.write(`Saved high-res image to ${OUTPUT_FILE}\n`);
            console.log(JSON.stringify({ imagePath: OUTPUT_FILE }));
        } else {
            process.stderr.write(`Download failed with status: ${response?.status()}\n`);
            console.log(JSON.stringify({ error: 'download_failed' }));
        }

        await downloadPage.close();

    } catch (error) {
        process.stderr.write(`Facebook scraper error: ${error.message}\n`);
        console.log(JSON.stringify({ error: error.message }));
    } finally {
        await browser.close();
    }
}

getLatestFacebookImage();
