// ═══════ PITAYA CONVERT — SILNIK KONWERSJI ═══════
// Czysty Node.js (bez Electrona), żeby dało się go testować automatycznie (test/run-tests.js).
//  • wykrywa działające kodery wideo (NVIDIA NVENC, VAAPI, Intel QSV, AMD AMF, Apple, CPU)
//    w systemowym ffmpeg i w ffmpeg dołączonym do aplikacji — każdy jest naprawdę testowany,
//  • konwertuje wideo, audio i grafikę; przy błędzie kodera sprzętowego sam przechodzi na CPU,
//  • raportuje postęp, da się przerwać (AbortSignal), nie nadpisuje istniejących plików.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

// ───── Formaty ─────
const VIDEO_IN = ['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'ts', 'm4v', 'mpg', 'mpeg', 'wmv', '3gp', 'm2ts', 'mts', 'ogv'];
const AUDIO_IN = ['mp3', 'wav', 'flac', 'aac', 'ogg', 'oga', 'opus', 'm4a', 'wma', 'aiff', 'aif', 'alac', 'amr', 'ac3'];
const IMAGE_IN = ['png', 'jpg', 'jpeg', 'jfif', 'webp', 'bmp', 'tiff', 'tif', 'svg', 'ico', 'gif', 'avif', 'heic', 'heif'];

const TARGETS = {
    video: {
        'Wideo': [
            { ext: 'mp4', label: 'MP4 — najlepsza zgodność' },
            { ext: 'mkv', label: 'MKV' },
            { ext: 'mov', label: 'MOV' },
            { ext: 'webm', label: 'WEBM — VP9 (do internetu)' },
            { ext: 'avi', label: 'AVI — H.264' },
        ],
        'Dźwięk z filmu': [
            { ext: 'mp3', label: 'MP3 — 320 kbps' },
            { ext: 'm4a', label: 'M4A — AAC 256 kbps' },
            { ext: 'flac', label: 'FLAC — bezstratny' },
            { ext: 'wav', label: 'WAV — 16-bit PCM' },
            { ext: 'ogg', label: 'OGG — Vorbis' },
            { ext: 'opus', label: 'OPUS — 160 kbps' },
        ],
        'Animacja': [
            { ext: 'gif', label: 'GIF — 15 klatek/s' },
        ],
    },
    audio: {
        'Stratne': [
            { ext: 'mp3', label: 'MP3 — 320 kbps' },
            { ext: 'm4a', label: 'M4A — AAC 256 kbps' },
            { ext: 'aac', label: 'AAC — 256 kbps' },
            { ext: 'ogg', label: 'OGG — Vorbis' },
            { ext: 'opus', label: 'OPUS — 160 kbps' },
        ],
        'Bezstratne': [
            { ext: 'flac', label: 'FLAC — bezstratna kompresja' },
            { ext: 'wav', label: 'WAV — 16-bit PCM' },
        ],
    },
    image: {
        'Grafika': [
            { ext: 'png', label: 'PNG — bezstratny' },
            { ext: 'jpg', label: 'JPG — jakość 92%' },
            { ext: 'webp', label: 'WEBP — jakość 90%' },
            { ext: 'avif', label: 'AVIF — mały plik' },
            { ext: 'tiff', label: 'TIFF — LZW' },
            { ext: 'bmp', label: 'BMP' },
        ],
        'Ikony i animacje': [
            { ext: 'ico', label: 'ICO — 16 do 256 px' },
            { ext: 'gif', label: 'GIF' },
        ],
    },
};

const QUALITY = {
    high:     { label: 'Wysoka jakość', crf: 18, cq: 20, qp: 20, vp9: 24, audio: '320k' },
    balanced: { label: 'Zbalansowana', crf: 23, cq: 25, qp: 25, vp9: 32, audio: '192k' },
    small:    { label: 'Mały plik', crf: 28, cq: 31, qp: 31, vp9: 40, audio: '128k' },
};

function categoryOf(file) {
    const ext = path.extname(file).slice(1).toLowerCase();
    if (VIDEO_IN.includes(ext)) return 'video';
    if (AUDIO_IN.includes(ext)) return 'audio';
    if (IMAGE_IN.includes(ext)) return 'image';
    return null;
}

// info (z probe) pozwala ukryć formaty, które nie mają sensu: dźwięk z filmu bez dźwięku itp.
function targetsFor(file, info) {
    let cat = categoryOf(file);
    if (!cat) return null;
    // Np. .mp4 albo .webm z samym dźwiękiem traktujemy jak plik audio
    if (cat === 'video' && info && !info.hasVideo && info.hasAudio) cat = 'audio';
    const ext = path.extname(file).slice(1).toLowerCase().replace('jpeg', 'jpg').replace(/^tif$/, 'tiff');
    const groups = {};
    for (const [group, list] of Object.entries(TARGETS[cat])) {
        if (cat === 'video' && group === 'Dźwięk z filmu' && info && !info.hasAudio) continue;
        const items = list.filter((t) => t.ext !== ext);
        if (items.length) groups[group] = items;
    }
    return { category: cat, groups };
}

// Plik wynikowy obok źródła: film_pitaya.mp4, film_pitaya (2).mp4…
function uniqueOutput(input, ext, outDir) {
    const dir = outDir || path.dirname(input);
    const base = path.basename(input, path.extname(input));
    let candidate = path.join(dir, `${base}_pitaya.${ext}`);
    for (let i = 2; fs.existsSync(candidate); i++) candidate = path.join(dir, `${base}_pitaya (${i}).${ext}`);
    return candidate;
}

// ───── ffmpeg ─────
function which(cmd) {
    const dirs = (process.env.PATH || '').split(path.delimiter);
    const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
    for (const d of dirs) for (const e of exts) {
        const p = path.join(d, cmd + e);
        try { if (fs.statSync(p).isFile()) return p; } catch {}
    }
    return null;
}

function run(bin, args, { signal, onStderr, onStdout, timeout } = {}) {
    return new Promise((resolve, reject) => {
        const proc = spawn(bin, args, { windowsHide: true });
        let stderr = '';
        let timer = null;
        const abort = () => proc.kill('SIGTERM');
        if (signal) {
            if (signal.aborted) abort();
            signal.addEventListener('abort', abort, { once: true });
        }
        if (timeout) timer = setTimeout(abort, timeout);
        proc.stdout.on('data', (d) => onStdout && onStdout(d.toString()));
        proc.stderr.on('data', (d) => {
            const t = d.toString();
            stderr = (stderr + t).slice(-8000);
            if (onStderr) onStderr(t);
        });
        proc.on('error', (err) => { clearTimeout(timer); reject(err); });
        proc.on('close', (code) => {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', abort);
            resolve({ code, stderr, aborted: Boolean(signal && signal.aborted) });
        });
    });
}

// Kandydaci na koder (kolejność = preferencja). Każdy testujemy krótkim kodowaniem.
const ENCODER_CANDIDATES = [
    { kind: 'nvenc', codec: 'h264', encoder: 'h264_nvenc', label: 'NVIDIA NVENC · H.264' },
    { kind: 'nvenc', codec: 'hevc', encoder: 'hevc_nvenc', label: 'NVIDIA NVENC · H.265' },
    { kind: 'nvenc', codec: 'av1',  encoder: 'av1_nvenc',  label: 'NVIDIA NVENC · AV1' },
    { kind: 'vaapi', codec: 'h264', encoder: 'h264_vaapi', label: 'VAAPI · H.264' },
    { kind: 'vaapi', codec: 'hevc', encoder: 'hevc_vaapi', label: 'VAAPI · H.265' },
    { kind: 'vaapi', codec: 'av1',  encoder: 'av1_vaapi',  label: 'VAAPI · AV1' },
    { kind: 'qsv',   codec: 'h264', encoder: 'h264_qsv',   label: 'Intel QSV · H.264' },
    { kind: 'qsv',   codec: 'hevc', encoder: 'hevc_qsv',   label: 'Intel QSV · H.265' },
    { kind: 'amf',   codec: 'h264', encoder: 'h264_amf',   label: 'AMD AMF · H.264' },
    { kind: 'amf',   codec: 'hevc', encoder: 'hevc_amf',   label: 'AMD AMF · H.265' },
    { kind: 'videotoolbox', codec: 'h264', encoder: 'h264_videotoolbox', label: 'Apple VideoToolbox · H.264' },
    { kind: 'videotoolbox', codec: 'hevc', encoder: 'hevc_videotoolbox', label: 'Apple VideoToolbox · H.265' },
    { kind: 'cpu',   codec: 'h264', encoder: 'libx264',    label: 'Procesor (CPU) · H.264' },
    { kind: 'cpu',   codec: 'hevc', encoder: 'libx265',    label: 'Procesor (CPU) · H.265' },
    { kind: 'cpu',   codec: 'av1',  encoder: 'libsvtav1',  label: 'Procesor (CPU) · AV1' },
];

function vaapiDevices() {
    if (process.platform !== 'linux') return [];
    try {
        return fs.readdirSync('/dev/dri').filter((n) => n.startsWith('renderD')).map((n) => `/dev/dri/${n}`);
    } catch { return []; }
}

function createEngine({ bundledFfmpeg, log = () => {} } = {}) {
    let detection = null;
    let detecting = null;   // trwające wykrywanie — kolejne wywołania czekają na ten sam wynik
    let sharp = null;
    const getSharp = () => (sharp = sharp || require('sharp'));

    function binaries() {
        const list = [];
        const sys = which('ffmpeg');
        if (sys) list.push({ path: sys, source: 'system' });
        if (bundledFfmpeg && fs.existsSync(bundledFfmpeg)) list.push({ path: bundledFfmpeg, source: 'bundled' });
        return list.map((b) => {
            let version = '';
            try { version = execFileSync(b.path, ['-hide_banner', '-version'], { timeout: 8000 }).toString().split('\n')[0]; } catch {}
            let encoders = '';
            try { encoders = execFileSync(b.path, ['-hide_banner', '-encoders'], { timeout: 8000 }).toString(); } catch {}
            return { ...b, version, encoders };
        }).filter((b) => b.version);
    }

    // Krótki test: 0,5 s obrazu testowego przez dany koder
    async function testEncoder(bin, cand, device) {
        const args = ['-hide_banner', '-loglevel', 'error'];
        if (cand.kind === 'vaapi') args.push('-vaapi_device', device);
        args.push('-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '0.5');
        if (cand.kind === 'vaapi') args.push('-vf', 'format=nv12,hwupload');
        else args.push('-pix_fmt', cand.kind === 'videotoolbox' ? 'nv12' : 'yuv420p');
        args.push('-c:v', cand.encoder, '-f', 'null', '-');
        try {
            const r = await run(bin, args, { timeout: 15000 });
            return r.code === 0;
        } catch { return false; }
    }

    function detect({ force = false } = {}) {
        if (detection && !force) return Promise.resolve(detection);
        if (!detecting) detecting = runDetect().finally(() => { detecting = null; });
        return detecting;
    }

    async function runDetect() {
        const bins = binaries();
        const encoders = [];
        for (const cand of ENCODER_CANDIDATES) {
            for (const b of bins) {
                if (!new RegExp(`\\s${cand.encoder}\\s`).test(b.encoders)) continue;
                const devices = cand.kind === 'vaapi' ? vaapiDevices() : [null];
                let found = null;
                for (const device of devices) {
                    if (await testEncoder(b.path, cand, device)) { found = { device }; break; }
                }
                if (found) {
                    encoders.push({ id: `${cand.kind}-${cand.codec}`, ...cand, ffmpeg: b.path, device: found.device });
                    break;
                }
            }
        }
        const generic = bins.find((b) => b.source === 'bundled') || bins[0] || null;
        const full = bins.find((b) => /\slibvpx-vp9\s/.test(b.encoders) && /\slibmp3lame\s/.test(b.encoders)) || generic;
        detection = {
            binaries: bins.map(({ path: p, source, version }) => ({ path: p, source, version })),
            encoders,
            ffmpeg: full ? full.path : null,
            best: (encoders.find((e) => e.kind !== 'cpu' && e.codec === 'h264') || encoders.find((e) => e.codec === 'h264') || encoders[0] || null),
        };
        log('Wykryte kodery:', encoders.map((e) => e.id).join(', ') || 'brak');
        return detection;
    }

    // ───── Analiza pliku ─────
    async function probe(file) {
        const cat = categoryOf(file);
        const size = fs.statSync(file).size;
        if (cat === 'image') {
            try {
                const meta = await getSharp()(file, { animated: true }).metadata();
                return { category: cat, size, width: meta.width, height: meta.pageHeight || meta.height, frames: meta.pages || 1, format: meta.format };
            } catch {}
        }
        const det = await detect();
        if (!det.ffmpeg) throw new Error('Nie znaleziono programu FFmpeg.');
        const { stderr } = await run(det.ffmpeg, ['-hide_banner', '-i', file]);
        if (/Invalid data found|No such file|could not find codec parameters/i.test(stderr) && !/Stream #/.test(stderr)) {
            throw new Error('Nie można odczytać pliku — może jest uszkodzony albo to nie jest plik multimedialny.');
        }
        const dur = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        const duration = dur ? (+dur[1]) * 3600 + (+dur[2]) * 60 + parseFloat(dur[3]) : 0;
        const v = stderr.match(/Stream #\d+:\d+[^:]*: Video: (\w+)[^\n]*?(\d{2,5})x(\d{2,5})/);
        const vLine = (stderr.match(/Stream #\d+:\d+[^:]*: Video:[^\n]*/) || [''])[0];
        const fps = parseFloat((vLine.match(/([\d.]+) fps/) || vLine.match(/([\d.]+) tbr/) || [])[1]) || 0;
        const a = stderr.match(/Stream #\d+:\d+[^:]*: Audio: (\w+)/);
        const isCover = /\(attached pic\)/.test(vLine) || /Video: (mjpeg|png)[^\n]*\(attached pic\)/.test(stderr);
        return {
            category: cat,
            size,
            duration,
            hasVideo: Boolean(v) && !isCover,
            hasAudio: Boolean(a),
            vcodec: v ? v[1] : null,
            acodec: a ? a[1] : null,
            width: v ? +v[2] : 0,
            height: v ? +v[3] : 0,
            fps,
            tenBit: /p10|10le|yuv420p10|p010/.test(vLine),
        };
    }

    // Czy da się przepisać strumienie bez kodowania (szybko i bez strat)
    function canCopy(info, ext) {
        const v = info.vcodec, a = info.acodec;
        const video = {
            mp4: ['h264', 'hevc', 'av1', 'vp9', 'mpeg4'], m4v: ['h264', 'hevc'], mov: ['h264', 'hevc', 'prores', 'mpeg4'],
            mkv: ['h264', 'hevc', 'av1', 'vp9', 'vp8', 'mpeg4', 'mpeg2video'], webm: ['vp9', 'vp8', 'av1'], avi: ['h264', 'mpeg4', 'mjpeg'],
        }[ext] || [];
        const audio = {
            mp4: ['aac', 'mp3', 'ac3', 'opus', 'alac'], m4v: ['aac'], mov: ['aac', 'mp3', 'alac', 'pcm_s16le'],
            mkv: null, webm: ['opus', 'vorbis'], avi: ['mp3', 'ac3', 'pcm_s16le'],
        }[ext];
        const videoOk = !info.hasVideo || video.includes(v);
        const audioOk = !info.hasAudio || audio === null || (audio || []).includes(a);
        return { video: videoOk, audio: audioOk };
    }

    function videoEncoderArgs(enc, quality, ext) {
        const q = QUALITY[quality] || QUALITY.balanced;
        if (ext === 'webm') {
            return { pre: [], vf: [], args: ['-c:v', 'libvpx-vp9', '-crf', String(q.vp9), '-b:v', '0', '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1'] };
        }
        switch (enc.kind) {
            case 'nvenc':
                return { pre: [], vf: [], args: ['-c:v', enc.encoder, '-preset', 'p5', '-rc', 'vbr', '-cq', String(q.cq), '-b:v', '0', ...(enc.codec === 'h264' ? ['-profile:v', 'high'] : [])], pix: 'yuv420p' };
            case 'vaapi':
                return { pre: ['-vaapi_device', enc.device], vf: ['format=nv12', 'hwupload'], args: ['-c:v', enc.encoder, '-rc_mode', 'CQP', '-qp', String(q.qp)] };
            case 'qsv':
                return { pre: [], vf: [], args: ['-c:v', enc.encoder, '-global_quality', String(q.cq), '-preset', 'medium'], pix: 'nv12' };
            case 'amf':
                return { pre: [], vf: [], args: ['-c:v', enc.encoder, '-rc', 'cqp', '-qp_i', String(q.qp), '-qp_p', String(q.qp), '-quality', 'balanced'], pix: 'yuv420p' };
            case 'videotoolbox':
                return { pre: [], vf: [], args: ['-c:v', enc.encoder, '-q:v', String(Math.round(100 - q.crf * 2))], pix: 'nv12' };
            default:
                if (enc.encoder === 'libx265') return { pre: [], vf: [], args: ['-c:v', 'libx265', '-crf', String(q.crf + 4), '-preset', 'medium', '-tag:v', 'hvc1'], pix: 'yuv420p' };
                if (enc.encoder === 'libsvtav1') return { pre: [], vf: [], args: ['-c:v', 'libsvtav1', '-crf', String(q.crf + 12), '-preset', '8'], pix: 'yuv420p' };
                return { pre: [], vf: [], args: ['-c:v', 'libx264', '-crf', String(q.crf), '-preset', 'veryfast', '-profile:v', 'high'], pix: 'yuv420p' };
        }
    }

    function audioArgs(ext, quality) {
        const q = QUALITY[quality] || QUALITY.balanced;
        switch (ext) {
            case 'mp3': return ['-c:a', 'libmp3lame', '-b:a', quality === 'small' ? '192k' : '320k', '-ar', '44100'];
            case 'wav': return ['-c:a', 'pcm_s16le'];
            case 'flac': return ['-c:a', 'flac', '-compression_level', '8'];
            case 'aac': case 'm4a': return ['-c:a', 'aac', '-b:a', quality === 'high' ? '256k' : q.audio];
            case 'ogg': return ['-c:a', 'libvorbis', '-q:a', quality === 'small' ? '4' : quality === 'high' ? '8' : '6'];
            case 'opus': case 'webm': return ['-c:a', 'libopus', '-b:a', quality === 'small' ? '96k' : '160k'];
            default: return ['-c:a', 'aac', '-b:a', q.audio];
        }
    }

    // Uruchomienie ffmpeg z paskiem postępu (format -progress)
    async function ffmpegJob(bin, args, { duration, output, signal, onProgress }) {
        const started = Date.now();
        let last = 0;
        let buf = '';
        const r = await run(bin, ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', ...args, output], {
            signal,
            onStdout: (text) => {
                buf += text;
                const blocks = buf.split('progress=');
                buf = blocks.pop();
                for (const block of blocks) {
                    const t = block.match(/out_time_(?:us|ms)=(\d+)/);
                    if (!t) continue;
                    const sec = +t[1] / 1e6;
                    const now = Date.now();
                    if (now - last < 200) continue;
                    last = now;
                    const elapsed = (now - started) / 1000;
                    const percent = duration > 0 ? Math.min(99, Math.round((sec / duration) * 100)) : 0;
                    const speed = elapsed > 0 ? sec / elapsed : 0;
                    const eta = speed > 0 && duration > 0 ? Math.max(0, (duration - sec) / speed) : 0;
                    let bytes = 0;
                    try { bytes = fs.statSync(output).size; } catch {}
                    if (onProgress) onProgress({ percent, seconds: sec, eta, speed, bytes });
                }
            },
        });
        return r;
    }

    function ffmpegError(stderr) {
        const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean)
            .filter((l) => /error|invalid|unknown|not found|failed|cannot|could not|unsupported|does not|no such/i.test(l));
        return (lines.slice(-3).join(' · ') || stderr.trim().split('\n').slice(-2).join(' ')).slice(0, 400);
    }

    // ───── Grafika ─────
    async function decodeToPng(file) {
        // sharp nie czyta BMP ani ICO — wtedy dekodujemy przez ffmpeg
        try {
            const meta = await getSharp()(file).metadata();
            if (meta && meta.format) return null;
        } catch {}
        const det = await detect();
        const tmp = path.join(os.tmpdir(), `pitaya-${process.pid}-${Date.now()}.png`);
        // Z ICO bierzemy największy obraz (ffmpeg wybiera domyślnie pierwszy strumień — szukamy najwięcej pikseli)
        const { stderr } = await run(det.ffmpeg, ['-hide_banner', '-i', file]);
        let best = 0, bestPx = 0;
        for (const m of stderr.matchAll(/Stream #0:(\d+)[^\n]*?(\d{1,5})x(\d{1,5})/g)) {
            const px = +m[2] * +m[3];
            if (px > bestPx) { bestPx = px; best = +m[1]; }
        }
        const r = await run(det.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-map', `0:${best}`, '-frames:v', '1', tmp]);
        if (r.code !== 0 || !fs.existsSync(tmp)) throw new Error(`Nie można odczytać obrazu: ${ffmpegError(r.stderr)}`);
        return tmp;
    }

    // Prawdziwy plik .ico z kilkoma rozmiarami (PNG w środku, obsługiwane od Windows Vista)
    async function writeIco(input, output, readOpts) {
        const sizes = [16, 24, 32, 48, 64, 128, 256];
        const images = [];
        for (const s of sizes) {
            images.push(await getSharp()(input, readOpts).resize(s, s, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer());
        }
        const header = Buffer.alloc(6 + 16 * images.length);
        header.writeUInt16LE(0, 0);
        header.writeUInt16LE(1, 2);
        header.writeUInt16LE(images.length, 4);
        let offset = header.length;
        images.forEach((img, i) => {
            const e = 6 + i * 16;
            header.writeUInt8(sizes[i] >= 256 ? 0 : sizes[i], e);
            header.writeUInt8(sizes[i] >= 256 ? 0 : sizes[i], e + 1);
            header.writeUInt8(0, e + 2);
            header.writeUInt8(0, e + 3);
            header.writeUInt16LE(1, e + 4);
            header.writeUInt16LE(32, e + 6);
            header.writeUInt32LE(img.length, e + 8);
            header.writeUInt32LE(offset, e + 12);
            offset += img.length;
        });
        fs.writeFileSync(output, Buffer.concat([header, ...images]));
    }

    async function convertImage({ input, ext, output, signal }) {
        const decoded = await decodeToPng(input);
        const src = decoded || input;
        try {
            const isSvg = /\.svg$/i.test(src);
            const readOpts = {};
            if (isSvg) {
                // SVG rysujemy tak, żeby dłuższy bok miał ok. 2048 px
                const m = await getSharp()(src).metadata();
                const longest = Math.max(m.width || 512, m.height || 512);
                readOpts.density = Math.min(2400, Math.max(72, Math.round((2048 / longest) * 72)));
            }
            const animatedOut = ['gif', 'webp'].includes(ext);
            if (animatedOut) readOpts.animated = true;
            if (signal && signal.aborted) throw new Error('Przerwano');
            if (ext === 'ico') return await writeIco(src, output, readOpts);
            if (ext === 'bmp') {
                // sharp nie zapisuje BMP — robimy PNG i zamieniamy przez ffmpeg
                const det = await detect();
                const tmp = `${output}.tmp.png`;
                await getSharp()(src, readOpts).flatten({ background: '#ffffff' }).png().toFile(tmp);
                const r = await run(det.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', tmp, '-pix_fmt', 'bgr24', output]);
                fs.rmSync(tmp, { force: true });
                if (r.code !== 0) throw new Error(ffmpegError(r.stderr));
                return;
            }
            let p = getSharp()(src, readOpts);
            switch (ext) {
                case 'png': p = p.png({ compressionLevel: 9 }); break;
                case 'jpg': p = p.flatten({ background: '#ffffff' }).jpeg({ quality: 92, mozjpeg: true }); break;
                case 'webp': p = p.webp({ quality: 90 }); break;
                case 'avif': p = p.avif({ quality: 60 }); break;
                case 'tiff': p = p.tiff({ compression: 'lzw' }); break;
                case 'gif': p = p.gif(); break;
                default: throw new Error(`Nieobsługiwany format grafiki: ${ext}`);
            }
            await p.toFile(output);
        } finally {
            if (decoded) fs.rmSync(decoded, { force: true });
        }
    }

    // ───── Główna funkcja ─────
    // job: { input, ext, quality: 'high'|'balanced'|'small'|'copy', encoder: 'auto'|<id>, outDir? }
    async function convert(job, { signal, onProgress = () => {}, onNotice = () => {} } = {}) {
        const input = job.input;
        if (!fs.existsSync(input)) throw new Error('Plik źródłowy nie istnieje.');
        const ext = job.ext.toLowerCase();
        const cat = categoryOf(input);
        if (!cat) throw new Error('Ten format pliku nie jest obsługiwany.');
        const output = uniqueOutput(input, ext, job.outDir);
        const quality = job.quality || 'balanced';
        const cleanup = () => { try { fs.rmSync(output, { force: true }); } catch {} };
        try {
            fs.accessSync(path.dirname(output), fs.constants.W_OK);
        } catch {
            throw new Error(`Brak uprawnień do zapisu w folderze ${path.dirname(output)}.`);
        }

        if (cat === 'image') {
            onProgress({ percent: 30 });
            try { await convertImage({ input, ext, output, signal }); } catch (err) { cleanup(); throw err; }
            onProgress({ percent: 100 });
            return { output, encoder: 'sharp' };
        }

        const det = await detect();
        const info = await probe(input);
        const duration = info.duration;
        const args = [];

        // Dźwięk (z pliku audio albo wyciągnięty z filmu)
        const audioTargets = ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus'];
        if (audioTargets.includes(ext)) {
            if (!info.hasAudio) throw new Error('Ten plik nie ma ścieżki dźwiękowej.');
            args.push('-i', input, '-map', '0:a:0', '-vn', '-map_metadata', '0', ...audioArgs(ext, quality));
            if (ext === 'm4a') args.push('-movflags', '+faststart');
            const r = await ffmpegJob(det.ffmpeg, args, { duration, output, signal, onProgress });
            if (r.aborted) { cleanup(); throw new Error('Przerwano'); }
            if (r.code !== 0) { cleanup(); throw new Error(ffmpegError(r.stderr)); }
            onProgress({ percent: 100 });
            return { output, encoder: ext };
        }

        if (!info.hasVideo) throw new Error('Ten plik nie zawiera obrazu wideo.');

        // GIF z filmu: paleta liczona z całego klipu daje dużo lepsze kolory
        if (ext === 'gif') {
            const width = quality === 'high' ? 800 : quality === 'small' ? 360 : 540;
            const fps = quality === 'small' ? 10 : 15;
            args.push('-i', input, '-vf',
                `fps=${fps},scale='min(${width},iw)':-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`,
                '-loop', '0');
            const r = await ffmpegJob(det.ffmpeg, args, { duration, output, signal, onProgress });
            if (r.aborted) { cleanup(); throw new Error('Przerwano'); }
            if (r.code !== 0) { cleanup(); throw new Error(ffmpegError(r.stderr)); }
            onProgress({ percent: 100 });
            return { output, encoder: 'gif' };
        }

        // Wideo → wideo
        const copy = canCopy(info, ext);
        if (quality === 'copy') {
            if (!copy.video) throw new Error(`Obrazu ${info.vcodec} nie da się zapisać w .${ext} bez ponownego kodowania — wybierz inną jakość.`);
            args.push('-i', input, '-map', '0:v:0', '-map', '0:a?', '-c:v', 'copy');
            args.push(...(copy.audio ? ['-c:a', 'copy'] : audioArgs(ext === 'webm' ? 'webm' : 'aac', 'high')));
            if (['mp4', 'mov', 'm4v'].includes(ext)) args.push('-movflags', '+faststart');
            args.push('-map_metadata', '0');
            const r = await ffmpegJob(det.ffmpeg, args, { duration, output, signal, onProgress });
            if (r.aborted) { cleanup(); throw new Error('Przerwano'); }
            if (r.code !== 0) { cleanup(); throw new Error(ffmpegError(r.stderr)); }
            onProgress({ percent: 100 });
            return { output, encoder: 'copy' };
        }

        // Wybór kodera: auto = najlepszy sprzętowy H.264; AVI zawsze H.264
        let enc = null;
        if (job.encoder && job.encoder !== 'auto') enc = det.encoders.find((e) => e.id === job.encoder) || null;
        if (enc && ext === 'avi' && enc.codec !== 'h264') enc = null;
        if (!enc) enc = det.best;
        const cpu = det.encoders.find((e) => e.id === 'cpu-h264');
        const attempts = [];
        if (ext === 'webm') attempts.push({ kind: 'cpu', id: 'cpu-vp9', label: 'Procesor (CPU) · VP9', ffmpeg: det.ffmpeg });
        else {
            if (enc) attempts.push(enc);
            if (cpu && (!enc || enc.id !== cpu.id)) attempts.push(cpu);
        }
        if (!attempts.length) throw new Error('Nie znaleziono żadnego działającego kodera wideo.');

        let lastErr = '';
        for (const [i, e] of attempts.entries()) {
            const vargs = videoEncoderArgs(e, quality, ext);
            const filters = [...vargs.vf];
            const a = [...vargs.pre, '-i', input, '-map', '0:v:0', '-map', '0:a?'];
            if (vargs.pix) a.push('-pix_fmt', vargs.pix);
            if (filters.length) a.push('-vf', filters.join(','));
            a.push(...vargs.args);
            if (info.hasAudio) {
                if (copy.audio && ext !== 'webm' && ext !== 'avi') a.push('-c:a', 'copy');
                else a.push(...audioArgs(ext === 'webm' ? 'webm' : ext === 'avi' ? 'mp3' : 'aac', quality));
            }
            if (['mp4', 'mov', 'm4v'].includes(ext)) a.push('-movflags', '+faststart');
            a.push('-map_metadata', '0');
            const r = await ffmpegJob(e.ffmpeg || det.ffmpeg, a, { duration, output, signal, onProgress });
            if (r.aborted) { cleanup(); throw new Error('Przerwano'); }
            if (r.code === 0) {
                onProgress({ percent: 100 });
                return { output, encoder: e.id, encoderLabel: e.label, fallback: i > 0 };
            }
            lastErr = ffmpegError(r.stderr);
            log(`Koder ${e.id} nie zadziałał:`, lastErr);
            cleanup();
            if (i < attempts.length - 1) onNotice(`${e.label} nie zadziałał — kontynuuję na procesorze.`);
        }
        throw new Error(lastErr || 'Konwersja nie powiodła się.');
    }

    return { detect, probe, convert, targetsFor, categoryOf, QUALITY, canCopy };
}

module.exports = { createEngine, targetsFor, categoryOf, uniqueOutput, QUALITY, TARGETS, VIDEO_IN, AUDIO_IN, IMAGE_IN };
