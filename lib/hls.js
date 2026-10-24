const https = require('https');
const { execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const { log } = require('./log');

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

module.exports = {
    downloadPlaylist,
    parseMasterPlaylist,
    parseChildPlaylist,
    downloadSegments,
    muxVideo,
};
