const CONVERSION_GRAPH = {
  video: {
    formats: ["mp4", "mkv", "avi", "mov", "webm", "flv", "ts", "m4v"],
      targets: {
        "Formaty Wideo": [
          { ext: "mp4", label: "MP4 — H.264 (zoptymalizowany rozmiar)" },
          { ext: "mkv", label: "MKV — H.264 (zoptymalizowany rozmiar)" },
          { ext: "mov", label: "MOV — H.264 (zoptymalizowany rozmiar)" },
          { ext: "webm", label: "WEBM — zoptymalizowane (VP9)" },
          { ext: "avi", label: "AVI — H.264" }
        ],
        "Ekstrakcja Audio z Wideo": [
          { ext: "flac", label: "FLAC — 100% bezstratny" },
          { ext: "wav", label: "WAV — 16-bit PCM" },
          { ext: "mp3", label: "MP3 — 320 kbps" },
          { ext: "aac", label: "AAC — 320 kbps" },
          { ext: "ogg", label: "OGG — Vorbis" }
        ],
        "Animacje": [
          { ext: "gif", label: "GIF — 15 FPS" }
        ]
      }
  },
  audio: {
    formats: ["mp3", "wav", "flac", "aac", "ogg", "m4a", "wma", "aiff"],
      targets: {
        "Bezstratne": [
          { ext: "flac", label: "FLAC — Bezstratna kompresja" },
          { ext: "wav", label: "WAV — 16-bit PCM" }
        ],
        "Stratne": [
          { ext: "mp3", label: "MP3 — 320 kbps" },
          { ext: "aac", label: "AAC — 320 kbps" },
          { ext: "ogg", label: "OGG Vorbis" }
        ]
      }
  },
  image: {
    formats: ["png", "jpg", "jpeg", "webp", "bmp", "tiff", "svg", "ico", "gif"],
      targets: {
        "Bezstratne": [
          { ext: "png", label: "PNG — Bezstratny" },
          { ext: "tiff", label: "TIFF — LZW" }
        ],
        "Web i Fotografia": [
          { ext: "webp", label: "WEBP — Jakość 95%" },
          { ext: "jpg", label: "JPG — Jakość 95%" }
        ],
        "Ikony": [
          { ext: "ico", label: "ICO — 256x256" }
        ],
        "Animacje": [
          { ext: "gif", label: "GIF — 256 kolorów" }
        ]
      }
  }
};

let currentFilePath = null;
let currentSourceCategory = null;
let analysisTimer = null;

const dropZone = document.getElementById("drop-zone");
const fileNameEl = document.getElementById("file-name");
const targetFormatSelect = document.getElementById("target-format");
const gpuGroup = document.getElementById("gpu-group");
const encoderSelect = document.getElementById("encoder-select");
const convertBtn = document.getElementById("convert-btn");
const statusBox = document.getElementById("status");
const progressContainer = document.getElementById("progress-container");
const progressBar = document.getElementById("progress-bar");
const sourceChip = document.getElementById("sourceChip");
const resultRow = document.getElementById("show-output-btn");

function setStatus(text, tone) {
  statusBox.innerText = text;
  statusBox.className = `status-box${tone ? ` t-${tone}` : ""}`;
}

async function pickFile() {
  if (dropZone.style.pointerEvents === "none") return;
  const filePath = await window.api.selectFile();
  if (filePath) handleFile(filePath);
}

async function showOutput() {
  const ok = await window.api.showOutput();
  if (!ok) PitayaUI.showToast("Brak przekonwertowanego pliku do pokazania.", "info");
}

dropZone.addEventListener("click", pickFile);
resultRow.addEventListener("click", showOutput);

document.addEventListener("keydown", (e) => {
  if (!e.ctrlKey) return;
  const key = e.key.toLowerCase();
  if (key === "o") { e.preventDefault(); pickFile(); }
  if (key === "q") { e.preventDefault(); window.api.quit(); }
});

dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("active");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("active");
});

dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("active");
  if (e.dataTransfer.files.length > 0) {
    handleFile(window.api.getPathForFile(e.dataTransfer.files[0]));
  }
});

function handleFile(filePath) {
  currentFilePath = filePath;
  const fileName = filePath.split(/[/\\]/).pop();
  fileNameEl.innerText = fileName;

  const ext = fileName.split(".").pop().toLowerCase();
  currentSourceCategory = null;
  resultRow.classList.remove("show");
  sourceChip.innerText = `.${ext}`;

  for (const [category, data] of Object.entries(CONVERSION_GRAPH)) {
    if (data.formats.includes(ext)) {
      currentSourceCategory = category;
      break;
    }
  }

  targetFormatSelect.innerHTML = "";

  if (currentSourceCategory) {
    const targets = CONVERSION_GRAPH[currentSourceCategory].targets;

    for (const [groupName, formatList] of Object.entries(targets)) {
      const optGroup = document.createElement("optgroup");
      optGroup.label = groupName;

      formatList.forEach((item) => {
        if (item.ext !== ext) {
          const option = document.createElement("option");
          option.value = item.ext;
          option.innerText = item.label;
          optGroup.appendChild(option);
        }
      });

      if (optGroup.children.length) {
        targetFormatSelect.appendChild(optGroup);
      }
    }

    targetFormatSelect.disabled = false;
    updateGpuVisibility();

    if (currentSourceCategory === "video") {
      convertBtn.disabled = true;
      setStatus(`Wykryto .${ext.toUpperCase()} — analizowanie parametrów...`, "warn");
      startAnalysis();
    } else {
      convertBtn.disabled = false;
      setStatus(`Gotowy do konwersji pliku .${ext.toUpperCase()}`, "ok");
    }
  } else {
    targetFormatSelect.disabled = true;
    convertBtn.disabled = true;
    gpuGroup.style.display = "none";
    setStatus("Format pliku nie jest obsługiwany.", "err");
  }
}

