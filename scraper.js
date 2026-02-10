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

            // Scroll down 3 times to ensure the "Pinned" tweet isn't the only thing there
            for (let i = 0; i < 3; i++) {
                const articles = Array.from(document.querySelectorAll('article'));

                articles.forEach(article => {
                    const timeEl = article.querySelector('time');
                    const textEl = article.querySelector('[data-testid="tweetText"]');
                    const pinCheck = article.innerText.includes('Pinned');
                
                    // NEW: Check for video thumbnails
                    const videoThumbnails = Array.from(article.querySelectorAll('[data-testid="videoPlayer"] img, [data-testid="drive-video-player"] img'))
                        .map(img => img.src);
                
                    // Existing photo logic
                    const photoUrls = Array.from(article.querySelectorAll('[data-testid="tweetPhoto"] img'))
                        .map(img => img.src);
                
                    // Combine them (prioritize photos, then videos)
                    const allImages = [...photoUrls, ...videoThumbnails];
                
                    if (timeEl) {
                        results.push({
                            text: textEl ? textEl.innerText : "",
                            time: timeEl.getAttribute('datetime'),
                            isPinned: pinCheck,
                            images: allImages // Now includes video thumbnails!
                        });
                    }
                });

                window.scrollBy(0, 800);
                await new Promise(r => setTimeout(r, 1500));
            }

            // 1. Filter out duplicates and pinned tweets
            const cleanList = results.filter((v, i, a) =>
                a.findIndex(t => t.time === v.time) === i && !v.isPinned
            );

            // 2. Sort by absolute time (Newest first)
            cleanList.sort((a, b) => new Date(b.time) - new Date(a.time));

            return cleanList[0];
        });

        // --- HIGH-RES IMAGE DOWNLOAD ---
        if (tweetData && tweetData.images.length > 0) {
            for (let i = 0; i < tweetData.images.length; i++) {
                let imageUrl = tweetData.images[i];
                
                // If it's a standard Twitter image, force high res
                // Video thumbnails often don't need '?name=orig' but it doesn't hurt to try
                const highResUrl = imageUrl.includes('pbs.twimg.com') 
                    ? imageUrl.split('?')[0] + '?name=large' 
                    : imageUrl;
        
                try {
                    const response = await page.goto(highResUrl, { waitUntil: 'networkidle2' });
                    fs.writeFileSync(`tweet_img_${i}.jpg`, await response.buffer());
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

getLatestTweet('FateGO_USA');
