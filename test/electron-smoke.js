// Szybki test silnika w procesie Electrona (tam działa aplikacja). Sharp 0.33 zawieszał się
// pod Electronem, choć w czystym Node działał — ten test łapie takie różnice.
//   npx electron --no-sandbox test/electron-smoke.js <folder z próbkami>
const { app } = require('electron');
const path = require('path');
const { createEngine } = require('../engine');

const samples = path.resolve(process.argv[process.argv.length - 1]);
const CASES = [['i.png', 'jpg'], ['i.png', 'ico'], ['i.bmp', 'png'], ['i.svg', 'webp'], ['i_anim.gif', 'webp'], ['a.flac', 'mp3'], ['v_h264.mp4', 'mkv'], ['v_h264.mp4', 'gif']];

app.whenReady().then(async () => {
    const engine = createEngine({ bundledFfmpeg: require('ffmpeg-static') });
    let failed = 0;
    for (const [file, ext] of CASES) {
        const started = Date.now();
        const watchdog = setTimeout(() => { console.log(`✖ ${file} → ${ext}: zawieszenie`); app.exit(1); }, 30000);
        try {
            const res = await engine.convert({ input: path.join(samples, file), ext });
            console.log(`✔ ${file} → ${ext} (${Date.now() - started} ms, ${res.encoder})`);
        } catch (err) {
            failed++;
            console.log(`✖ ${file} → ${ext}: ${err.message}`);
        }
        clearTimeout(watchdog);
    }
    app.exit(failed ? 1 : 0);
});
