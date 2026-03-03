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

        // Use the original DOM selector approach that correctly finds the post image.
        // FeedUnit_0 / FeedUnit_N selectors target the actual feed posts, not the banner.
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

        // Strip the 'stp' param — this is the only thing causing the low resolution.
        // e.g. stp=dst-jpg_s565x565_tt6 forces Facebook CDN to resize down.
        // Removing it serves the original full-resolution image.
        let highResUrl;
        try {
            const parsed = new URL(imageUrl);
            parsed.searchParams.delete('stp');
            highResUrl = parsed.toString();
        } catch (_) {
            highResUrl = imageUrl;
        }

        process.stderr.write(`Original URL: ${imageUrl}\n`);
        process.stderr.write(`High-res URL: ${highResUrl}\n`);

        // Download using fetch() from inside the page so session cookies are preserved.
        // page.goto() loses the auth context and gets a 403 on high-res CDN URLs.
        const base64Data = await page.evaluate(async (url) => {
            try {
                const res = await fetch(url, { credentials: 'include' });
                if (!res.ok) return null;
                const arrayBuffer = await res.arrayBuffer();
                const bytes = new Uint8Array(arrayBuffer);
                let binary = '';
                for (let i = 0; i < bytes.byteLength; i++) {
                    binary += String.fromCharCode(bytes[i]);
                }
                return btoa(binary);
            } catch (e) {
                return null;
            }
        }, highResUrl);

        if (base64Data) {
            const buffer = Buffer.from(base64Data, 'base64');
            fs.writeFileSync(OUTPUT_FILE, buffer);
            process.stderr.write(`Saved high-res image to ${OUTPUT_FILE}\n`);
            console.log(JSON.stringify({ imagePath: OUTPUT_FILE }));
        } else {
            // Fall back to the original low-res URL if high-res fetch failed
            process.stderr.write('High-res fetch failed, falling back to original URL.\n');
            const fallbackData = await page.evaluate(async (url) => {
                try {
                    const res = await fetch(url, { credentials: 'include' });
                    if (!res.ok) return null;
                    const arrayBuffer = await res.arrayBuffer();
                    const bytes = new Uint8Array(arrayBuffer);
                    let binary = '';
                    for (let i = 0; i < bytes.byteLength; i++) {
                        binary += String.fromCharCode(bytes[i]);
                    }
                    return btoa(binary);
                } catch (e) {
                    return null;
                }
            }, imageUrl);

            if (fallbackData) {
                const buffer = Buffer.from(fallbackData, 'base64');
                fs.writeFileSync(OUTPUT_FILE, buffer);
                process.stderr.write(`Saved fallback image to ${OUTPUT_FILE}\n`);
                console.log(JSON.stringify({ imagePath: OUTPUT_FILE }));
            } else {
                process.stderr.write('Both high-res and fallback fetch failed.\n');
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
