process.stdout.setEncoding('utf8');
process.stderr.setEncoding('utf8');

const https = require('https');
const http = require('http');
const fs = require('fs');
const { execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

// ─── Constants ────────────────────────────────────────────────────────────────

const BEARER_TOKEN = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

// Query IDs — hardcoded fallback; refreshed at runtime before API calls
let QUERY_IDS = {
    UserByScreenName: process.env.X_QUERY_ID_USER_BY_SCREEN_NAME || '1VOOyvKkiI3FMmkeDNxM9A',
    UserTweets: process.env.X_QUERY_ID_USER_TWEETS || '2ItQrd86P8C0pDU6td3Z7Q',
};

// Community-maintained source (fa0311/twitter-openapi)
const TWITTER_OPENAPI_URL = 'https://raw.githubusercontent.com/fa0311/twitter-openapi/refs/heads/main/src/config/placeholder.json';

const FEATURES = {
    rweb_tipjar_consumption_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    subscriptions_verification_info_is_identity_verified_enabled: true,
    subscriptions_verification_info_verified_since_enabled: true,
    highlights_tweets_tab_ui_enabled: true,
    responsive_web_twitter_article_notes_tab_enabled: true,
    subscriptions_feature_can_gift_premium: true,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: true,
};

// ─── Logging helpers ──────────────────────────────────────────────────────────

function ts() {
    return new Date().toISOString();
}

function log(icon, tag, msg) {
    process.stderr.write(`[${ts()}] [${icon}] [${tag}] ${msg}\n`);
}

function ghaGroup(name) {
    process.stderr.write(`::group::${name}\n`);
}

function ghaEndGroup() {
    process.stderr.write(`::endgroup::\n`);
}

function ghaError(msg) {
    process.stderr.write(`::error::${msg}\n`);
}

function ghaWarning(msg) {
    process.stderr.write(`::warning::${msg}\n`);
}

function timer() {
    const start = Date.now();
    return () => `${((Date.now() - start) / 1000).toFixed(2)}s`;
}

// ─── Cookie / env validation ──────────────────────────────────────────────────

function validateEnv() {
    ghaGroup('[AUTH] Environment Validation');
    const authToken = process.env.X_AUTH_TOKEN;
    const ct0 = process.env.X_CT0;
    let valid = true;

    if (!authToken) {
        ghaError('X_AUTH_TOKEN secret is missing or empty');
        valid = false;
    } else {
        log('[OK]', 'ENV', `X_AUTH_TOKEN present (length: ${authToken.length})`);
    }

    if (!ct0) {
        ghaError('X_CT0 secret is missing or empty');
        valid = false;
    } else {
        log('[OK]', 'ENV', `X_CT0 present (length: ${ct0.length})`);
    }

    ghaEndGroup();
    return valid;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function httpsGet(url, headers) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const options = {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Accept': 'application/json',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://x.com/',
                'Origin': 'https://x.com',
                ...headers,
            },
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                resolve({ status: res.statusCode, headers: res.headers, body: data });
            });
        });
        req.on('error', reject);
        req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
        req.end();
    });
}

function httpsGetBinary(url, destPath, headers) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const options = {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                ...headers,
            },
        };
        const req = https.request(options, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                httpsGetBinary(res.headers.location, destPath, headers).then(resolve).catch(reject);
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`HTTP ${res.statusCode}: ${url}`));
                return;
            }
            const file = fs.createWriteStream(destPath);
            res.pipe(file);
            file.on('finish', () => file.close(() => resolve(destPath)));
        });
        req.on('error', (err) => { fs.unlink(destPath, () => {}); reject(err); });
        req.setTimeout(60000, () => { req.destroy(); reject(new Error('Download timeout')); });
        req.end();
    });
}

// ─── Helper: Download HLS playlist ────────────────────────────────────────────

