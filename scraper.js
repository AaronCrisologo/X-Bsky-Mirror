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
function downloadImage(url, filepath, timeout = 10000) {
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
    const HARD_TIMEOUT = 70000; // 70 seconds - must finish before Python kills us at 90s
    
    process.stderr.write(`\n${'='.repeat(60)}\n`);
    process.stderr.write(`🚀 SCRAPER START: ${new Date().toISOString()}\n`);
    process.stderr.write(`⏱️  Hard timeout: ${HARD_TIMEOUT}ms\n`);
    process.stderr.write(`${'='.repeat(60)}\n\n`);
    
    let browser;
    let globalTimeout;

    // Set a hard timeout that will kill everything
    const hardTimeoutPromise = new Promise((_, reject) => {
        globalTimeout = setTimeout(() => {
            reject(new Error('HARD_TIMEOUT_REACHED'));
        }, HARD_TIMEOUT);
    });

    try {
        const result = await Promise.race([
            scrapeWithRetries(username),
            hardTimeoutPromise
        ]);
        
        clearTimeout(globalTimeout);
        return result;
        
    } catch (error) {
        clearTimeout(globalTimeout);
        
        if (error.message === 'HARD_TIMEOUT_REACHED') {
            process.stderr.write(`\n💀 HARD TIMEOUT REACHED (${HARD_TIMEOUT}ms)\n`);
            process.stderr.write(`⚠️  Scraper took too long - exiting\n`);
        }
        
        throw error;
    }
}

