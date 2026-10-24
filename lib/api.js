const { FEATURES, QUERY_IDS } = require('./config');
const { getAuthHeaders } = require('./auth');
const { httpsGet } = require('./http');
const { log } = require('./log');

// ─── Helper: Decode HTML entities (GraphQL legacy.full_text is escaped) ───────

function decodeHTMLEntities(str) {
    return str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'");
}

// ─── GraphQL API helpers ──────────────────────────────────────────────────────

function buildGraphQLUrl(queryId, operationName, variables, features) {
    const params = new URLSearchParams();
    params.set('variables', JSON.stringify(variables));
    params.set('features', JSON.stringify(features));
    return `https://x.com/i/api/graphql/${queryId}/${operationName}?${params.toString()}`;
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
    const seenIds = new Set();
    for (const instruction of instructions) {
        const entries = instruction.entries || [];
        for (const entry of entries) {
            const tweet = parseTweetEntry(entry);
            if (tweet) {
                if (tweet.tweetId && seenIds.has(tweet.tweetId)) continue;
                if (tweet.tweetId) seenIds.add(tweet.tweetId);
                tweets.push(tweet);
                continue;
            }
            // Handle conversation modules (threads) — entry.content.items[]
            if (entry?.content?.entryType === 'TimelineTimelineModule') {
                const items = entry.content.items || [];
                for (const item of items) {
                    const innerEntry = { content: item.item || item };
                    const t = parseTweetEntry(innerEntry);
                    if (t) {
                        if (t.tweetId && seenIds.has(t.tweetId)) continue;
                        if (t.tweetId) seenIds.add(t.tweetId);
                        tweets.push(t);
                    }
                }
            }
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

    // Extract text — replicate Puppeteer display: strip all t.co, use truncated display_url (28 inc "...")
    let text = legacy.full_text || '';
    const mediaUrls = new Set((legacy.extended_entities?.media || []).map(m => m.url));
    const urlEntities = legacy.entities?.urls || [];
    for (const u of urlEntities) {
        if (mediaUrls.has(u.url)) {
            // Media card t.co — strip entirely (video/photo card not in tweetText)
            text = text.split(u.url).join('');
        } else {
            // Content link t.co — replace with full expanded URL without https (bot will truncate display to 28 for facets, href stays full)
            let full = (u.expanded_url || u.display_url || '').replace(/^https?:\/\//, '');
            text = text.split(u.url).join(full);
        }
    }
    // Clean up remaining bare t.co and collapse spaces but preserve original newlines (\n, \n\n)
    text = text.replace(/https?:\/\/t\.co\/\S+/g, '');
    text = decodeHTMLEntities(text);
    text = text.replace(/ +\n/g, '\n').replace(/[ \t]{2,}/g, ' ');
    text = text.replace(/\n{3,}/g, '\n\n').trim();

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
    const inReplyToStatusId = legacy.in_reply_to_status_id_str || null;

    // Check if pinned
    const isPinned = entry.content?.entryType === 'TimelineTimelineItem' && entry.sortIndex === undefined;

    return {
        text,
        time,
        isPinned,
        isReply,
        replyToHandle,
        inReplyToStatusId,
        hasVideo,
        videoId,
        videoUrl,
        images,
        videoWidth,
        videoHeight,
        tweetId: legacy.id_str,
    };
}

module.exports = {
    decodeHTMLEntities,
    buildGraphQLUrl,
    getUserId,
    getUserTweets,
    parseTweetEntry,
};
