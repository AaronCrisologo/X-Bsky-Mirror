const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const https = require('https');
const path = require('path');

puppeteer.use(StealthPlugin());

// Ensure strictly UTF-8 output
if (process.stdout.isTTY) {
    process.stdout.setEncoding('utf8');
}

const rawCookies = [
    { "domain": ".x.com", "name": "auth_token", "value": process.env.X_AUTH_TOKEN, "path": "/", "secure": true, "sameSite": "Lax" },
    { "domain": ".x.com", "name": "ct0", "value": process.env.X_CT0, "path": "/", "secure": true, "sameSite": "Lax" }
];

// Better download function that mimics a browser request
function downloadImage(url, filepath, userAgent) {
    return new Promise((resolve, reject) => {
        const fileStream = fs.createWriteStream(filepath);
        
        const options = {
            headers: {
                'User-Agent': userAgent,
                'Referer': 'https://x.com/',
                'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
            }
        };

        https.get(url, options, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error(`Failed to download: ${response.statusCode}`));
                return;
            }
            response.pipe(fileStream);
            fileStream.on('finish', () => {
                fileStream.close();
                resolve();
            });
            fileStream.on('error', (err) => {
                fs.unlink(filepath, () => {}); // Delete failed file
                reject(err);
            });
        }).on('error', (err) => {
            fs.unlink(filepath, () => {});
            reject(err);
        });
    });
}

async function getLatestTweet(username) {
    const log = (msg) => process.stderr.write(`[Node Log] ${msg}\n`);
    log(`Starting scraper for ${username}...`);
    
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ]
        });

        const page = await browser.newPage();
        
        // Define UA once to use for both navigation and downloads
        const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
        await page.setUserAgent(USER_AGENT);
        await page.setViewport({ width: 1280, height: 1000 });
        await page.setCookie(...rawCookies);

        log(`Navigating to https://x.com/${username}...`);
        await page.goto(`https://x.com/${username}`, { waitUntil: 'domcontentloaded', timeout: 60000 });

        log('Waiting for articles...');
        await page.waitForSelector('article', { timeout: 45000 });

        // Wait a bit for dynamic content/emojis to render
        await new Promise(r => setTimeout(r, 3000));

        const tweetData = await page.evaluate(() => {
            const articles = Array.from(document.querySelectorAll('article'));
            // Get the first valid tweet (skipping pinned if necessary, logic simplified here)
            const article = articles[0]; 
            
            if (!article) return null;

            const timeEl = article.querySelector('time');
            const textEl = article.querySelector('[data-testid="tweetText"]');
            const hasVideo = !!article.querySelector('[data-testid="videoPlayer"], video');
            
            // Get high-res images
            const images = Array.from(article.querySelectorAll('[data-testid="tweetPhoto"] img'))
                .map(img => img.src);

            return {
                text: textEl ? textEl.innerText : "",
                time: timeEl ? timeEl.getAttribute('datetime') : "post",
                hasVideo: hasVideo,
                images: images
            };
        });

        if (!tweetData) {
            throw new Error("No tweet data found.");
        }

        log(`Found tweet from: ${tweetData.time}`);
        log(`Text length: ${tweetData.text.length}`);
        
        // --- IMAGE DOWNLOAD SECTION ---
        if (tweetData.images.length > 0 && !tweetData.hasVideo) {
            log(`Found ${tweetData.images.length} images. Downloading...`);
            
            for (let i = 0; i < tweetData.images.length; i++) {
                const imgUrl = tweetData.images[i].split('?')[0] + '?name=large'; // Use large format
                const filename = path.resolve(__dirname, `tweet_img_${i}.jpg`);
                
                try {
                    await downloadImage(imgUrl, filename, USER_AGENT);
                    const stats = fs.statSync(filename);
                    log(`✓ Saved ${filename} (${stats.size} bytes)`);
                } catch (e) {
                    log(`✗ Failed to download image ${i}: ${e.message}`);
                    // Remove from array so Python doesn't look for it
                    tweetData.images.splice(i, 1);
                    i--;
                }
            }
        }

        // --- EMOJI SAFETY & OUTPUT ---
        // 1. Write to a file as a backup (safest for emojis)
        fs.writeFileSync('latest_tweet.json', JSON.stringify(tweetData, null, 2), 'utf8');
        log('Saved data to latest_tweet.json');

        // 2. Write to stdout for pipe (using process.stdout.write to avoid extra newline issues)
        console.log(JSON.stringify(tweetData));

    } catch (error) {
        log(`❌ ERROR: ${error.message}`);
        console.log(JSON.stringify({ error: error.message }));
    } finally {
        if (browser) await browser.close();
    }
}

getLatestTweet(process.env.BSKY_USER || 'Atlus_West'); // Default for testing
