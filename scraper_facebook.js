process.stdout.setEncoding('utf8');
process.stderr.setEncoding('utf8');

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());

const FB_PAGE_URL = 'https://www.facebook.com/FateGO.USA';
const OUTPUT_FILE = 'facebook_img.jpg';

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
    if (!process.env.FB_C_USER || !process.env.FB_XS) {
        process.stderr.write('⚠️  FB_C_USER or FB_XS not set — running without session cookies (low-res fallback).\n');
    }

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

        await page.setCookie(...rawCookies);

        // Phase 1: capture all feed-load images keyed by filename (for fallback)
        const capturedImages = {};

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

        // Phase 2: Find the topmost post on the page and check if it has a qualifying image.
        // If the latest post is a video/reel it will have no qualifying image — signal fallback.
        // We try multiple strategies to find the first post container, sorted by vertical position.
        const latestPostCheck = await page.evaluate(() => {
            // Strategy 1: FeedUnit pagelet containers (sorted by number)
            const allFeedUnits = Array.from(document.querySelectorAll('[data-pagelet^="FeedUnit"]'));
            if (allFeedUnits.length > 0) {
                allFeedUnits.sort((a, b) => {
                    const aNum = parseInt((a.getAttribute('data-pagelet') || '').replace('FeedUnit_', '') || '999');
                    const bNum = parseInt((b.getAttribute('data-pagelet') || '').replace('FeedUnit_', '') || '999');
                    return aNum - bNum;
                });
                const firstPost = allFeedUnits[0];
                const pagelet = firstPost.getAttribute('data-pagelet');
                const imgs = Array.from(firstPost.querySelectorAll('img[src*="fbcdn"]'));
                const postImg = imgs.find(img => {
                    const w = img.naturalWidth || parseInt(img.getAttribute('width') || '0');
                    const h = img.naturalHeight || parseInt(img.getAttribute('height') || '0');
                    return w > 200 && h > 200;
                });
                return { postFound: true, hasImage: !!postImg, pagelet };
            }

            // Strategy 2: role="article" elements — pick the topmost by vertical position
            const articles = Array.from(document.querySelectorAll('[role="article"]'));
            if (articles.length > 0) {
                // Filter out nested articles (e.g. shared post previews inside a post)
                const topLevel = articles.filter(a => !articles.some(b => b !== a && b.contains(a)));
                topLevel.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
                const firstPost = topLevel[0];
                const imgs = Array.from(firstPost.querySelectorAll('img[src*="fbcdn"]'));
                const postImg = imgs.find(img => {
                    const w = img.naturalWidth || parseInt(img.getAttribute('width') || '0');
                    const h = img.naturalHeight || parseInt(img.getAttribute('height') || '0');
                    return w > 200 && h > 200;
                });
                return { postFound: true, hasImage: !!postImg, pagelet: 'role=article' };
            }

            return { postFound: false, hasImage: false, pagelet: 'none' };
        });

        process.stderr.write(`First post container: "${latestPostCheck.pagelet}", has image: ${latestPostCheck.hasImage}\n`);

        // Trigger fallback if:
        //  - we found a post container but it has no image (video/reel), OR
        //  - we found no container at all (can't determine post type — safe to fallback)
        if (!latestPostCheck.hasImage) {
            process.stderr.write('Latest Facebook post has no image (likely a video/reel) — using local fallback.\n');
            console.log(JSON.stringify({ error: 'latest_post_is_video' }));
            return;
        }

        // Phase 2b: DOM identifies the correct post image element
        const postImageInfo = await page.evaluate(() => {
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
                if (postImg) {
                    let clickTarget = postImg;
                    let el = postImg;
                    for (let i = 0; i < 8; i++) {
                        if (!el) break;
                        if (el.tagName === 'A' && el.href && el.href.includes('/photo')) {
                            clickTarget = el;
                            break;
                        }
                        el = el.parentElement;
                    }
                    return {
                        src: postImg.src,
                        isLink: clickTarget !== postImg,
                        photoHref: clickTarget !== postImg ? clickTarget.href : null
                    };
                }
            }
            return null;
        });

        if (!postImageInfo) {
            process.stderr.write('No suitable post image found on Facebook page.\n');
            console.log(JSON.stringify({ error: 'no_image_found' }));
            return;
        }

        const targetFilename = getFilename(postImageInfo.src);
        process.stderr.write(`DOM identified post image: ${targetFilename}\n`);

        // Phase 3: click through to the photo viewer to get the full-res image
        let fullResBuffer = null;
        let fullResBytes = 0;

        const fullResListener = async (response) => {
            try {
                if (response.status() !== 200) return;
                const url = response.url();
                if (!url.includes('fbcdn.net')) return;
                if (url.includes('rsrc.php')) return;
                const ct = response.headers()['content-type'] || '';
                if (!ct.startsWith('image/')) return;
                const filename = getFilename(url);
                if (filename !== targetFilename) return;
                const buffer = await response.buffer();
                if (buffer.length > fullResBytes) {
                    fullResBuffer = buffer;
                    fullResBytes = buffer.length;
                    process.stderr.write(`Viewer loaded ${filename} at ${buffer.length} bytes\n`);
                }
            } catch (_) {}
        };

        page.on('response', fullResListener);

        if (postImageInfo.photoHref) {
            process.stderr.write(`Navigating to photo viewer: ${postImageInfo.photoHref}\n`);
            await page.goto(postImageInfo.photoHref, { waitUntil: 'networkidle2', timeout: 30000 });
        } else {
            process.stderr.write('Clicking post image to open viewer...\n');
            await page.evaluate((targetSrc) => {
                const imgs = Array.from(document.querySelectorAll('img[src*="fbcdn"]'));
                const img = imgs.find(i => i.src === targetSrc);
                if (img) {
                    let el = img;
                    for (let i = 0; i < 8; i++) {
                        if (!el) break;
                        if (el.tagName === 'A' || el.getAttribute('role') === 'link') {
                            el.click();
                            return;
                        }
                        el = el.parentElement;
                    }
                    img.click();
                }
            }, postImageInfo.src);

            try {
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
            } catch (_) {
                // Modal viewer — no navigation event
            }
        }

        await new Promise(r => setTimeout(r, 4000));

        const feedBuffer = capturedImages[targetFilename];

        const bestBuffer = (fullResBuffer && fullResBuffer.length >= (feedBuffer ? feedBuffer.length : 0)) ? fullResBuffer : feedBuffer;
        const bestBytes = bestBuffer ? bestBuffer.length : 0;
        const source = (fullResBuffer && fullResBuffer.length >= (feedBuffer ? feedBuffer.length : 0)) ? 'viewer' : 'feed capture';

        if (bestBuffer) {
            process.stderr.write(`Saving image (, ${bestBytes} bytes)\n`);
            fs.writeFileSync(OUTPUT_FILE, bestBuffer);
        } else {
            process.stderr.write('No image buffer available.\n');
            console.log(JSON.stringify({ error: 'download_failed' }));
            return;
        }

        console.log(JSON.stringify({ imagePath: OUTPUT_FILE }));

    } catch (error) {
        process.stderr.write(`Facebook scraper error: ${error.message}\n`);
        console.log(JSON.stringify({ error: error.message }));
    } finally {
        await browser.close();
    }
}

getLatestFacebookImage();
