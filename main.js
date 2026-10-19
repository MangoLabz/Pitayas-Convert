const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  nativeImage,
  Tray,
  Menu,
  shell
} = require('electron');

const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const sharp = require('sharp');
const { createUpdater } = require('./updater');

const updater = createUpdater({ repo: 'MangoLabz/Pitayas-Convert', branch: 'main', appDir: __dirname });
let lastOutputPath = null;

let ffmpegPath = require('ffmpeg-static');

if (ffmpegPath) {
  ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
}

if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
  const localBin = path.join(
    __dirname,
    'bin',
    process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  );

  if (fs.existsSync(localBin)) {
    ffmpegPath = localBin;
  } else {
    ffmpegPath = 'ffmpeg';
  }
}

let mainWindow = null;
let tray = null;
let isQuitting = false;
let hasShownTrayNotification = false;
let showCloseDialog = true;

/*
 * | --------------------------------------------------------------------------
 * | CZAS I FORMATOWANIE
 * |--------------------------------------------------------------------------
 */

function parseTimeToSeconds(timeStr) {
  const parts = timeStr.trim().split(':');
  if (parts.length !== 3) return 0;
  return (
    parseFloat(parts[0]) * 3600 +
    parseFloat(parts[1]) * 60 +
    parseFloat(parts[2])
  );
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '--:--:--';
  seconds = Math.round(seconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  return [
    String(hours).padStart(2, '0'),
    String(minutes).padStart(2, '0'),
    String(secs).padStart(2, '0')
  ].join(':');
}

function formatSize(bytes) {
  if (!bytes || bytes <= 0) return '0 MB';
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed(0)} MB`;
}

function formatBitrate(bits) {
  if (bits >= 1000000) return `${(bits / 1000000).toFixed(2)} Mbps`;
  return `${Math.round(bits / 1000)} kbps`;
}

/*
 * | --------------------------------------------------------------------------
 * | ANALIZA FFmpeg
 * |--------------------------------------------------------------------------
 */

function probeMedia(inputPath) {
  return new Promise((resolve, reject) => {
    let output = '';
    const proc = spawn(ffmpegPath, ['-hide_banner', '-i', inputPath], { windowsHide: true });

    proc.stderr.on('data', data => {
      output += data.toString();
    });

    proc.on('error', reject);

    proc.on('close', () => {
      const durationMatch = output.match(/Duration:\s*(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/);
      if (!durationMatch) {
        reject(new Error('Nie udało się odczytać długości filmu.'));
        return;
      }

      const duration = parseTimeToSeconds(durationMatch[1]);
      if (!duration || duration <= 0) {
        reject(new Error('Nieprawidłowa długość filmu.'));
        return;
      }

      const videoMatch = output.match(/Stream #\d+:\d+(?:\([^)]*\))?: Video:\s*([^,\s]+).*?(\d{2,5})x(\d{2,5})/);
    let sourceCodec = '';
    let width = 1920;
    let height = 1080;

    if (videoMatch) {
      sourceCodec = videoMatch[1];
      width = parseInt(videoMatch[2], 10);
      height = parseInt(videoMatch[3], 10);
    }

    const fpsMatch = output.match(/(\d+(?:\.\d+)?)\s*(?:fps|tbr)/);
    const fps = fpsMatch ? parseFloat(fpsMatch[1]) : 30;
    const hasAudio = /Stream #\d+:\d+(?:\([^)]*\))?: Audio:/.test(output);

    resolve({
      duration,
      width,
      height,
      fps,
      hasAudio,
      sourceCodec
    });
    });
  });
}

async function calculateVideoPlan(inputPath, encoder, targetFormat) {
  const sourceBytes = fs.statSync(inputPath).size;
  const media = await probeMedia(inputPath);

  const sourceTotalBitrate = (sourceBytes * 8) / media.duration;
  const sourceAudioBitrate = media.hasAudio ? 128000 : 0;
  const sourceVideoBitrate = Math.max(sourceTotalBitrate - sourceAudioBitrate, 500000);

  let factor = targetFormat === 'webm' ? 0.50 : 0.68;
  let videoBitrate = sourceVideoBitrate * factor;
  let minimum;

  if (media.width >= 3840 || media.height >= 2160) {
    minimum = targetFormat === 'webm' ? 4500000 : 6000000;
  } else if (media.width >= 2560 || media.height >= 1440) {
    minimum = targetFormat === 'webm' ? 2800000 : 4000000;
  } else if (media.width >= 1920 || media.height >= 1080) {
    minimum = targetFormat === 'webm' ? 2200000 : 3000000;
  } else if (media.width >= 1280 || media.height >= 720) {
    minimum = targetFormat === 'webm' ? 1400000 : 2000000;
  } else {
    minimum = targetFormat === 'webm' ? 800000 : 1000000;
  }

  videoBitrate = Math.max(videoBitrate, minimum);
  videoBitrate = Math.min(videoBitrate, sourceVideoBitrate);
  videoBitrate = Math.round(videoBitrate / 1000) * 1000;

  const audioBitrate = media.hasAudio ? 128000 : 0;
  const totalBitrate = videoBitrate + audioBitrate;
  const estimatedBytes = (totalBitrate * media.duration) / 8;

  let speedFactor;
  if (targetFormat === 'webm') {
    speedFactor = 0.35;
  } else if (encoder === 'nvenc') {
    speedFactor = 3.5;
  } else if (encoder === 'qsv' || encoder === 'amf') {
    speedFactor = 2.4;
  } else if (encoder === 'mac') {
    speedFactor = 2.2;
  } else {
    speedFactor = 0.85;
  }

  if (media.width >= 3840 || media.height >= 2160) {
    speedFactor *= 0.55;
  } else if (media.width >= 2560 || media.height >= 1440) {
    speedFactor *= 0.75;
  } else if (media.width >= 1920 || media.height >= 1080) {
    speedFactor *= 0.90;
  }

  return {
    duration: media.duration,
    width: media.width,
    height: media.height,
    fps: media.fps,
    hasAudio: media.hasAudio,
    sourceCodec: media.sourceCodec,
    sourceBytes,
    sourceVideoBitrate,
    videoBitrate,
    audioBitrate,
    estimatedBytes,
    estimatedSeconds: media.duration / speedFactor,
    targetFormat
  };
}

/*
 * | --------------------------------------------------------------------------
 * | FUNKCJA CHOWANIA DO TRAYA / CAŁKOWITEGO ZAMYKANIA
 * |--------------------------------------------------------------------------
 */

function handleWindowCloseRequest() {
  if (!mainWindow) return;

  // Dialog tylko dla systemu Windows
  if (process.platform === 'win32' && showCloseDialog) {
    const result = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      buttons: ['Minimalizuj do zasobnika', 'Zamknij program całkowicie'],
      defaultId: 0,
        cancelId: 0,
        title: 'Pitaya Convert — Zamykanie',
        message: 'Co chcesz zrobić z aplikacją?',
        detail: 'Możesz pozostawić program działający w tle w zasobniku systemowym (obok zegara) lub całkowicie zakończyć jego działanie.',
                                             checkboxLabel: 'Nie pytaj ponownie (zawsze chowaj do zasobnika)',
                                             checkboxChecked: false,
                                             noLink: true
    });

    // Wybrano: Zamknij program całkowicie
    if (result === 1) {
      isQuitting = true;
      app.quit();
      return;
    }

    // Wybrano minimalizację i zaznaczono checkbox
    if (result === 0) {
      // Pobieramy stan checkboxa przez asynchroniczny lub ponowny odczyt jeśli chcemy
      // showMessageBoxSync zwraca index, więc sprawdzamy zapamiętanie:
    }
  }

  // Schowanie do traya
  mainWindow.hide();

  if (process.platform === 'win32' && tray && !hasShownTrayNotification) {
    tray.displayBalloon({
      title: 'Pitaya Convert',
      content: 'Aplikacja nadal działa w tle w zasobniku systemowym.',
      iconType: 'info'
    });
    hasShownTrayNotification = true;
  }
}

/*
 * | --------------------------------------------------------------------------
 * | OKNO APLIKACJI
 * |--------------------------------------------------------------------------
 */

async function createWindow() {
  let appIcon = null;
  const icoPath = path.join(__dirname, 'icon.ico');
  const pngPath = path.join(__dirname, 'icon.png');
  const svgPath = path.join(__dirname, 'icon.svg');

  if (process.platform !== 'win32' && fs.existsSync(pngPath)) {
    appIcon = nativeImage.createFromPath(pngPath);
  } else if (fs.existsSync(icoPath)) {
    appIcon = nativeImage.createFromPath(icoPath);
  } else if (fs.existsSync(svgPath)) {
    try {
      const pngBuffer = await sharp(svgPath).resize(256, 256).png().toBuffer();
      appIcon = nativeImage.createFromBuffer(pngBuffer);
    } catch (err) {
      console.error('Błąd generowania ikony:', err);
    }
  }

  mainWindow = new BrowserWindow({
    width: 620,
    height: 640,
    frame: false,
    resizable: false,
    title: 'Pitaya Convert',
    backgroundColor: '#121116',
    icon: appIcon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (appIcon) mainWindow.setIcon(appIcon);
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      handleWindowCloseRequest();
    }
  });

  if (!tray && appIcon) {
    tray = new Tray(appIcon);
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Otwórz Pitaya Convert',
        click: () => {
          mainWindow.show();
          mainWindow.focus();
        }
      },
      { type: 'separator' },
      {
        label: 'Zamknij aplikację całkowicie',
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ]);

    tray.setToolTip('Pitaya Convert');
    tray.setContextMenu(contextMenu);

    tray.on('click', () => {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    });

    tray.on('balloon-click', () => {
      mainWindow.show();
      mainWindow.focus();
    });
  }
}

// Tylko jedna instancja — ponowne uruchomienie pokazuje okno schowane w zasobniku
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

app.whenReady().then(async () => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.pitayas.convert');
  }
  await createWindow();
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window-close', () => {
  handleWindowCloseRequest();
});

ipcMain.on('app-quit', () => {
  isQuitting = true;
  app.quit();
});

ipcMain.handle('show-output', () => {
  if (lastOutputPath && fs.existsSync(lastOutputPath)) {
    shell.showItemInFolder(lastOutputPath);
    return true;
  }
  return false;
});

/*
 * | --------------------------------------------------------------------------
 * | AKTUALIZACJE GITHUB
 * |--------------------------------------------------------------------------
 */

ipcMain.handle('app-info', () => ({ name: 'Pitaya Convert', version: app.getVersion(), repoUrl: updater.repoUrl }));
ipcMain.handle('update-check', () => updater.check());
ipcMain.handle('update-apply', () => updater.apply());
ipcMain.on('update-restart', () => {
  isQuitting = true;
  updater.restart();
});
ipcMain.handle('open-external', (event, url) => {
  if (typeof url === 'string' && url.startsWith('https://github.com/')) shell.openExternal(url);
});

ipcMain.handle('select-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    title: 'Wybierz plik do konwersji'
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

/*
 * | --------------------------------------------------------------------------
 * | OBSŁUGA KONWERSJI I ANALIZY
 * |--------------------------------------------------------------------------
 */

ipcMain.on('start-conversion', async (event, data) => {
  const {
    inputPath,
    outputPath,
    sourceCategory,
    targetFormat,
    targetCategory,
    encoder,
    analyzeOnly
  } = data;

  if (analyzeOnly && sourceCategory === 'video' && targetCategory === 'video') {
    try {
      const plan = await calculateVideoPlan(inputPath, encoder, targetFormat);

      event.sender.send('conversion-progress', {
        type: 'analysis',
        duration: formatDuration(plan.duration),
                        durationSeconds: plan.duration,
                        sourceSize: formatSize(plan.sourceBytes),
                        estimatedSize: formatSize(plan.estimatedBytes),
                        estimatedSeconds: plan.estimatedSeconds,
                        estimatedTime: formatDuration(plan.estimatedSeconds),
                        bitrate: formatBitrate(plan.videoBitrate),
                        width: plan.width,
                        height: plan.height,
                        fps: plan.fps
      });
    } catch (err) {
      event.sender.send('conversion-error', `Błąd analizy pliku: ${err.message}`);
    }
    return;
  }

  if (!analyzeOnly) lastOutputPath = outputPath;

  if (sourceCategory === 'image' && targetCategory === 'image' && targetFormat !== 'gif') {
    try {
      let pipeline = sharp(inputPath, { density: 300 });

      if (targetFormat === 'png') {
        pipeline = pipeline.png({ compressionLevel: 9 });
      } else if (targetFormat === 'jpg' || targetFormat === 'jpeg') {
        pipeline = pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: 95 });
      } else if (targetFormat === 'webp') {
        pipeline = pipeline.webp({ quality: 95, lossless: false });
      } else if (targetFormat === 'tiff') {
        pipeline = pipeline.tiff({ compression: 'lzw' });
      } else if (targetFormat === 'ico') {
        pipeline = pipeline.resize(256, 256, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 }
        }).png();
      }

      await pipeline.toFile(outputPath);
      event.sender.send('conversion-done', true);
      return;
    } catch (err) {
      event.sender.send('conversion-error', `Błąd przetwarzania grafiki: ${err.message}`);
      return;
    }
  }

  let args = ['-y', '-hide_banner'];
  let totalDurationSec = 0;
  let errorLogs = [];
  const isVideoToVideo = sourceCategory === 'video' && targetCategory === 'video';

  let videoPlan = null;
  if (isVideoToVideo) {
    try {
      videoPlan = await calculateVideoPlan(inputPath, encoder, targetFormat);
      totalDurationSec = videoPlan.duration;
    } catch (err) {
      event.sender.send('conversion-error', `Błąd przygotowania konwersji: ${err.message}`);
      return;
    }
  }

  if (isVideoToVideo) {
    if (encoder === 'nvenc') {
      args.push('-hwaccel', 'cuda');
    } else if (encoder === 'amf' || encoder === 'qsv') {
      args.push('-hwaccel', 'auto');
    }
  }

  args.push('-i', inputPath);

  if (targetCategory === 'video') {
    const videoBitrate = videoPlan ? videoPlan.videoBitrate : 4500000;
    const audioBitrate = videoPlan ? videoPlan.audioBitrate : 128000;

    args.push('-map', '0:v:0');
    if (videoPlan && videoPlan.hasAudio) {
      args.push('-map', '0:a:0?');
    }

    if (targetFormat === 'webm') {
      args.push(
        '-c:v', 'libvpx-vp9',
        '-b:v', `${videoBitrate}`,
        '-deadline', 'good',
        '-cpu-used', '2',
        '-row-mt', '1'
      );
    } else if (encoder === 'nvenc') {
      args.push(
        '-c:v', 'h264_nvenc',
        '-preset', 'p4',
        '-rc', 'vbr',
        '-b:v', `${videoBitrate}`,
        '-maxrate', `${Math.round(videoBitrate * 1.15)}`,
                '-bufsize', `${Math.round(videoBitrate * 2)}`,
                '-profile:v', 'high'
      );
    } else if (encoder === 'amf') {
      args.push(
        '-c:v', 'h264_amf',
        '-quality', 'balanced',
        '-rc', 'vbr_peak',
        '-b:v', `${videoBitrate}`,
        '-maxrate', `${Math.round(videoBitrate * 1.15)}`,
                '-bufsize', `${Math.round(videoBitrate * 2)}`
      );
    } else if (encoder === 'qsv') {
      args.push(
        '-c:v', 'h264_qsv',
        '-b:v', `${videoBitrate}`,
        '-maxrate', `${Math.round(videoBitrate * 1.15)}`,
                '-bufsize', `${Math.round(videoBitrate * 2)}`
      );
    } else if (encoder === 'mac') {
      args.push('-c:v', 'h264_videotoolbox', '-b:v', `${videoBitrate}`);
    } else {
      args.push(
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-b:v', `${videoBitrate}`,
        '-maxrate', `${Math.round(videoBitrate * 1.15)}`,
                '-bufsize', `${Math.round(videoBitrate * 2)}`,
                '-profile:v', 'high'
      );
    }

    args.push('-pix_fmt', 'yuv420p');

    if (videoPlan && videoPlan.hasAudio) {
      if (targetFormat === 'webm') {
        args.push('-c:a', 'libopus', '-b:a', '128k');
      } else {
        args.push('-c:a', 'aac', '-b:a', `${audioBitrate}`, '-ar', '48000');
      }
    }
  } else if (targetCategory === 'audio') {
    args.push('-map', '0:a:0');

    if (targetFormat === 'mp3') {
      args.push(
        '-c:a', 'libmp3lame',
        '-b:a', '320k',
        '-minrate', '320k',
        '-maxrate', '320k',
        '-bufsize', '640k',
        '-ar', '44100'
      );
    } else if (targetFormat === 'wav') {
      args.push('-c:a', 'pcm_s16le', '-ar', '44100');
    } else if (targetFormat === 'flac') {
      args.push('-c:a', 'flac', '-compression_level', '8');
    } else if (targetFormat === 'aac' || targetFormat === 'm4a') {
      args.push('-c:a', 'aac', '-b:a', '320k', '-ar', '48000');
    } else if (targetFormat === 'ogg') {
      args.push('-c:a', 'libvorbis', '-b:a', '320k');
    }
  } else if (targetFormat === 'gif') {
    args.push('-vf', 'fps=15,scale=540:-1:flags=lanczos');
  }

  if (targetCategory === 'video') {
    args.push('-map_metadata', '0');
    if (targetFormat === 'mp4') {
      args.push('-movflags', '+faststart');
    }
  }

  args.push(outputPath);

  let proc;
  try {
    proc = spawn(ffmpegPath, args, { windowsHide: true });
  } catch (err) {
    event.sender.send('conversion-error', `Nie można uruchomić FFmpeg: ${err.message}`);
    return;
  }

  const conversionStart = Date.now();
  let lastProgressTime = 0;

  proc.stderr.on('data', (data) => {
    const text = data.toString();
    errorLogs.push(text);
    if (errorLogs.length > 20) errorLogs.shift();

    if (!totalDurationSec) {
      const durMatch = text.match(/Duration:\s*(\d{2}:\d{2}:\d{2}\.\d+)/);
      if (durMatch) totalDurationSec = parseTimeToSeconds(durMatch[1]);
    }

    const timeMatch = text.match(/time=(\d{2}:\d{2}:\d{2}\.\d+)/);
    if (timeMatch) {
      const currentTimeSec = parseTimeToSeconds(timeMatch[1]);
      let percent = 0;
      if (totalDurationSec > 0) {
        percent = Math.min(Math.round((currentTimeSec / totalDurationSec) * 100), 99);
      }

      let currentMb = 0;
      try {
        if (fs.existsSync(outputPath)) {
          const stats = fs.statSync(outputPath);
          currentMb = (stats.size / 1024 / 1024).toFixed(1);
        }
      } catch (e) {}

      const elapsedSeconds = (Date.now() - conversionStart) / 1000;
      let etaSeconds = 0;
      if (currentTimeSec > 3 && elapsedSeconds > 2) {
        const realSpeed = currentTimeSec / elapsedSeconds;
        const remainingMedia = Math.max(totalDurationSec - currentTimeSec, 0);
        etaSeconds = remainingMedia / realSpeed;
      }

      const now = Date.now();
      if (now - lastProgressTime > 250) {
        lastProgressTime = now;
        event.sender.send('conversion-progress', {
          type: 'conversion',
          percent,
          currentMb,
          time: timeMatch[1],
          etaSeconds,
          eta: formatDuration(etaSeconds)
        });
      }
    }
  });

  proc.on('close', (code) => {
    if (code === 0) {
      event.sender.send('conversion-done', true);
    } else {
      const lastError = errorLogs.join(' ').replace(/\s+/g, ' ').slice(-1000);
      event.sender.send('conversion-error', `Błąd FFmpeg (kod ${code}): ${lastError}`);
    }
  });

  proc.on('error', (err) => {
    event.sender.send('conversion-error', `Błąd procesu: ${err.message}`);
  });
});
