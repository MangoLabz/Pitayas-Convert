#!/usr/bin/env node
// Test silnika konwersji: każdy plik z folderu próbek → każdy format docelowy.
//   node test/run-tests.js <folder z próbkami> [folder wyników] [--quick]
// Próbki tworzy test/make-samples.sh. Kod wyjścia 1, gdy coś nie przeszło.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { createEngine, targetsFor } = require('../engine');

const [samplesDir, outArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const quick = process.argv.includes('--quick');
if (!samplesDir) { console.error('Podaj folder z próbkami'); process.exit(2); }
const outDir = path.resolve(outArg || path.join(samplesDir, '..', 'out'));
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const engine = createEngine({ bundledFfmpeg: require('ffmpeg-static') });

function streams(file, ffmpeg) {
    try { execFileSync(ffmpeg, ['-hide_banner', '-i', file], { stdio: 'pipe' }); } catch (e) { return e.stderr.toString(); }
    return '';
}

async function verify(output, ext, det) {
    const stat = fs.statSync(output);
    if (!stat.size) return 'pusty plik';
    const head = fs.readFileSync(output).subarray(0, 8);
    if (ext === 'ico') {
        if (head.readUInt16LE(0) !== 0 || head.readUInt16LE(2) !== 1) return 'zły nagłówek ICO';
        return head.readUInt16LE(4) >= 1 ? null : 'ICO bez obrazów';
    }
    if (ext === 'bmp') return head.toString('latin1', 0, 2) === 'BM' ? null : 'zły nagłówek BMP';
    if (['png', 'jpg', 'webp', 'avif', 'tiff', 'gif'].includes(ext) && !(await isVideoGif(output, ext))) {
        try { await require('sharp')(output).metadata(); return null; } catch (e) { return `sharp: ${e.message}`; }
    }
    const info = streams(output, det.ffmpeg);
    const audio = ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus'].includes(ext);
    if (audio && !/Audio:/.test(info)) return 'brak dźwięku w wyniku';
    if (!audio && !/Video:/.test(info)) return 'brak obrazu w wyniku';
    return null;
}
async function isVideoGif() { return false; }

(async () => {
    const det = await engine.detect();
    console.log('ffmpeg:', det.ffmpeg);
    console.log('kodery:', det.encoders.map((e) => `${e.id}${e.device ? `@${e.device}` : ''}`).join(', '));
    console.log('domyślny:', det.best && det.best.id, '\n');

    const results = [];
    const files = fs.readdirSync(samplesDir).sort().map((f) => path.join(samplesDir, f));
    for (const input of files) {
        let info = null;
        try { if (!/\.(png|jpe?g|webp|bmp|tiff?|svg|ico|gif|avif)$/i.test(input)) info = await engine.probe(input); } catch {}
        const t = targetsFor(input, info);
        if (!t) continue;
        let exts = Object.values(t.groups).flat().map((x) => x.ext);
        if (quick) exts = exts.slice(0, 2);
        for (const ext of exts) {
            const started = Date.now();
            let status, detail = '';
            try {
                const res = await engine.convert({ input, ext, quality: 'balanced', encoder: 'auto', outDir });
                const problem = await verify(res.output, ext, det);
                status = problem ? 'ZŁY WYNIK' : 'ok';
                detail = problem || res.encoder + (res.fallback ? ' (zapasowy)' : '');
            } catch (err) {
                status = 'BŁĄD';
                detail = err.message;
            }
            const sec = ((Date.now() - started) / 1000).toFixed(1);
            results.push({ input: path.basename(input), ext, status, detail, sec });
            console.log(`${status === 'ok' ? '✔' : '✖'} ${path.basename(input).padEnd(16)} → ${ext.padEnd(5)} ${sec.padStart(5)}s  ${detail}`);
        }
    }

    // Dodatkowe przypadki: każdy wykryty koder, kopiowanie bez kodowania, przerwanie
    const mp4 = files.find((f) => /h264\.mp4$/.test(f));
    if (mp4 && !quick) {
        for (const e of det.encoders) {
            for (const ext of ['mp4', 'mkv']) {
                let status = 'ok', detail = e.id;
                try {
                    const res = await engine.convert({ input: mp4, ext, quality: 'high', encoder: e.id, outDir });
                    const problem = await verify(res.output, ext, det);
                    if (problem) { status = 'ZŁY WYNIK'; detail = problem; }
                    else if (res.encoder !== e.id) { status = 'ZAPASOWY'; detail = `${e.id} → ${res.encoder}`; }
                } catch (err) { status = 'BŁĄD'; detail = `${e.id}: ${err.message}`; }
                results.push({ input: `koder ${e.id}`, ext, status, detail });
                console.log(`${status === 'ok' ? '✔' : '✖'} koder ${e.id.padEnd(10)} → ${ext}  ${detail}`);
            }
        }
        for (const [src, ext, expectOk] of [['h264.mp4', 'mkv', true], ['h264.mp4', 'mov', true], ['vp9.webm', 'mkv', true], ['vp9.webm', 'mp4', true], ['hevc10.mkv', 'avi', false]]) {
            const input = files.find((f) => f.endsWith(src));
            let ok;
            let detail = '';
            try { await engine.convert({ input, ext, quality: 'copy', outDir }); ok = true; } catch (err) { ok = false; detail = err.message; }
            const status = ok === expectOk ? 'ok' : 'BŁĄD';
            results.push({ input: `kopiuj ${src}`, ext, status, detail });
            console.log(`${status === 'ok' ? '✔' : '✖'} kopiuj ${src} → ${ext}  ${ok ? 'skopiowano' : 'odmowa (' + detail + ')'}`);
        }
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 300);
        let aborted = false;
        try { await engine.convert({ input: mp4, ext: 'webm', quality: 'high', outDir }, { signal: ctrl.signal }); } catch (err) { aborted = /Przerwano/.test(err.message); }
        const leftovers = fs.readdirSync(outDir).filter((f) => f.endsWith('.webm') && f.startsWith('v_h264_pitaya'));
        const status = aborted ? 'ok' : 'BŁĄD';
        results.push({ input: 'przerwanie', ext: 'webm', status });
        console.log(`${status === 'ok' ? '✔' : '✖'} przerwanie konwersji (pliki webm w wynikach: ${leftovers.length})`);
    }

    const bad = results.filter((r) => r.status !== 'ok');
    console.log(`\n${results.length - bad.length}/${results.length} przeszło`);
    for (const r of bad) console.log(`  ✖ ${r.input} → ${r.ext}: ${r.status} ${r.detail}`);
    process.exit(bad.length ? 1 : 0);
})();
