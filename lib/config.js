// ─── Constants ────────────────────────────────────────────────────────────────

const BEARER_TOKEN = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

// Query IDs — hardcoded fallback; refreshed at runtime before API calls
const QUERY_IDS = {
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

module.exports = {
    BEARER_TOKEN,
    QUERY_IDS,
    TWITTER_OPENAPI_URL,
    FEATURES,
};
