# 🐦 X-Bsky-Mirror

> Mirror tweets from X (Twitter) to Bluesky automatically — no browser, no Puppeteer, no ffmpeg.

A lightweight scraper + bot that fetches tweets via X's internal GraphQL API, downloads attached media, and reposts everything to Bluesky — **designed to run on GitHub Actions**.

---

## ✨ Features

- **Scrapes tweets** from a target X account using the internal GraphQL API (no browser required)
- **Downloads media** — high-res images (`?name=orig`) and direct MP4 videos (highest bitrate variant)
- **Auto-heals query IDs** — refreshes Twitter GraphQL query IDs at runtime from a community source or by scraping x.com JS bundles, so it keeps working when Twitter rotates them
- **Deduplicates** — checks the last 16 Bluesky posts (normalized text: URLs and ellipsis stripped); partial match on first 100 chars also triggers skip
- **Thread support** — parses `TimelineTimelineModule` entries (Twitter's thread container), deduplicates by tweet ID, and threads follow-up replies under the main post via `last_posted_ref`
- **Reply threading** — stateless text-match parent lookup in recent Bluesky posts, with a fast-path for same-run chains
- **Rich formatting** — builds link facets for URLs and hashtags, attaches OpenGraph link cards for text-only posts
- **Image compression** — quality reduction → resize to stay under Bluesky's 1.9 MB blob limit
- **Bare-link filtering** — skips "More info →" link-only posts that have no real content (replies are exempt so thread parts still post)
- **Fallback images** — uses a local placeholder image when a tweet has no media
- **Designed for GitHub Actions** — structured logging with collapsible `::group::` sections (all logs to stderr, only JSON to stdout)

---

## 🚀 Quick Start

### Authentication (Required)

You need two cookies from an authenticated X/Twitter session:

| Env Var | Cookie Name | Description |
|---------|-------------|-------------|
| `X_AUTH_TOKEN` | `auth_token` | Your authenticated session token |
| `X_CT0` | `ct0` | CSRF token (usually same session) |

**How to get them:**
1. Install **EditThisCookie V3** Chrome extension: <https://chromewebstore.google.com/detail/editthiscookie-v3/ojfebgpkimhlhcblbalbfjblapadhbol>
2. Log into X/Twitter in your browser
3. Click the extension → Export cookies for `x.com`
4. Copy `auth_token` and `ct0` values

### Running on GitHub Actions

1. **Fork this repository** to your own GitHub account
2. **Add secrets** in your fork's Settings → Secrets and variables → Actions:

   | Secret | Source | Description |
   |--------|--------|-------------|
   | `X_AUTH_TOKEN` | X/Twitter `auth_token` cookie | Your authenticated session token |
   | `X_CT0` | X/Twitter `ct0` cookie | CSRF token from same session |
   | `BSKY_USER` | Bluesky handle (e.g. `yourname.bsky.social`) | Your Bluesky login identifier |
   | `BSKY_PASSWORD` | Bluesky app password | Create at [bsky.app/settings/app-passwords](https://bsky.app/settings/app-passwords) |

3. **Edit the target account** in `scraper.js` (last line):
   ```js
   getLatestTweets('YOUR_TARGET_HANDLE', 8);  // change handle & max tweets
   ```
4. **Enable Actions** on your fork: Actions tab → "I understand my workflows, go ahead and enable them"
5. **Trigger it** via cron-job.org (see [Scheduling](#scheduling)) or manually: Actions tab → "X-Bsky-Mirror Bot" → "Run workflow"

---

## 💻 Running Locally

```bash
# Python deps (no requirements.txt — install manually)
pip install atproto Pillow requests

# Node deps: none (scraper uses only Node built-ins)

# Set env vars (see Configuration below), then:
python bot.py
```

---

## 🏗️ How It Works

| Component | Role |
|-----------|------|
| **`scraper.js`** | Entry point — validates env, heals query IDs, fetches tweets via GraphQL, downloads media, outputs structured JSON to stdout |
| **`lib/`** | Node modules — `api.js` (GraphQL calls), `auth.js` (cookie validation), `config.js` (query IDs, bearer token), `heal.js` (query ID refresh), `http.js` (HTTPS helpers), `media.js` (image/video downloads), `log.js` (GitHub Actions logging) |
| **`bot.py`** | Entry point — spawns the scraper, then for each tweet: checks dedup, detects replies, compresses images, posts to Bluesky (images/video/text + link card), cleans up temp files |
| **`xbmirror/`** | Python package — `config.py` (env vars), `posting.py` (tweet → Bluesky post logic), `dedup.py` (duplicate detection + parent lookup), `embeds.py` (OpenGraph link cards), `images.py` (compression), `fallbacks.py` (placeholder images), `scraper_runner.py` (subprocess bridge), `log.py` (logging helpers) |
| **`assets/images/`** | Fallback images used when a tweet has no media |

### Pipeline

```
scraper.js (Node)
  ├─ heal query IDs (twitter-openapi → x.com bundles → hardcoded fallback)
  ├─ getUserId(handle) via GraphQL
  ├─ getUserTweets(userId) via GraphQL
  ├─ download images (high-res ?name=orig)
  ├─ download videos (direct MP4, highest bitrate)
  └─ output JSON → stdout
        │
        ▼
bot.py (Python)
  ├─ parse scraper JSON
  ├─ for each tweet (oldest → newest):
  │   ├─ skip if bare "More info" link
  │   ├─ skip if older than 2 days
  │   ├─ skip if duplicate (last 16 posts, normalized)
  │   ├─ if reply: find parent post → thread under it
  │   ├─ compress images / prepare video
  │   ├─ build rich text (URL facets, hashtags)
  │   ├─ post to Bluesky (video > images > text+link card)
  │   └─ cleanup temp files
  └─ summary
```

---

## ⏰ Scheduling

This project is designed to run on **GitHub Actions**.

**GitHub's built-in `schedule:` trigger can be delayed.** For **exact, reliable timing**, use [cron-job.org](https://cron-job.org):

1. Create a free account at cron-job.org
2. Create a new cronjob:
   - **URL**: `https://api.github.com/repos/YOUR_USERNAME/YOUR_FORK/dispatches`
   - **Method**: `POST`
   - **Headers**:
     - `Authorization: Bearer YOUR_GITHUB_PAT` (classic PAT with `repo` scope)
     - `Accept: application/vnd.github+json`
     - `Content-Type: application/json`
   - **Body (JSON)**:
     ```json
     { "event_type": "trigger-my-bot" }
     ```
   - **Schedule**: Every 15 minutes (or your preferred interval)
3. The workflow already listens for `repository_dispatch` with type `trigger-my-bot`

This gives you precise, reliable execution without GitHub's schedule jitter.

**Note:** If you prefer GitHub's built-in scheduling, add a `schedule:` trigger to `.github/workflows/main.yml`:

```yaml
on:
  schedule:
    - cron: '*/15 * * * *'  # Every 15 minutes
  workflow_dispatch:
  repository_dispatch:
    types: [trigger-my-bot]
```

---

## ⚙️ Configuration

### Target account (`scraper.js`)

```javascript
// Last line of scraper.js
getLatestTweets('[X_Account_Handle]', 8);  // username, maxTweets
```

| Parameter | Description | Default |
|-----------|-------------|---------|
| `username` | X/Twitter handle (without @) | `'FateGO_USA'` |
| `maxTweets` | Maximum tweets to fetch per run | `8` |

### Python (`xbmirror/config.py`)

| Variable | Default | Description |
|----------|---------|-------------|
| `FETCH_TIMEOUT` | `180` | Max seconds to wait for the Node scraper subprocess |
| `SIMULATION_MODE` | `False` | Set to `True` to test the full pipeline without X cookies (uses hardcoded sample tweet) |

### Query IDs (`lib/config.js`)

Query IDs are refreshed at runtime. Priority order:

1. `X_QUERY_ID_*` env vars (if set — these win over everything)
2. [twitter-openapi](https://github.com/fa0311/twitter-openapi) remote fetch (~1s)
3. x.com JS bundle scrape (fallback)
4. Hardcoded fallback IDs

| Env Var | Operation |
|---------|-----------|
| `X_QUERY_ID_USER_BY_SCREEN_NAME` | `UserByScreenName` |
| `X_QUERY_ID_USER_TWEETS` | `UserTweets` |

### Tunable Timeouts (`lib/http.js`)

| What | Default |
|------|---------|
| `httpsGet` (JSON requests) | 30 s |
| `httpsGetBinary` (file downloads) | 60 s |

---

## 📤 Output Format

The scraper outputs a single JSON object to **stdout**:

```json
{
  "tweets": [
    {
      "text": "Tweet text content...",
      "time": "2026-02-15T12:34:56.000Z",
      "isPinned": false,
      "isReply": false,
      "replyToHandle": null,
      "inReplyToStatusId": null,
      "hasVideo": true,
      "videoId": "1234567890123456789",
      "videoUrl": "https://video.twimg.com/.../vid.mp4",
      "videoWidth": 1280,
      "videoHeight": 720,
      "videoPath": "tweet_video_0.mp4",
      "images": ["https://pbs.twimg.com/media/xxx.jpg"],
      "tweetId": "1234567890123456789"
    }
  ],
  "videoManifests": {}
}
```

### Tweet Fields

| Field | Description |
|-------|-------------|
| `text` | Full tweet text (t.co links expanded/removed, HTML entities decoded) |
| `time` | ISO timestamp from `created_at` |
| `isPinned` | Whether tweet is pinned |
| `isReply` | Whether tweet is a reply |
| `replyToHandle` | Handle being replied to (if reply) |
| `inReplyToStatusId` | Status ID being replied to (if reply) |
| `hasVideo` | Whether tweet has video/GIF |
| `videoId` | Twitter video ID |
| `videoUrl` | Direct MP4 URL (highest bitrate) |
| `videoPath` | Local path to downloaded MP4 (added by `media.js` after download) |
| `videoWidth` / `videoHeight` | Video resolution from `original_info` |
| `images` | Array of image URLs |
| `tweetId` | Tweet status ID |

---

## 📦 Dependencies

| Package | Language | Purpose |
|---------|----------|---------|
| *(none)* | Node | Uses only built-in `https`, `fs`, `url` modules |
| `atproto` | Python | Bluesky API client |
| `Pillow` | Python | Image processing/compression |
| `requests` | Python | HTTP requests |

---

## 🔒 Security Notes

- **Never commit** `X_AUTH_TOKEN` or `X_CT0` to git (they're in `.gitignore`)
- Rotate cookies periodically — they expire
- Use **GitHub Secrets** or your CI/CD secret store for automation
- The bearer token in `lib/config.js` is Twitter's public web client token (not a secret)

---

## 🐛 Troubleshooting

| Issue | Solution |
|-------|----------|
| `X_AUTH_TOKEN secret is missing` | Set secrets in your fork's Settings → Secrets and variables → Actions |
| `UserTweets returned HTTP 401` | Cookies expired — re-export `auth_token` and `ct0` |
| `UserTweets returned HTTP 403` | Query IDs may be stale — check `[HEAL]` logs; wait a few minutes and retry |
| `No tweets found` | Account may be private, suspended, or handle changed |
| `Post failed at API level` | Bluesky rate limit or invalid app password — check error in logs |
| `Parent post not found` | Reply threading failed — the parent tweet may not have been posted yet or is older than 16 posts |
| Scraper timeout | Increase `FETCH_TIMEOUT` in `xbmirror/config.py` |

### Debugging Tips

- Check stderr for timestamped logs with `[INFO]`, `[OK]`, `[ERROR]`, `[WARN]` tags
- In GitHub Actions, logs include `::group::` annotations for collapsible sections
- Set `SIMULATION_MODE = True` in `xbmirror/config.py` to test without X cookies

---

## 📌 Key Behaviors

- **Processing order**: Tweets are processed oldest-to-newest (reversed from scraper output), so threads post in the right order
- **Age filter**: Tweets older than 2 days are skipped
- **Media priority**: Video file > tweet images (including video thumbnails) > local fallback image
- **Dedup normalization**: URLs, ellipsis (`...`), and extra whitespace are stripped before comparison so truncated reposts are caught
- **Bare-link filter exemption**: Replies are exempt from the "More info" filter so threaded parts like `More info ➡️` still post
- **Auto-heal priority**: `X_QUERY_ID_*` env vars → twitter-openapi remote fetch → x.com bundle scrape → hardcoded fallback
- **Query ID self-healing**: If Twitter rotates GraphQL query IDs, the scraper fetches fresh ones from [twitter-openapi](https://github.com/fa0311/twitter-openapi) (~1s) or scrapes them from x.com JS bundles before making API calls

---

## ⚠️ Gotchas

- `bot.py` must be run from the repo root — all file paths are relative
- The scraper writes images/videos to the current working directory as `tweet_img_{t}_{i}.jpg` / `tweet_video_{t}.mp4`; `bot.py` reads and deletes them after posting
- No npm dependencies, no `package.json` — the scraper uses only Node built-ins (`https`, `fs`, `url`), so there's no `npm install` step in the workflow
- No lint, typecheck, or test suite — validate changes by reading the code carefully
- Reply threading is stateless: if a parent tweet was never mirrored, the reply is skipped (no state file to fall back on)

---

## 📄 License

MIT — see [LICENSE](LICENSE) for details.

### Third-Party Attribution

This project uses [twitter-openapi](https://github.com/fa0311/twitter-openapi) by [yuki](https://yuki0311.com/) as a runtime data source for GraphQL query ID auto-healing. It is subject to its own license, which includes an additional clause restricting use for spam-related activity (mass messaging, artificial engagement, automated disruption, or distribution of false information). See the [twitter-openapi LICENSE](https://github.com/fa0311/twitter-openapi/blob/main/LICENSE) for full terms.

### Dependencies

| Package | License | Author |
|---|---|---|
| [atproto](https://github.com/MarshalX/atproto) | MIT | [Ilya (Marshal)](https://atproto.blue) |
| [Pillow](https://github.com/python-pillow/Pillow) | MIT-CMU | [Jeffrey "Alex" Clark](https://python-pillow.org) and contributors |
| [requests](https://github.com/psf/requests) | Apache 2.0 | [Kenneth Reitz](https://kennethreitz.org) and the [PSF](https://www.python.org/psf/) |
