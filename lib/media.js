const fs = require('fs');

const { httpsGetBinary } = require('./http');
const { ghaEndGroup, ghaError, ghaGroup, log, timer } = require('./log');

// ─── Media downloads (all tweets) ─────────────────────────────────────────────

async function downloadTweetImages(tweets) {
    ghaGroup('[IMG] Image Download (all tweets)');
    for (let tweetIdx = 0; tweetIdx < tweets.length; tweetIdx++) {
        const tweet = tweets[tweetIdx];
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
}

async function downloadTweetVideos(tweets) {
    ghaGroup('[VIDEO] Video Downloads');
    for (let tweetIdx = 0; tweetIdx < tweets.length; tweetIdx++) {
        const tweet = tweets[tweetIdx];
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
}

module.exports = {
    downloadTweetImages,
    downloadTweetVideos,
};