targetFormatSelect.addEventListener("change", () => {
  updateGpuVisibility();
  resetAnalysis();
  startAnalysis();
});

encoderSelect.addEventListener("change", () => {
  resetAnalysis();
  startAnalysis();
});

function updateGpuVisibility() {
  const target = targetFormatSelect.value;
  const isVideo = CONVERSION_GRAPH.video.formats.includes(target);

  if (currentSourceCategory === "video" && isVideo) {
    gpuGroup.style.display = "block";
  } else {
    gpuGroup.style.display = "none";
  }
}

function resetAnalysis() {
  if (analysisTimer) {
    clearTimeout(analysisTimer);
    analysisTimer = null;
  }
  if (progressContainer) progressContainer.style.display = "none";
  progressBar.style.width = "0%";
}

function startAnalysis() {
  if (!currentFilePath) return;

  const targetFormat = targetFormatSelect.value;
  const isVideo = CONVERSION_GRAPH.video.formats.includes(targetFormat);

  if (currentSourceCategory !== "video" || !isVideo) return;

  const encoder = encoderSelect.value;

  analysisTimer = setTimeout(() => {
    setStatus("Analizowanie filmu...", "warn");
    convertBtn.disabled = true;

    window.api.startConversion({
      inputPath: currentFilePath,
      outputPath: "",
      sourceCategory: "video",
      targetFormat,
      targetCategory: "video",
      encoder,
      analyzeOnly: true
    });
  }, 150);
}

window.api.onProgress((data) => {
  if (data.type === "analysis") {
    convertBtn.disabled = false;
    progressContainer.style.display = "none";
    setStatus(`${data.width}×${data.height} ${Math.round(data.fps || 30)} FPS | Rozmiar: ~${data.estimatedSize} | Czas: ~${data.estimatedTime} | Bitrate: ${data.bitrate}`, "ok");
    return;
  }

  const percent = data.percent || 0;
  const currentMb = data.currentMb || 0;
  const eta = data.eta || "--:--:--";

  progressContainer.style.display = "block";
  progressBar.style.width = `${percent}%`;
  setStatus(`Konwertowanie: ${currentMb} MB | ${percent}% | Pozostało ~${eta}`, "warn");
});

convertBtn.addEventListener("click", () => {
  if (!currentFilePath) return;

  const targetFormat = targetFormatSelect.value;
  const encoder = encoderSelect.value;

  let targetCategory = "video";
  if (CONVERSION_GRAPH.audio.formats.includes(targetFormat)) targetCategory = "audio";
  if (["png", "jpg", "jpeg", "webp", "bmp", "tiff", "ico", "gif"].includes(targetFormat)) {
    targetCategory = "image";
  }

  const lastDot = currentFilePath.lastIndexOf(".");
  const basePath = lastDot !== -1 ? currentFilePath.substring(0, lastDot) : currentFilePath;
  const outputPath = `${basePath}_pitaya.${targetFormat}`;

  toggleControls(false);
  resultRow.classList.remove("show");
  progressContainer.style.display = "block";
  progressBar.style.width = "0%";
  setStatus("Rozpoczynanie konwersji...", "warn");

  window.api.startConversion({
    inputPath: currentFilePath,
    outputPath,
    sourceCategory: currentSourceCategory,
    targetFormat,
    targetCategory,
    encoder,
    analyzeOnly: false
  });
});

window.api.onDone((success) => {
  toggleControls(true);
  progressBar.style.width = "100%";
  setTimeout(() => {
    progressContainer.style.display = "none";
  }, 1200);

  if (success) {
    setStatus("Konwersja ukończona pomyślnie! ✨", "ok");
    resultRow.classList.add("show");
    PitayaUI.showToast("Konwersja ukończona!", "success");
  } else {
    setStatus("Wystąpił błąd podczas konwersji.", "err");
  }
});

window.api.onError((err) => {
  toggleControls(true);
  progressContainer.style.display = "none";
  setStatus(err, "err");
});

function toggleControls(enable) {
  convertBtn.disabled = !enable;
  targetFormatSelect.disabled = !enable;
  encoderSelect.disabled = !enable;
  dropZone.style.pointerEvents = enable ? "auto" : "none";
}

updateGpuVisibility();
