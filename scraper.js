process.stdout.setEncoding('utf8');
process.stderr.setEncoding('utf8');

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const https = require('https');

puppeteer.use(StealthPlugin());

const rawCookies = [
    { "domain": ".x.com", "name": "auth_token", "value": process.env.X_AUTH_TOKEN, "path": "/", "secure": true, "sameSite": "Lax" },
    { "domain": ".x.com", "name": "ct0", "value": process.env.X_CT0, "path": "/", "secure": true, "sameSite": "Lax" }
];

// Helper to check for emojis
function hasEmojis(text) {
    const emojiRegex = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1F018}-\u{1F270}\u{238C}-\u{2454}\u{20D0}-\u{20FF}]/u;
    return emojiRegex.test(text);
}

function countEmojis(text) {
    const emojiRegex = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1F018}-\u{1F270}\u{238C}-\u{2454}\u{20D0}-\u{20FF}]/gu;
    const matches = text.match(emojiRegex);
    return matches ? matches.length : 0;
}

// Helper function to download images with timeout
function downloadImage(url, filepath, timeout = 15000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error('Download timeout'));
        }, timeout);

        https.get(url, (response) => {
            clearTimeout(timer);
            if (response.statusCode !== 200) {
                reject(new Error(`Failed to download: ${response.statusCode}`));
                return;
            }
            const fileStream = fs.createWriteStream(filepath);
            response.pipe(fileStream);
            fileStream.on('finish', () => {
                fileStream.close();
                resolve();
            });
            fileStream.on('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });
        }).on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

async function getLatestTweet(username) {
    const startTime = Date.now();
    process.stderr.write(`Starting scraper at ${new Date().toISOString()}\n`);
    
    let browser;
    let attempt = 0;
    const maxAttempts = 2;

    while (attempt < maxAttempts) {
        attempt++;
        process.stderr.write(`\n=== Attempt ${attempt}/${maxAttempts} ===\n`);
        
        try {
            process.stderr.write('Launching browser...\n');
            browser = await puppeteer.launch({
                headless: "new",
                args: [
                    '--no-sandbox', 
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--disable-software-rasterizer',
                    '--disable-extensions',
                    '--disable-background-networking',
                    '--disable-default-apps',
                    '--disable-sync',
                    '--metrics-recording-only',
                    '--mute-audio',
                    '--no-first-run',
                    '--safebrowsing-disable-auto-update',
                    '--disable-blink-features=AutomationControlled'
                ]
            });
            process.stderr.write(`Browser launched in ${Date.now() - startTime}ms\n`);

            const page = await browser.newPage();
            
            // Prevent detection
            await page.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, 'webdriver', {
                    get: () => false,
                });
            });
            
            // Set a reasonable timeout for page operations
            page.setDefaultTimeout(60000);
            page.setDefaultNavigationTimeout(60000);
            
            process.stderr.write('Setting cookies...\n');
            await page.setCookie(...rawCookies);
            await page.setViewport({ width: 1280, height: 1000 });

            // Add extra headers to look more like a real browser
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
            });

            process.stderr.write(`Navigating to https://x.com/${username}...\n`);
            
            // Try to navigate with retries
            try {
                await page.goto(`https://x.com/${username}`, { 
                    waitUntil: 'domcontentloaded',
                    timeout: 45000 
                });
            } catch (navError) {
                process.stderr.write(`Navigation error: ${navError.message}\n`);
                if (attempt < maxAttempts) {
                    await browser.close();
                    process.stderr.write('Retrying...\n');
                    await new Promise(r => setTimeout(r, 2000)); // Wait before retry
                    continue;
                }
                throw navError;
            }

            process.stderr.write('Waiting for articles...\n');
            await page.waitForSelector('article', { timeout: 45000 });
            process.stderr.write('Articles found!\n');

            // Give the page a moment to fully render
            await new Promise(r => setTimeout(r, 2000));

            const tweetData = await page.evaluate(async () => {
                const results = [];
                
                for (let i = 0; i < 2; i++) {
                    const articles = Array.from(document.querySelectorAll('article'));
                    articles.forEach(article => {
                        const timeEl = article.querySelector('time');
                        const textEl = article.querySelector('[data-testid="tweetText"]');
                        const pinCheck = article.innerText.includes('Pinned');
                        const hasVideo = !!article.querySelector('[data-testid="videoPlayer"], video');

                        if (timeEl) {
                            results.push({
                                text: textEl ? textEl.innerText : "",
                                time: timeEl.getAttribute('datetime'),
                                isPinned: pinCheck,
                                hasVideo: hasVideo,
                                images: Array.from(article.querySelectorAll('[data-testid="tweetPhoto"] img')).map(img => img.src)
                            });
                        }
                    });
                    window.scrollBy(0, 800);
                    await new Promise(r => setTimeout(r, 1000));
                }
                
                const cleanList = results.filter((v, i, a) =>
                    a.findIndex(t => t.time === v.time) === i && !v.isPinned
                );
                cleanList.sort((a, b) => new Date(b.time) - new Date(a.time));
                return cleanList[0];
            });

            process.stderr.write(`Tweet data extracted: ${tweetData ? 'SUCCESS' : 'FAILED'}\n`);

            if (tweetData && tweetData.text) {
                // EMOJI LOGGING
                const emojiCount = countEmojis(tweetData.text);
                const hasEmojiFlag = hasEmojis(tweetData.text);
                process.stderr.write(`\n📊 EMOJI ANALYSIS:\n`);
                process.stderr.write(`  - Text length: ${tweetData.text.length} chars\n`);
                process.stderr.write(`  - Contains emojis: ${hasEmojiFlag ? 'YES ✓' : 'NO ✗'}\n`);
                process.stderr.write(`  - Emoji count: ${emojiCount}\n`);
                process.stderr.write(`  - First 100 chars: ${tweetData.text.substring(0, 100)}\n`);
                
                // Show byte representation of first few chars to debug encoding
                const bytes = Buffer.from(tweetData.text.substring(0, 20), 'utf8');
                process.stderr.write(`  - First bytes (hex): ${bytes.toString('hex').substring(0, 60)}\n\n`);
            }

            // Download images with timeout protection
            if (tweetData && tweetData.images && tweetData.images.length > 0 && !tweetData.hasVideo) {
                process.stderr.write(`Downloading ${tweetData.images.length} images...\n`);
                
                const downloadPromises = tweetData.images.map(async (imgUrl, i) => {
                    const highResUrl = imgUrl.split('?')[0] + '?name=orig';
                    const filename = `tweet_img_${i}.jpg`;
                    
                    try {
                        await downloadImage(highResUrl, filename, 15000);
                        const stats = fs.statSync(filename);
                        process.stderr.write(`✓ Downloaded ${filename} (${stats.size} bytes)\n`);
                        return true;
                    } catch (e) {
                        process.stderr.write(`✗ Failed ${filename}: ${e.message}\n`);
                        return false;
                    }
                });

                await Promise.race([
                    Promise.all(downloadPromises),
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Image download timeout')), 30000)
                    )
                ]).catch(err => {
                    process.stderr.write(`Image download error: ${err.message}\n`);
                });
            }

            const totalTime = Date.now() - startTime;
            process.stderr.write(`Total execution time: ${totalTime}ms\n`);

            // Output the JSON result
            console.log(JSON.stringify(tweetData));
            
            // Success! Break the retry loop
            await browser.close();
            return;

        } catch (error) {
            process.stderr.write(`\n❌ ERROR on attempt ${attempt}: ${error.message}\n`);
            process.stderr.write(`Stack: ${error.stack}\n`);
            
            if (browser) {
                await browser.close();
                process.stderr.write('Browser closed\n');
            }
            
            if (attempt >= maxAttempts) {
                console.log(JSON.stringify({ error: error.message }));
            } else {
                process.stderr.write('Will retry...\n');
                await new Promise(r => setTimeout(r, 3000)); // Wait before retry
            }
        }
    }
}

getLatestTweet('FateGO_USA');
