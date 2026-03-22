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
                        let tweetText = "";
                        
                        // Extract text WITH emojis properly
                        if (textEl) {
                            // Process all child nodes to capture text and emoji images
                            textEl.childNodes.forEach(node => {
                                if (node.nodeType === Node.TEXT_NODE) {
                                    tweetText += node.textContent;
                                } else if (node.nodeName === 'IMG') {
                                    // Emoji images have alt text with the actual emoji
                                    tweetText += node.alt || '';
                                } else if (node.childNodes) {
                                    // Recursively process nested nodes
                                    const processNode = (n) => {
                                        n.childNodes.forEach(child => {
                                            if (child.nodeType === Node.TEXT_NODE) {
                                                tweetText += child.textContent;
                                            } else if (child.nodeName === 'IMG') {
                                                tweetText += child.alt || '';
                                            } else if (child.childNodes) {
                                                processNode(child);
                                            }
                                        });
                                    };
                                    processNode(node);
                                }
                            });
                        }
                        
                        // Extract images (regular photos)
                        let imageUrls = Array.from(article.querySelectorAll('[data-testid="tweetPhoto"] img')).map(img => img.src);
                        
                        // Extract video URL if it's a video post
                        let videoUrl = null;
                        if (hasVideo) {
                            const videoPlayer = article.querySelector('[data-testid="videoPlayer"]');
                            if (videoPlayer) {
                                // Try to find video element with src attribute
                                const videoEl = videoPlayer.querySelector('video');
                                if (videoEl && videoEl.src) {
                                    videoUrl = videoEl.src;
                                } else {
                                    // Try to find source elements inside video
                                    const sourceEls = videoPlayer.querySelectorAll('source');
                                    for (const source of sourceEls) {
                                        if (source.src && source.src.includes('.mp4')) {
                                            videoUrl = source.src;
                                            break;
                                        }
                                    }
                                }
                                
                                // If still no video URL, try to extract from background style
                                if (!videoUrl) {
                                    const bgStyle = videoPlayer.getAttribute('style') || '';
                                    const bgMatch = bgStyle.match(/background-image:\s*url\(['"]?(.+?)['"]?\)/);
                                    if (bgMatch && bgMatch[1]) {
                                        // This is likely a thumbnail, store separately
                                        imageUrls.push(bgMatch[1]);
                                    }
                                }
                            }
                        }
                        
                        results.push({
                            text: tweetText,
                            time: timeEl.getAttribute('datetime'),
                            isPinned: pinCheck,
                            hasVideo: hasVideo,
                            videoUrl: videoUrl,
                            images: imageUrls
                        });
                    }
                });
                window.scrollBy(0, 800);
                await new Promise(r => setTimeout(r, 1500));
            }
            
            // Remove duplicates first
            const unique = results.filter((v, i, a) =>
                a.findIndex(t => t.time === v.time) === i
            );
            // Sort by time descending (newest first)
            unique.sort((a, b) => new Date(b.time) - new Date(a.time));
            // Return the newest post (pinned or not)
            return unique[0];
        });

        // --- HIGH-RES IMAGE DOWNLOAD ---
        if (tweetData && tweetData.images.length > 0) {
            for (let i = 0; i < tweetData.images.length; i++) {
                const originalUrl = tweetData.images[i];
                let highResUrl;
                
                // Twitter images usually have format=jpg&name=small/medium/large
                // We want to keep format but change name to 'orig'
                if (originalUrl.includes('?')) {
                    const [base, params] = originalUrl.split('?');
                    const urlParams = new URLSearchParams(params);
                    urlParams.set('name', 'orig');
                    highResUrl = `${base}?${urlParams.toString()}`;
                } else {
                    // Fallback if no query params (shouldn't happen, but just in case)
                    highResUrl = `${originalUrl}?format=jpg&name=orig`;
                }
                
                try {
                    const response = await page.goto(highResUrl, { 
                        waitUntil: 'networkidle0',
                        timeout: 15000 
                    });
                    
                    if (response && response.ok()) {
                        const buffer = await response.buffer();
                        fs.writeFileSync(`tweet_img_${i}.jpg`, buffer);
                    } else {
                        process.stderr.write(`Failed image ${i}: Invalid response (status: ${response?.status()})\n`);
                        process.stderr.write(`URL attempted: ${highResUrl}\n`);
                    }
                } catch (e) {
                    process.stderr.write(`Failed image ${i}: ${e.message}\n`);
                    process.stderr.write(`URL attempted: ${highResUrl}\n`);
                }
            }
        }

        // --- VIDEO DOWNLOAD ---
        if (tweetData && tweetData.videoUrl) {
            try {
                process.stderr.write(`Downloading video from: ${tweetData.videoUrl}\n`);
                const response = await page.goto(tweetData.videoUrl, { 
                    waitUntil: 'networkidle0',
                    timeout: 30000  // Videos can be large, give more time
                });
                
                if (response && response.ok()) {
                    const buffer = await response.buffer();
                    fs.writeFileSync('tweet_video.mp4', buffer);
                    process.stderr.write(`Video downloaded successfully (${buffer.length} bytes)\n`);
                } else {
                    process.stderr.write(`Failed video download: Invalid response (status: ${response?.status()})\n`);
                }
            } catch (e) {
                process.stderr.write(`Failed video download: ${e.message}\n`);
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
