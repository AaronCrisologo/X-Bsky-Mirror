process.stdout.setEncoding('utf8');
process.stderr.setEncoding('utf8');

const { getUserId, getUserTweets } = require('./lib/api');
const { validateEnv } = require('./lib/auth');
const { healQueryIds } = require('./lib/heal');
const { downloadTweetImages, downloadTweetVideos } = require('./lib/media');
const { ghaEndGroup, ghaError, ghaGroup, log, timer } = require('./lib/log');

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
                `images=${t.images.length} | reply=${t.isReply} | replyTo=${t.replyToHandle || 'none'} | parentId=${t.inReplyToStatusId || 'none'} | ` +
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
        await downloadTweetImages(scrapeResult);

        // Step 4: Download videos for ALL tweets that have videos
        await downloadTweetVideos(scrapeResult);

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

// Config via env
const TARGET_ACCOUNT = process.env.TARGET_ACCOUNT;
const MAX_TWEETS = parseInt(process.env.MAX_TWEETS, 10) || 8;

getLatestTweets(TARGET_ACCOUNT, MAX_TWEETS);
