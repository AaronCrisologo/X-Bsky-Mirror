process.stdout.setEncoding('utf8');
process.stderr.setEncoding('utf8');

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());

const rawCookies = [
    { "domain": ".x.com", "name": "auth_token", "value": process.env.X_AUTH_TOKEN, "path": "/", "secure": true, "sameSite": "Lax" },
    { "domain": ".x.com", "name": "ct0", "value": process.env.X_CT0, "path": "/", "secure": true, "sameSite": "Lax" }
];

async function getLatestTweet(username) {
    // Change this line in scraper.js:
    const browser = await puppeteer.launch({
        headless: "new",
        // executablePath is often unnecessary if you let npm install it normally
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--single-process' // Helps with memory management in CI
        ]
    });

    const page = await browser.newPage();
    try {
        await page.setCookie(...rawCookies);
        await page.setViewport({ width: 1280, height: 1000 });

        // Go to the "Replies" tab or just the profile.
        // Adding /with_replies often forces X to bypass some cached layout issues.
        await page.goto(`https://x.com/${username}`, { waitUntil: 'networkidle2' });

        // Wait for the feed to load
        await page.waitForSelector('article', { timeout: 30000 });

        // --- NEW SCROLL & COLLECT LOGIC ---
        const tweetData = await page.evaluate(async () => {
            const results = [];
            for (let i = 0; i < 3; i++) {
                const articles = Array.from(document.querySelectorAll('article'));
                articles.forEach(article => {
                    const timeEl = article.querySelector('time');
                    const textEl = article.querySelector('[data-testid="tweetText"]');
                    const pinCheck = article.innerText.includes('Pinned');
                    
                    // Detect if there's a video or GIF
                    const hasVideo = !!article.querySelector('[data-testid="videoPlayer"], video');

                    if (timeEl) {
                        results.push({
                            text: textEl ? textEl.textContent : "",
                            time: timeEl.getAttribute('datetime'),
                            isPinned: pinCheck,
                            hasVideo: hasVideo, // Added flag
                            images: Array.from(article.querySelectorAll('[data-testid="tweetPhoto"] img')).map(img => img.src)
                        });
                    }
                });
                window.scrollBy(0, 800);
                await new Promise(r => setTimeout(r, 1500));
            }
            
            const cleanList = results.filter((v, i, a) =>
                a.findIndex(t => t.time === v.time) === i && !v.isPinned
            );
            cleanList.sort((a, b) => new Date(b.time) - new Date(a.time));
            return cleanList[0];
        });

        // If it's a video or has no images, we won't try to download anything
        // --- HIGH-RES IMAGE DOWNLOAD ---
        if (tweetData && tweetData.images.length > 0) {
            for (let i = 0; i < tweetData.images.length; i++) {
                // Force original quality
                const highResUrl = tweetData.images[i].split('?')[0] + '?name=orig';
                try {
                    const viewSource = await page.goto(highResUrl);
                    fs.writeFileSync(`tweet_img_${i}.jpg`, await viewSource.buffer());
                } catch (e) {
                    process.stderr.write(`Failed image ${i}: ${e.message}\n`);
                }
            }
        }

        console.log(JSON.stringify(tweetData));

    } catch (error) {
        console.error(`{"error": "${error.message}"}`);
    } finally {
        await browser.close();
    }
}

getLatestTweet('Atlus_West');