async function scrapeWithRetries(username) {
    let browser;
    let attempt = 0;
    const maxAttempts = 2;

    while (attempt < maxAttempts) {
        attempt++;
        const attemptStart = Date.now();
        
        process.stderr.write(`\n${'─'.repeat(60)}\n`);
        process.stderr.write(`📍 ATTEMPT ${attempt}/${maxAttempts}\n`);
        process.stderr.write(`${'─'.repeat(60)}\n`);
        
        try {
            process.stderr.write('🌐 Launching browser...\n');
            
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
                    '--disable-blink-features=AutomationControlled',
                    '--disable-features=IsolateOrigins,site-per-process',
                    '--single-process' // Can help in resource-constrained environments
                ],
                timeout: 30000 // Browser launch timeout
            });
            
            const launchTime = Date.now() - attemptStart;
            process.stderr.write(`✅ Browser launched in ${launchTime}ms\n`);

            const page = await browser.newPage();
            
            // Aggressive timeouts for GitHub Actions
            page.setDefaultTimeout(25000);
            page.setDefaultNavigationTimeout(25000);
            
            // Prevent detection
            await page.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, 'webdriver', {
                    get: () => false,
                });
            });
            
            process.stderr.write('🍪 Setting cookies...\n');
            await page.setCookie(...rawCookies);
            await page.setViewport({ width: 1280, height: 800 }); // Smaller viewport

            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
            });

            // Block unnecessary resources to speed up loading
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                const resourceType = req.resourceType();
                // Only block heavy resources, not images since we need those
                if (['font', 'stylesheet', 'media'].includes(resourceType)) {
                    req.abort();
                } else {
                    req.continue();
                }
            });

            process.stderr.write(`🔗 Navigating to https://x.com/${username}...\n`);
            const navStart = Date.now();
            
            try {
                await page.goto(`https://x.com/${username}`, { 
                    waitUntil: 'domcontentloaded', // Faster than 'networkidle'
                    timeout: 25000 
                });
                const navTime = Date.now() - navStart;
                process.stderr.write(`✅ Navigation successful (${navTime}ms)\n`);
            } catch (navError) {
                process.stderr.write(`❌ Navigation error: ${navError.message}\n`);
                if (attempt < maxAttempts) {
                    await browser.close();
                    process.stderr.write('🔄 Retrying in 1 second...\n');
                    await new Promise(r => setTimeout(r, 1000));
                    continue;
                }
                throw navError;
            }

            process.stderr.write('⏳ Waiting for articles...\n');
            const waitStart = Date.now();
            
            try {
                await page.waitForSelector('article', { timeout: 25000 });
                const waitTime = Date.now() - waitStart;
                process.stderr.write(`✅ Articles found! (${waitTime}ms)\n`);
            } catch (waitError) {
                process.stderr.write(`❌ Timeout waiting for articles\n`);
                if (attempt < maxAttempts) {
                    await browser.close();
                    process.stderr.write('🔄 Retrying...\n');
                    await new Promise(r => setTimeout(r, 1000));
                    continue;
                }
                throw waitError;
            }

            // Quick wait for rendering
            await new Promise(r => setTimeout(r, 1500));

            process.stderr.write('🔍 Extracting tweet data...\n');
            const extractStart = Date.now();
            
            const tweetData = await page.evaluate(async () => {
                const results = [];
                
                // Only do 1 scroll iteration to save time
                for (let i = 0; i < 1; i++) {
                    const articles = Array.from(document.querySelectorAll('article'));
                    articles.forEach(article => {
                        const timeEl = article.querySelector('time');
                        const textEl = article.querySelector('[data-testid="tweetText"]');
                        const pinCheck = article.innerText.includes('Pinned');
                        const hasVideo = !!article.querySelector('[data-testid="videoPlayer"], video');

                        const imageElements = article.querySelectorAll('[data-testid="tweetPhoto"] img');
                        const images = Array.from(imageElements).map(img => img.src);

                        if (timeEl) {
                            results.push({
                                text: textEl ? textEl.innerText : "",
                                time: timeEl.getAttribute('datetime'),
                                isPinned: pinCheck,
                                hasVideo: hasVideo,
                                images: images,
                                imageCount: images.length
                            });
                        }
                    });
                    
                    if (i < 0) { // Skip scrolling to save time
                        window.scrollBy(0, 800);
                        await new Promise(r => setTimeout(r, 500));
                    }
                }
                
                const cleanList = results.filter((v, i, a) =>
                    a.findIndex(t => t.time === v.time) === i && !v.isPinned
                );
                cleanList.sort((a, b) => new Date(b.time) - new Date(a.time));
                return cleanList[0];
            });

            const extractTime = Date.now() - extractStart;
            process.stderr.write(`✅ Extraction complete (${extractTime}ms)\n`);

            process.stderr.write(`\n${'─'.repeat(60)}\n`);
            process.stderr.write(`📊 TWEET DATA EXTRACTION RESULTS\n`);
            process.stderr.write(`${'─'.repeat(60)}\n`);
            
            if (tweetData) {
                process.stderr.write(`✅ Status: SUCCESS\n`);
                process.stderr.write(`📅 Time: ${tweetData.time}\n`);
                process.stderr.write(`📹 Has Video: ${tweetData.hasVideo ? 'YES' : 'NO'}\n`);
                process.stderr.write(`🖼️  Image Count: ${tweetData.imageCount || 0}\n`);
                
                if (tweetData.images && tweetData.images.length > 0) {
                    process.stderr.write(`\n📸 IMAGE URLs FOUND:\n`);
                    tweetData.images.forEach((url, idx) => {
                        process.stderr.write(`  [${idx}] ${url.substring(0, 80)}...\n`);
                    });
                }
                
                // EMOJI LOGGING
                if (tweetData.text) {
                    const emojiCount = countEmojis(tweetData.text);
                    const hasEmojiFlag = hasEmojis(tweetData.text);
                    
                    process.stderr.write(`\n${'─'.repeat(60)}\n`);
                    process.stderr.write(`😀 EMOJI ANALYSIS\n`);
                    process.stderr.write(`${'─'.repeat(60)}\n`);
                    process.stderr.write(`📏 Text length: ${tweetData.text.length} characters\n`);
                    process.stderr.write(`😊 Contains emojis: ${hasEmojiFlag ? 'YES ✓' : 'NO ✗'}\n`);
                    process.stderr.write(`🔢 Emoji count: ${emojiCount}\n`);
                    
                    const first50 = tweetData.text.substring(0, 50);
                    process.stderr.write(`\n📝 First 50 chars:\n"${first50}"\n`);
                    
                    if (hasEmojiFlag) {
                        const emojiMatches = tweetData.text.match(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1F018}-\u{1F270}\u{238C}-\u{2454}\u{20D0}-\u{20FF}]/gu);
                        if (emojiMatches) {
                            process.stderr.write(`😀 Detected emojis: ${emojiMatches.join(' ')}\n`);
                        }
                    }
                }
            } else {
                process.stderr.write(`❌ Status: FAILED (no data extracted)\n`);
            }
            process.stderr.write(`${'─'.repeat(60)}\n\n`);

            // Download images with aggressive timeout
            if (tweetData && tweetData.images && tweetData.images.length > 0 && !tweetData.hasVideo) {
                process.stderr.write(`\n${'─'.repeat(60)}\n`);
                process.stderr.write(`📥 DOWNLOADING ${tweetData.images.length} IMAGE(S)\n`);
                process.stderr.write(`${'─'.repeat(60)}\n`);
                
                const downloadPromises = tweetData.images.map(async (imgUrl, i) => {
                    const highResUrl = imgUrl.split('?')[0] + '?name=orig';
                    const filename = `tweet_img_${i}.jpg`;
                    
                    process.stderr.write(`📥 [Image ${i}] Starting download...\n`);
                    
                    try {
                        const dlStart = Date.now();
                        await downloadImage(highResUrl, filename, 10000); // 10s per image
                        const dlTime = Date.now() - dlStart;
                        const stats = fs.statSync(filename);
                        
                        process.stderr.write(`   ✅ Downloaded in ${dlTime}ms (${(stats.size / 1024).toFixed(2)} KB)\n`);
                        return { success: true, filename, size: stats.size };
                    } catch (e) {
                        process.stderr.write(`   ❌ Failed: ${e.message}\n`);
                        return { success: false, filename, error: e.message };
                    }
                });

                const downloadResults = await Promise.race([
                    Promise.all(downloadPromises),
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Image download timeout')), 20000) // 20s total
                    )
                ]).catch(err => {
                    process.stderr.write(`❌ Download error: ${err.message}\n`);
                    return [];
                });

                const successCount = downloadResults.filter(r => r && r.success).length;
                process.stderr.write(`📊 Download Summary: ${successCount}/${tweetData.images.length} successful\n`);
            }

            const totalTime = Date.now() - attemptStart;
            
            process.stderr.write(`\n${'='.repeat(60)}\n`);
            process.stderr.write(`✅ SCRAPER COMPLETE\n`);
            process.stderr.write(`${'='.repeat(60)}\n`);
            process.stderr.write(`⏱️  Attempt time: ${totalTime}ms (${(totalTime / 1000).toFixed(2)}s)\n`);
            process.stderr.write(`🕐 Completed at: ${new Date().toISOString()}\n`);
            process.stderr.write(`${'='.repeat(60)}\n\n`);

            // Output the JSON result to stdout
            console.log(JSON.stringify(tweetData));
            
            // Success! Close browser and return
            await browser.close();
            process.stderr.write('🔒 Browser closed\n');
            return;

        } catch (error) {
            process.stderr.write(`\n${'!'.repeat(60)}\n`);
            process.stderr.write(`❌ ERROR ON ATTEMPT ${attempt}\n`);
            process.stderr.write(`${'!'.repeat(60)}\n`);
            process.stderr.write(`Error: ${error.message}\n`);
            
            if (error.stack && error.stack.length < 500) {
                process.stderr.write(`Stack: ${error.stack}\n`);
            }
            process.stderr.write(`${'!'.repeat(60)}\n\n`);
            
            if (browser) {
                try {
                    await browser.close();
                    process.stderr.write('🔒 Browser closed after error\n');
                } catch (closeError) {
                    process.stderr.write('⚠️  Failed to close browser\n');
                }
            }
            
            if (attempt >= maxAttempts) {
                process.stderr.write(`\n💀 All ${maxAttempts} attempts failed.\n`);
                console.log(JSON.stringify({ error: error.message }));
                throw error;
            } else {
                process.stderr.write('🔄 Will retry in 2 seconds...\n\n');
                await new Promise(r => setTimeout(r, 2000));
            }
        }
    }
}

getLatestTweet('Atlus_West').catch(error => {
    process.stderr.write(`\n💀 FATAL ERROR: ${error.message}\n`);
    console.log(JSON.stringify({ error: error.message }));
    process.exit(1);
});
