import datetime

from atproto import Client

from xbmirror.config import BSKY_HANDLE, BSKY_PASSWORD, SIMULATION_MODE
from xbmirror.log import gha_end_group, gha_error, gha_group, log
from xbmirror.posting import process_tweet
from xbmirror.scraper_runner import get_latest_tweet_data


def main():
    client = Client()

    last_posted_text = ""

    try:
        client.login(BSKY_HANDLE, BSKY_PASSWORD)
    except Exception as e:
        gha_error(f"Failed to login to Bluesky: {e}")
        return

    if SIMULATION_MODE:
        gha_group("[SIM] Simulation Mode")
        log("[INFO]", "MAIN", "Running in SIMULATION MODE")

        tweet_data = {
            'text': """This is a test:
            ★5 (SSR) Andromeda
            "I am totally a god...Revere me. Fear me, and make sure you don't overwork me...me...me...(Echo)"
            fate-go.us/news/?category=NEWS&article=%2Fiframe%2F2026%2F0204_sf_pu2%2F
            youtu.be/uAB02z1coVI
            https://anime.fate-go.us/lostfujimaru/
            ➡️
#FateGOUS""",
            'time': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'images': [],
            'hasVideo': True
        }
        scraper_result = {'tweets': [tweet_data], 'videoManifests': {}}
    else:
        gha_group("[PROD] Production Mode")
        log("[INFO]", "MAIN", "Running in PRODUCTION MODE")
        scraper_result = get_latest_tweet_data()

    if not scraper_result or not scraper_result.get('tweets'):
        gha_error("No tweet data received — skipping run")
        gha_end_group()
        return

    tweets = scraper_result['tweets']
    log("[INFO]", "MAIN", f"Processing {len(tweets)} tweet(s) from oldest to newest")

    # Process tweets from OLDEST to NEWEST. The scraper's timeline array is NOT strictly
    # chronological (parents appear before their replies even when posted earlier), so sort
    # by timestamp instead of blindly reversing.
    def _tweet_sort_key(item):
        tweet, _idx = item
        try:
            return datetime.datetime.fromisoformat(tweet.get('time', '').replace('Z', '+00:00'))
        except (ValueError, TypeError):
            return datetime.datetime.max.replace(tzinfo=datetime.timezone.utc)

    tweets_with_idx = sorted([(t, i) for i, t in enumerate(tweets)], key=_tweet_sort_key)
    tweet_text_by_id = {t.get('tweetId'): t.get('text', '') for t in tweets if t.get('tweetId')}

    posted_count = 0
    skipped_count = 0
    last_posted_ref = None  # Track the most recently posted tweet's (uri, cid) for threading
    prev_posted_tweet_id = None  # tweetId of the most recently posted tweet

    for tweet_index, (tweet_data, original_index) in enumerate(tweets_with_idx):
        # original_index maps back to scraper output (used for temp file naming)
        tweet_data['_original_index'] = original_index

        log("[PROCESS]", "MAIN", f"=== Processing tweet {tweet_index+1}/{len(tweets)} (original index {original_index}) ===")

        success, reason, posted_ref = process_tweet(client, tweet_data, original_index, len(tweets), last_posted_ref, prev_posted_tweet_id, tweet_text_by_id)

        if success:
            posted_count += 1
            if posted_ref:
                last_posted_ref = posted_ref
            prev_posted_tweet_id = tweet_data.get('tweetId')
            log("[OK]", "MAIN", f"Successfully posted tweet {tweet_index+1}/{len(tweets)}")
        else:
            if reason not in ("duplicate", "too_old", "no_timestamp", "empty_text", "skipped_bare_link", "parent_not_found"):
                skipped_count += 1
            log("[SKIP]", "MAIN", f"Tweet {tweet_index+1}/{len(tweets)} skipped: {reason}")

    log("[SUMMARY]", "MAIN", f"Done! Posted: {posted_count}, Skipped: {skipped_count}")
    gha_end_group()


if __name__ == "__main__":
    main()
