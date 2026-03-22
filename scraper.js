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
                            // Try multiple selectors for video player
                            const videoPlayer = article.querySelector('[data-testid="videoPlayer"], [data-testid="video"], .PlayableMedia-container, .tweet-video, [data-testid="tweetVideo"]');
                            
                            if (videoPlayer) {
                                // Method 1: Find video element with src
                                const videoEl = videoPlayer.querySelector('video');
                                if (videoEl) {
                                    // Check direct src
                                    if (videoEl.src && videoEl.src.includes('http')) {
                                        videoUrl = videoEl.src;
                                    }
                                    // Check source elements inside video
                                    if (!videoUrl) {
                                        const sources = videoEl.querySelectorAll('source');
                                        for (const source of sources) {
                                            let src = source.src || source.getAttribute('data-src') || source.getAttribute('data-url');
                                            if (src && src.includes('http')) {
                                                videoUrl = src;
                                                break;
                                            }
                                        }
                                    }
                                    // Check srcset
                                    if (!videoUrl && videoEl.srcset) {
                                        const srcset = videoEl.srcset;
                                        // srcset contains multiple URLs with descriptors, pick the highest quality
                                        const entries = srcset.split(',').map(s => s.trim());
                                        // Find MP4 entries, prefer highest resolution
                                        const mp4Entries = entries.filter(e => e.includes('.mp4') || e.includes('.m3u8'));
                                        if (mp4Entries.length > 0) {
                                            // Take the last one (usually highest quality) or the one with highest width
                                            const best = mp4Entries[mp4Entries.length - 1];
                                            videoUrl = best.split(' ')[0];
                                        } else if (entries.length > 0) {
                                            videoUrl = entries[0].split(' ')[0];
                                        }
                                    }
                                }
                                
                                // Method 2: Look for data attributes with video URL
                                if (!videoUrl) {
                                    const attrs = ['data-video-url', 'data-url', 'data-src', 'data-video-src', 'data-mp4-url'];
                                    for (const attr of attrs) {
                                        const val = videoPlayer.getAttribute(attr);
                                        if (val && val.includes('http')) {
                                            videoUrl = val;
                                            break;
                                        }
                                    }
                                }
                                
                                // Method 3: Look for links/buttons that might contain video URL
                                if (!videoUrl) {
                                    const links = videoPlayer.querySelectorAll('a');
                                    for (const link of links) {
                                        const href = link.href;
                                        if (href && (href.includes('.mp4') || href.includes('/video/'))) {
                                            videoUrl = href;
                                            break;
                                        }
                                    }
                                }
                                
                                // Method 4: Search for any script or JSON data in the article that might contain video URL
                                if (!videoUrl) {
                                    const scripts = article.querySelectorAll('script');
                                    for (const script of scripts) {
                                        const content = script.textContent;
                                        if (content) {
                                            // Look for common video URL patterns
                                            const mp4Match = content.match(/"(https?:\/\/[^"]+\.mp4[^"]*)"/);
                                            if (mp4Match) {
                                                videoUrl = mp4Match[1];
                                                break;
                                            }
                                            // Look for video URL in JSON-like structures
                                            const urlMatch = content.match(/"(https?:\/\/[^"]+(?:\.mp4|\.m3u8)[^"]*)"/);
                                            if (urlMatch) {
                                                videoUrl = urlMatch[1];
                                                break;
                                            }
                                        }
                                    }
                                }
                                
                                // If still no video URL, extract thumbnail from background
                                if (!videoUrl) {
                                    const bgStyle = videoPlayer.getAttribute('style') || '';
                                    const bgMatch = bgStyle.match(/background-image:\s*url\(['"]?(.+?)['"]?\)/);
                                    if (bgMatch && bgMatch[1]) {
                                        imageUrls.push(bgMatch[1]);
                                    }
                                }
                                
                                // Log for debugging
                                if (videoUrl) {
                                    console.log(`[DEBUG] Video URL found: ${videoUrl.substring(0, 80)}...`);
                                } else {
                                    console.log(`[DEBUG] Could not extract video URL, will fall back to images/thumbnail`);
                                }
                            } else {
                                console.log(`[DEBUG] No video player element found`);
                            }
                        }
                        
                        const result = {
                            text: tweetText,
                            time: timeEl.getAttribute('datetime'),
                            isPinned: pinCheck,
                            hasVideo: hasVideo,
                            videoUrl: videoUrl,
                            images: imageUrls
                        };
                        console.log(`[DEBUG] Tweet extracted: hasVideo=${hasVideo}, videoUrl=${videoUrl ? 'found' : 'null'}, images=${imageUrls.length}`);
                        results.push(result);
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
