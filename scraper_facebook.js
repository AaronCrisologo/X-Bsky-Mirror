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

        // Intercept all t39.30808 images, store keyed by filename, track capture order
        const capturedImages = {};
        const captureOrder = [];

        page.on('response', async (response) => {
            try {
                if (response.status() !== 200) return;
                const url = response.url();
                if (!url.includes('fbcdn.net')) return;
                if (url.includes('rsrc.php')) return;
                if (!url.includes('t39.30808')) return;
                const ct = response.headers()['content-type'] || '';
                if (!ct.startsWith('image/')) return;

                const filename = getFilename(url);
                if (!filename) return;

                const buffer = await response.buffer();
                if (buffer.length < 1000) return;

                if (!capturedImages[filename]) {
                    captureOrder.push(filename);
                    capturedImages[filename] = { buffer, url };
                } else if (buffer.length > capturedImages[filename].buffer.length) {
                    capturedImages[filename] = { buffer, url };
                }

                process.stderr.write(`Stored ${filename} (${buffer.length} bytes)\n`);
            } catch (_) {}
        });

        await page.goto(FB_PAGE_URL, { waitUntil: 'networkidle2', timeout: 30000 });

        // Dismiss popups
        try {
            const declineBtn = await page.$('[data-cookiebanner="accept_only_essential_button"]');
            if (declineBtn) await declineBtn.click();
        } catch (_) {}
        try {
            const closeBtn = await page.$('[aria-label="Close"]');
            if (closeBtn) await closeBtn.click();
        } catch (_) {}

        await new Promise(r => setTimeout(r, 2000));
        await page.evaluate(() => window.scrollBy(0, 500));
        await new Promise(r => setTimeout(r, 3000));

        // Step 1: Find the cover photo filename so we can exclude it.
        // The cover/banner image sits in the page header, above the feed.
        // We grab it first so we know what to skip.
        const coverPhotoFilename = await page.evaluate(() => {
            const coverSelectors = [
                '[data-pagelet="ProfileCoverPhoto"] img',
                '[data-pagelet="ProfileTilesFeed_0"] img',
                // Cover photo is always the first very-wide image near the top of the page
                // Walk all imgs sorted by vertical position, find the topmost large one
            ];

            for (const sel of coverSelectors) {
                const img = document.querySelector(sel);
                if (img && img.src) return img.src;
            }

            // Fallback: topmost large fbcdn image on the page is the cover photo
            const allImgs = Array.from(document.querySelectorAll('img[src*="fbcdn"]'));
            allImgs.sort((a, b) => {
                const aTop = a.getBoundingClientRect().top + window.scrollY;
                const bTop = b.getBoundingClientRect().top + window.scrollY;
                return aTop - bTop;
            });
            const topImg = allImgs.find(img => {
                const w = img.naturalWidth || 0;
                const h = img.naturalHeight || 0;
                return w > 300;
            });
            return topImg ? topImg.src : null;
        });

        const coverFilename = coverPhotoFilename ? getFilename(coverPhotoFilename) : null;
        process.stderr.write(`Cover photo filename to exclude: ${coverFilename}\n`);

        // Step 2: Also find profile picture filename to exclude
        const profilePicFilename = await page.evaluate(() => {
            // Profile pictures use _nc_sid=2d3e12 or are in specific containers
            const profileSelectors = [
                '[data-pagelet="ProfileActions"] img',
                'image[data-testid="profilePic"]',
            ];
            for (const sel of profileSelectors) {
                const img = document.querySelector(sel);
                if (img && img.src) return img.src;
            }
            return null;
        });
        const profileFilename = profilePicFilename ? getFilename(profilePicFilename) : null;
        process.stderr.write(`Profile pic filename to exclude: ${profileFilename}\n`);

        // Step 3: From captureOrder, pick the first image that is NOT the cover or profile pic
        // and is a reasonable size (>5KB = not a tiny icon)
        const excludeSet = new Set([coverFilename, profileFilename].filter(Boolean));

        let targetFilename = null;
        for (const filename of captureOrder) {
            if (excludeSet.has(filename)) {
                process.stderr.write(`Skipping excluded image: ${filename}\n`);
                continue;
            }
            const entry = capturedImages[filename];
            if (entry && entry.buffer.length > 5000) {
                targetFilename = filename;
                process.stderr.write(`Selected post image: ${targetFilename}\n`);
                break;
            }
        }

        if (!targetFilename) {
            process.stderr.write('No post image found after exclusions.\n');
            console.log(JSON.stringify({ error: 'no_image_found' }));
            return;
        }

        const captured = capturedImages[targetFilename];
        process.stderr.write(`Saving ${targetFilename} (${captured.buffer.length} bytes)\n`);
        fs.writeFileSync(OUTPUT_FILE, captured.buffer);
        console.log(JSON.stringify({ imagePath: OUTPUT_FILE }));

    } catch (error) {
        process.stderr.write(`Facebook scraper error: ${error.message}\n`);
        console.log(JSON.stringify({ error: error.message }));
    } finally {
        await browser.close();
    }
}

getLatestFacebookImage();