function downloadPlaylist(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

// ─── Helper: Parse master playlist, return sorted streams ─────────────────────

function parseMasterPlaylist(body, baseUrl) {
    const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
    const streams = [];
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
            const bwMatch  = lines[i].match(/BANDWIDTH=(\d+)/);
            const resMatch = lines[i].match(/RESOLUTION=(\d+x\d+)/);
            const childUrl = lines[i + 1];
            if (childUrl && !childUrl.startsWith('#')) {
                streams.push({
                    bandwidth:  bwMatch  ? parseInt(bwMatch[1]) : 0,
                    resolution: resMatch ? resMatch[1] : 'unknown',
                    url: childUrl.startsWith('https://') ? childUrl : new URL(childUrl, baseUrl).href
                });
            }
        }
    }
    return streams.sort((a, b) => b.bandwidth - a.bandwidth);
}

// ─── Helper: Parse child playlist for segments and init segment ───────────────

function parseChildPlaylist(body) {
    const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
    let initUrl = null;
    const segUrls = [];
    for (const line of lines) {
        const mapMatch = line.match(/^#EXT-X-MAP:URI="([^"]+)"/);
        if (mapMatch) {
            initUrl = mapMatch[1];
        } else if (!line.startsWith('#') && line.includes('.m4s')) {
            segUrls.push(line);
        }
    }
    return { initUrl, segUrls };
}

// ─── Helper: Download segments and concat ─────────────────────────────────────

async function downloadSegments(baseUrl, { initUrl, segUrls }, label) {
    const allUrls = initUrl ? [initUrl, ...segUrls] : segUrls;
    log('[INFO]', label, `${allUrls.length} segment(s) to download`);
    const buffers = [];
    for (let i = 0; i < allUrls.length; i++) {
        const url = allUrls[i].startsWith('https://') ? allUrls[i] : new URL(allUrls[i], baseUrl).href;
        const data = await new Promise((resolve, reject) => {
            https.get(url, (res) => {
                if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}: ${url}`)); return; }
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => resolve(Buffer.concat(chunks)));
            }).on('error', reject);
        });
        buffers.push(data);
        if (i % 5 === 0) log('[INFO]', label, `${i + 1}/${allUrls.length} done`);
    }
    log('[OK]', label, 'All segments downloaded');
    return Buffer.concat(buffers);
}

// ─── Helper: Mux video + audio with ffmpeg ────────────────────────────────────

function muxVideo(videoPath, audioPath, outputPath) {
    return new Promise((resolve, reject) => {
        execFile(ffmpegPath, [
            '-y',
            '-fflags', '+genpts',
            '-i', videoPath,
            '-i', audioPath,
            '-map', '0:v:0',
            '-map', '1:a:0',
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-movflags', '+faststart',
            outputPath
        ], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            log('[FFMPEG]', 'FFMPEG', stderr.slice(-600));
            if (err) reject(err);
            else resolve();
        });
    });
}

// ─── QueryId auto-heal ──────────────────────────────────────────────────────────

async function healQueryIds() {
    // Env vars already applied; try remote source to get fresher IDs
    ghaGroup('[HEAL] QueryId refresh');
    let healed = false;

    // 1. Try community placeholder (no auth needed, ~1s)
    try {
        log('[INFO]', 'HEAL', `Fetching ${TWITTER_OPENAPI_URL}...`);
        const res = await httpsGet(TWITTER_OPENAPI_URL, { Accept: 'application/json' });
        if (res.status === 200) {
            const data = JSON.parse(res.body);
            let updated = 0;
            for (const op of ['UserByScreenName', 'UserTweets']) {
                const qid = data?.[op]?.queryId;
                if (qid && typeof qid === 'string' && qid !== QUERY_IDS[op]) {
                    log('[OK]', 'HEAL', `${op}: ${QUERY_IDS[op]} → ${qid} (from twitter-openapi)`);
                    QUERY_IDS[op] = qid;
                    updated++;
                }
            }
            if (updated > 0) healed = true;
            else log('[INFO]', 'HEAL', 'Remote IDs match fallback — no update needed');
        } else {
            log('[WARN]', 'HEAL', `Remote returned HTTP ${res.status}`);
        }
    } catch (e) {
        log('[WARN]', 'HEAL', `Remote fetch failed: ${e.message}`);
    }

    // 2. If remote had nothing, try scraping x.com bundles (needs auth)
    if (!healed && process.env.X_AUTH_TOKEN && process.env.X_CT0) {
        try {
            log('[INFO]', 'HEAL', 'Trying bundle scrape from x.com (fallback)...');
            const ct0 = process.env.X_CT0;
            const homeRes = await httpsGet('https://x.com/', {
                ...getAuthHeaders(ct0),
                Accept: 'text/html',
            });
            // Extract bundle URLs
            const bundleUrls = [...(homeRes.body.matchAll(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/[^"'\s]+\.js/g))].map(m => m[0]);
            const uniq = [...new Set(bundleUrls)].slice(0, 3);
            log('[INFO]', 'HEAL', `Found ${uniq.length} bundle(s)`);
            for (const url of uniq) {
                try {
                    const bRes = await httpsGet(url, {});
                    if (bRes.status !== 200) continue;
                    // Matches: queryId:"xxx",operationName:"UserTweets"  or reverse
                    const re1 = /queryId:"([^"]+)",operationName:"([^"]+)"/g;
                    const re2 = /operationName:"([^"]+)",queryId:"([^"]+)"/g;
                    for (const re of [re1, re2]) {
                        let m;
                        while ((m = re.exec(bRes.body)) !== null) {
                            const qid = re === re1 ? m[1] : m[2];
                            const op = re === re1 ? m[2] : m[1];
                            if ((op === 'UserByScreenName' || op === 'UserTweets') && qid !== QUERY_IDS[op]) {
                                log('[OK]', 'HEAL', `${op}: ${QUERY_IDS[op]} → ${qid} (from bundle ${url.split('/').pop()})`);
                                QUERY_IDS[op] = qid;
                                healed = true;
                            }
                        }
                    }
                } catch (e) {
                    log('[WARN]', 'HEAL', `Bundle fetch failed ${url}: ${e.message}`);
                }
            }
        } catch (e) {
            log('[WARN]', 'HEAL', `Bundle scrape failed: ${e.message}`);
        }
    }

    if (!healed) log('[INFO]', 'HEAL', 'Using fallback/env queryIds');
    log('[INFO]', 'HEAL', `Final: UserByScreenName=${QUERY_IDS.UserByScreenName} UserTweets=${QUERY_IDS.UserTweets}`);
    ghaEndGroup();
}

// ─── GraphQL API helpers ──────────────────────────────────────────────────────

function buildGraphQLUrl(queryId, operationName, variables, features) {
    const params = new URLSearchParams();
    params.set('variables', JSON.stringify(variables));
    params.set('features', JSON.stringify(features));
    return `https://x.com/i/api/graphql/${queryId}/${operationName}?${params.toString()}`;
}

function getAuthHeaders(ct0) {
    return {
        'authorization': `Bearer ${BEARER_TOKEN}`,
        'x-csrf-token': ct0,
        'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-active-user': 'yes',
        'x-twitter-client-language': 'en',
        'cookie': `auth_token=${process.env.X_AUTH_TOKEN}; ct0=${ct0}`,
    };
}

async function getUserId(username, ct0) {
    const variables = { screen_name: username, withSafetyModeUserFields: true };
    const url = buildGraphQLUrl(QUERY_IDS.UserByScreenName, 'UserByScreenName', variables, FEATURES);
    log('[INFO]', 'API', `Fetching user ID for @${username}...`);

    const res = await httpsGet(url, getAuthHeaders(ct0));
    if (res.status !== 200) {
        throw new Error(`UserByScreenName returned HTTP ${res.status}: ${res.body.substring(0, 300)}`);
    }

    const data = JSON.parse(res.body);
    const userResult = data?.data?.user?.result;
    if (!userResult) {
        throw new Error(`User @${username} not found`);
    }

    const userId = userResult.rest_id;
    log('[OK]', 'API', `User ID: ${userId}`);
    return userId;
}

async function getUserTweets(userId, ct0, count = 8) {
    const variables = {
        userId,
        count,
        includePromotedContent: false,
        withQuickPromoteEligibilityTweetFields: true,
        withVoice: true,
        withV2Timeline: true,
    };
    const url = buildGraphQLUrl(QUERY_IDS.UserTweets, 'UserTweets', variables, FEATURES);
    log('[INFO]', 'API', `Fetching ${count} tweets for user ${userId}...`);

    const res = await httpsGet(url, getAuthHeaders(ct0));
    if (res.status !== 200) {
        throw new Error(`UserTweets returned HTTP ${res.status}: ${res.body.substring(0, 300)}`);
    }

    const data = JSON.parse(res.body);
    const instructions = data?.data?.user?.result?.timeline?.timeline?.instructions || [];

    const tweets = [];
    for (const instruction of instructions) {
        const entries = instruction.entries || [];
        for (const entry of entries) {
            const tweet = parseTweetEntry(entry);
            if (tweet) tweets.push(tweet);
        }
    }

    log('[OK]', 'API', `Parsed ${tweets.length} tweet(s) from timeline`);
    return tweets;
}

function parseTweetEntry(entry) {
    const itemContent = entry?.content?.itemContent;
    if (!itemContent || itemContent.__typename !== 'TimelineTweet') return null;

    const tweetResults = itemContent.tweet_results;
    if (!tweetResults?.result) return null;

    const result = tweetResults.result;
    // Handle TweetWithVisibilityResults wrapper
    const tweet = result.__typename === 'TweetWithVisibilityResults' ? result.tweet : result;
    if (!tweet) return null;

    const legacy = tweet.legacy;
    if (!legacy) return null;

    // Check if it's a retweet — skip those
    if (legacy.retweeted_status_result) return null;

    // Extract text
    const text = legacy.full_text || '';

    // Extract timestamp
    const time = legacy.created_at ? new Date(legacy.created_at).toISOString() : null;

    // Extract media
    const images = [];
    let hasVideo = false;
    let videoId = null;
    let videoUrl = null;
    let videoWidth = null;
    let videoHeight = null;

    const media = legacy.extended_entities?.media || [];
    for (const m of media) {
        if (m.type === 'photo') {
            images.push(m.media_url_https);
        } else if (m.type === 'video' || m.type === 'animated_gif') {
            hasVideo = true;
            videoId = m.id_str;
            // Find best MP4 variant
            const variants = m.video_info?.variants || [];
            const mp4s = variants
                .filter(v => v.content_type === 'video/mp4')
                .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
            if (mp4s.length > 0) {
                videoUrl = mp4s[0].url;
            }
            // Extract dimensions
            if (m.original_info) {
                videoWidth = m.original_info.width;
                videoHeight = m.original_info.height;
            }
        }
    }

    // Check reply status
    const isReply = !!legacy.in_reply_to_status_id_str;
    const replyToHandle = legacy.in_reply_to_screen_name || null;

    // Check if pinned
    const isPinned = entry.content?.entryType === 'TimelineTimelineItem' && entry.sortIndex === undefined;

    return {
        text,
        time,
        isPinned,
        isReply,
        replyToHandle,
        hasVideo,
        videoId,
        videoUrl,
        images,
        videoWidth,
        videoHeight,
        tweetId: legacy.id_str,
    };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function getLatestTweets(username, maxTweets = 8) {
    const totalTimer = timer();
    log('[START]', 'START', `Scraper starting for @${username} (max ${maxTweets} tweets)`);

    if (!validateEnv()) {
        ghaError('Aborting — required secrets are missing');
        process.exit(1);
    }

    const ct0 = process.env.X_CT0;

    try {
        // Step 0: Auto-heal queryIds before any API call (env var > remote > bundle > fallback)
        await healQueryIds();

        // Step 1: Get user ID
        ghaGroup('[API] Fetch User ID');
        const apiTimer = timer();
        const userId = await getUserId(username, ct0);
        log('[OK]', 'API', `User ID resolved in ${apiTimer()}`);
        ghaEndGroup();

        // Step 2: Get tweets
        ghaGroup('[API] Fetch Tweets');
        const tweetTimer = timer();
        const scrapeResult = await getUserTweets(userId, ct0, maxTweets);
        log('[OK]', 'API', `${scrapeResult.length} tweet(s) fetched in ${tweetTimer()}`);

        scrapeResult.forEach((t, i) => {
            log(`  [${i}]`, 'ARTICLE',
                `time=${t.time} | video=${t.hasVideo} | videoId=${t.videoId || 'none'} | ` +
                `images=${t.images.length} | reply=${t.isReply} | replyTo=${t.replyToHandle || 'none'} | ` +
                `text="${t.text.substring(0, 80).replace(/\n/g, ' ')}..."`
            );
        });

        if (scrapeResult.length === 0) {
            ghaError('No tweets found');
            ghaEndGroup();
            console.log(JSON.stringify({ error: 'No tweets found' }));
            return;
        }
        ghaEndGroup();

        // Step 3: Download images for ALL tweets
        ghaGroup('[IMG] Image Download (all tweets)');
        for (let tweetIdx = 0; tweetIdx < scrapeResult.length; tweetIdx++) {
            const tweet = scrapeResult[tweetIdx];
            for (let imgIdx = 0; imgIdx < tweet.images.length; imgIdx++) {
                const originalUrl = tweet.images[imgIdx];
                let highResUrl;
                if (originalUrl.includes('?')) {
                    const [base, params] = originalUrl.split('?');
                    const urlParams = new URLSearchParams(params);
                    urlParams.set('name', 'orig');
                    highResUrl = `${base}?${urlParams.toString()}`;
                } else {
                    const ext = originalUrl.split('.').pop().toLowerCase();
                    const fmt = ext === 'png' ? 'png' : 'jpg';
                    highResUrl = `${originalUrl}?format=${fmt}&name=orig`;
                }

                const filename = `tweet_img_${tweetIdx}_${imgIdx}.jpg`;
                log('[DOWNLOAD]', `IMG[t${tweetIdx}_${imgIdx}]`, highResUrl);
                const imgTimer = timer();
                try {
                    await httpsGetBinary(highResUrl, filename);
                    const size = (fs.statSync(filename).size / 1024).toFixed(1);
                    log('[OK]', `IMG[t${tweetIdx}_${imgIdx}]`, `Saved ${filename} — ${size} KB in ${imgTimer()}`);
                } catch (e) {
                    ghaError(`IMG[t${tweetIdx}_${imgIdx}]: ${e.message}`);
                }
            }
        }
        ghaEndGroup();

        // Step 4: Download videos for ALL tweets that have videos
        ghaGroup('[VIDEO] Video Downloads');
        for (let tweetIdx = 0; tweetIdx < scrapeResult.length; tweetIdx++) {
            const tweet = scrapeResult[tweetIdx];
            if (!tweet.hasVideo) continue;

            const videoOutPath = `tweet_video_${tweetIdx}.mp4`;

            if (tweet.videoUrl) {
                // Direct MP4 download (from GraphQL API)
                log('[DOWNLOAD]', 'VIDEO', `Downloading direct MP4: ${tweet.videoUrl}`);
                const videoTimer = timer();
                try {
                    await httpsGetBinary(tweet.videoUrl, videoOutPath);
                    const size = (fs.statSync(videoOutPath).size / 1024).toFixed(1);
                    log('[OK]', 'VIDEO', `Saved ${videoOutPath} — ${size} KB in ${videoTimer()}`);
                    tweet.videoPath = videoOutPath;
                } catch (e) {
                    ghaError(`Video download failed for tweet ${tweetIdx}: ${e.message}`);
                }
            } else {
                // Try HLS download (fallback — need m3u8 manifest from network interception)
                log('[WARN]', 'VIDEO', `No direct video URL for tweet ${tweetIdx} — skipping video download`);
            }
        }
        ghaEndGroup();

        // Clean up videoUrl from output (bot.py doesn't need it)
        for (const tweet of scrapeResult) {
            delete tweet.videoUrl;
        }

        // ── Summary ──────────────────────────────────────────────────────────
        ghaGroup('[SUMMARY] Run Summary');
        log('[TIME]', 'TIMING', `Total elapsed: ${totalTimer()}`);
        log('[TWEETS]', 'TWEETS', `${scrapeResult.length} tweet(s) returned`);
        ghaEndGroup();

        // Return array of tweets with metadata
        const output = {
            tweets: scrapeResult,
            videoManifests: {},
        };
        console.log(JSON.stringify(output));

    } catch (error) {
        ghaError(`Unhandled exception: ${error.message}`);
        log('[FATAL]', 'FATAL', error.stack || error.message);
        console.error(`{"error": "${error.message.replace(/"/g, '\\"')}"}`);
        process.exit(1);
    }
}

getLatestTweets('FateGO_USA', 8);
