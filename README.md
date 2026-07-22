# X-Bsky-Mirror

A Node.js scraper that fetches tweets from X (Twitter) using Puppeteer with stealth mode, downloads attached media (images, videos, GIFs), processes HLS video streams with ffmpeg, and outputs structured JSON — **designed to run on GitHub Actions** for mirroring X posts to Bluesky.

---

## 🎯 What This Does

- **Scrapes tweets** from a specified X/Twitter account using Puppeteer with stealth plugin
- **Downloads media** — images (JPG/PNG), videos (HLS/m3u8 streams), and GIFs
- **Processes videos** — downloads HLS master/child playlists, selects highest quality video + audio tracks, downloads segments, and muxes them together using ffmpeg into MP4
- **Outputs JSON** — structured tweet data (text, time, media URLs, video dimensions, local file paths)
- **Designed for GitHub Actions** — runs headless, outputs JSON to stdout, exits cleanly

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
5. **Trigger it** via cron-job.org (see [Scheduling](#-scheduling)) or manually: Actions tab → "X-Bsky-Mirror Bot" → "Run workflow"

---

### How It Works

- **`scraper.js`** — Headless Chrome (Puppeteer + Stealth) logs into X with your cookies, scrolls the target profile, downloads images/videos/GIFs, muxes HLS video streams with ffmpeg, outputs structured JSON to stdout
- **`bot.py`** — Reads scraper JSON, deduplicates against recent posts, uploads media to Bluesky (with compression), posts with proper formatting (link cards, alt text, video aspect ratios), cleans up temp files
- **Simulation mode** — Set `SIMULATION_MODE = True` in `bot.py` to test the full pipeline without X cookies (uses hardcoded sample tweet data)

---

## ⏰ Scheduling

This project is designed to run on **GitHub Actions**

**⚠️ GitHub's built-in `schedule:` trigger can be delayed**. For **exact, reliable timing**, use [cron-job.org](https://cron-job.org):

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

**Note:** If you prefer GitHub's built-in scheduling, just add a `schedule:` trigger to `.github/workflows/main.yml`:

```yaml
on: 
  schedule:  
     - cron: '*/15 * * * *'  # Every 15 minutes (or your preferred interval)
  workflow_dispatch:    
  repository_dispatch:
    types: [trigger-my-bot]
```

---

## ⚙️ Configuration

Edit `scraper.js` directly — the main configuration is at the bottom:

```javascript
// Last line of scraper.js
getLatestTweets('[X_Account_Handle]', 8);  // username, maxTweets
```

| Parameter | Description | Default |
|-----------|-------------|---------|
| `username` | X/Twitter handle (without @) | `'[X_Account_Handle]'` |
| `maxTweets` | Maximum tweets to fetch per run | `8` |

### Other Tunables (in `scraper.js`)

| Variable | Location | Default | Description |
|----------|----------|---------|-------------|
| `page.goto` timeout | line ~200 | `60000` | Page load timeout (ms) |
| `waitForSelector` timeout | line ~210 | `15000` | Tweet selector wait timeout |
| `browser.close` timeout | line ~580 | `6000` | Browser close grace period (ms) |
| `ffmpeg` args | `muxVideo()` | `-b:a 128k` | Audio bitrate for muxed MP4 |

---

## 📤 Output Format

The script outputs a single JSON object to **stdout**:

```json
{
  "tweets": [
    {
      "text": "Tweet text content...",
      "time": "2024-06-15T12:34:56.000Z",
      "isPinned": false,
      "hasVideo": true,
      "videoId": "1234567890123456789",
      "images": [
        "https://pbs.twimg.com/media/xxx.jpg"
      ],
      "videoPath": "tweet_video_0.mp4",
      "videoWidth": 1280,
      "videoHeight": 720
    }
  ],
  "videoManifests": {
    "1234567890123456789": {
      "masterUrl": "https://video.twimg.com/.../master.m3u8",
      "masterBody": "#EXTM3U\n#EXT-X-STREAM-INF...",
      "allManifests": [
        { "url": "...", "body": "..." }
      ]
    }
  }
}
```

---

### Tweet Fields
| Field | Description |
|-------|-------------|
| `text` | Full tweet text (with alt text from images) |
| `time` | ISO timestamp from `<time>` element |
| `isPinned` | Whether tweet is pinned |
| `hasVideo` | Whether tweet has video/GIF |
| `videoId` | Twitter video ID (for matching manifests) |
| `images` | Array of image URLs (high-res `?name=orig`) |
| `videoPath` | Local path to muxed MP4 (if video downloaded) |
| `videoWidth` / `videoHeight` | Video resolution from master playlist |

### videoManifests
Keyed by `videoId`, contains master playlist URL, body, and all captured manifests for that video.

---

## 🔧 Dependencies

| Package | Purpose |
|---------|---------|
| `puppeteer` | Headless Chrome automation |
| `puppeteer-extra` | Plugin system for Puppeteer |
| `puppeteer-extra-plugin-stealth` | Evades bot detection |
| `ffmpeg-static` | Bundled ffmpeg binary (no system install needed) |
| `atproto` | Bluesky API client (Python) |
| `Pillow` | Image processing/compression (Python) |
| `requests` | HTTP requests (Python) |

---

## 🔒 Security Notes

- **Never commit** `X_AUTH_TOKEN` or `X_CT0` to git (they're in `.gitignore`)
- Rotate cookies periodically — they expire
- Use **GitHub Secrets** or your CI/CD secret store for automation
- The script runs headless Chromium — ensure your environment supports it (Docker: `--cap-add=SYS_ADMIN` or use `puppeteer` with `--no-sandbox`)

---

## 🐛 Troubleshooting

| Issue | Solution |
|-------|----------|
| `X_AUTH_TOKEN secret is missing` | Set env vars before running |
| `Navigation timeout` | Increase `page.goto` timeout; check network |
| `No tweets found` | Account may be private, suspended, or handle changed |
| `ffmpeg not found` | `npm install ffmpeg-static` or install ffmpeg system-wide |
| `Browser closed prematurely` | Increase browser close timeout; check for zombie processes |
| `Video download failed` | HLS streams may be geo-blocked or expired; check network logs |

### Debugging Tips

- Check stderr for timestamped logs with `[INFO]`, `[OK]`, `[ERROR]`, `[FFMPEG]` tags
- In GitHub Actions, logs include `::group::` annotations for collapsible sections

---

## 📝 License

MIT — see [LICENSE](LICENSE) for details.