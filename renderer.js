// Okno Pitaya Convert. Całą konwersję robi engine.js w procesie głównym;
// tutaj tylko wybór pliku, opcji i pokazywanie postępu.
const $ = (id) => document.getElementById(id);
const dropZone = $("drop-zone");
const fileNameEl = $("file-name");
const fileInfoEl = $("file-info");
const targetSelect = $("target-format");
const qualitySelect = $("quality-select");
const encoderSelect = $("encoder-select");
const qualityGroup = $("quality-group");
const gpuGroup = $("gpu-group");
const optionsRow = $("options-row");
const convertBtn = $("convert-btn");
const cancelBtn = $("cancel-btn");
const statusBox = $("status");
const progressContainer = $("progress-container");
const progressBar = $("progress-bar");
const sourceChip = $("sourceChip");
const showOutputBtn = $("show-output-btn");
const panel = dropZone.closest(".m-panel");

const VIDEO_TARGETS = ["mp4", "mkv", "mov", "webm", "avi"];
const AUDIO_TARGETS = ["mp3", "m4a", "aac", "flac", "wav", "ogg", "opus"];
const LOSSLESS = ["flac", "wav", "png", "tiff", "bmp", "ico"];

let current = null;        // { path, info, targets, copyable }
let detection = null;
let busy = false;
let lastProbe = 0;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function setStatus(text, tone) {
  statusBox.innerText = text;
  statusBox.className = `status-box${tone ? ` t-${tone}` : ""}`;
}

function fmtTime(sec) {
  if (!sec || !isFinite(sec)) return "--:--";
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(s).padStart(2, "0")}`;
}
function fmtSize(b) {
  if (!b) return "0 KB";
  if (b >= 1073741824) return `${(b / 1073741824).toFixed(2)} GB`;
  if (b >= 1048576) return `${(b / 1048576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(b / 1024))} KB`;
}
const CODECS = { h264: "H.264", hevc: "H.265", av1: "AV1", vp9: "VP9", vp8: "VP8", mpeg4: "MPEG-4", mpeg2video: "MPEG-2", aac: "AAC", mp3: "MP3", opus: "Opus", vorbis: "Vorbis", flac: "FLAC", ac3: "AC-3" };
const codecName = (c) => CODECS[c] || (c ? c.toUpperCase().replace(/^PCM_.*/, "PCM") : "");

// ───── Ustawienia i kodery ─────
async function loadEncoders(force) {
  $("encoderStatus").textContent = "Wykrywanie…";
  detection = await window.api.detect(force);
  const settings = await window.pitayaBridge.getSettings();
  const best = detection.encoders.find((e) => e.id === detection.best);
  encoderSelect.innerHTML = `<option value="auto">Automatycznie — ${esc(best ? best.label : "procesor")}</option>` +
    detection.encoders.map((e) => `<option value="${esc(e.id)}">${esc(e.label)}</option>`).join("");
  encoderSelect.value = detection.encoders.some((e) => e.id === settings.encoder) ? settings.encoder : "auto";
  if (settings.quality) qualitySelect.value = settings.quality;

  const hw = detection.encoders.filter((e) => e.kind !== "cpu");
  $("encoderStatus").textContent = hw.length
    ? `Akceleracja sprzętowa: ${[...new Set(hw.map((e) => e.label.split(" · ")[0]))].join(", ")}`
    : "Brak akceleracji sprzętowej — kodowanie na procesorze";
  $("encoderList").innerHTML = detection.encoders.map((e) =>
    `<span class="enc-item${e.id === detection.best ? " best" : ""}" title="${e.id === detection.best ? "domyślny" : ""}">${esc(e.label)}</span>`).join("") +
    detection.ffmpeg.map((b) => `<div class="m-small">${b.source === "system" ? "FFmpeg systemowy" : "FFmpeg wbudowany"}: ${esc(b.version.replace(/^ffmpeg version /, "").split(" ")[0])}</div>`).join("");
}
$("btnRedetect").addEventListener("click", () => loadEncoders(true));

// ───── Wybór pliku ─────
async function pickFile() {
  if (busy) return;
  const filePath = await window.api.selectFile();
  if (filePath) handleFile(filePath);
}
dropZone.addEventListener("click", pickFile);
dropZone.addEventListener("dragover", (e) => { e.preventDefault(); if (!busy) dropZone.classList.add("active"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("active"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("active");
  if (!busy && e.dataTransfer.files.length) handleFile(window.api.getPathForFile(e.dataTransfer.files[0]));
});
document.addEventListener("keydown", (e) => {
  if (!e.ctrlKey) return;
  const key = e.key.toLowerCase();
  if (key === "o") { e.preventDefault(); pickFile(); }
  if (key === "q") { e.preventDefault(); window.api.quit(); }
});
showOutputBtn.addEventListener("click", async () => {
  if (!(await window.api.showOutput())) PitayaUI.showToast("Brak przekonwertowanego pliku do pokazania.", "info");
});

async function handleFile(filePath) {
  const probeId = ++lastProbe;
  const fileName = filePath.split(/[/\\]/).pop();
  const ext = fileName.includes(".") ? fileName.split(".").pop().toLowerCase() : "";
  fileNameEl.innerText = fileName;
  sourceChip.innerText = ext ? `.${ext}` : "plik";
  showOutputBtn.classList.remove("show");
  fileInfoEl.classList.remove("show");
  targetSelect.disabled = true;
  convertBtn.disabled = true;
  setStatus("Analizowanie pliku…", "warn");

  const res = await window.api.probe(filePath);
  if (probeId !== lastProbe) return;   // w międzyczasie wybrano inny plik
  if (!res.ok) {
    current = null;
    targetSelect.innerHTML = `<option value="">—</option>`;
    updateOptions();
    setStatus(res.error, "err");
    return;
  }
  current = { path: filePath, ...res };
  renderInfo(res.info, res.targets.category);

  targetSelect.innerHTML = Object.entries(res.targets.groups).map(([group, list]) =>
    `<optgroup label="${esc(group)}">${list.map((t) => `<option value="${t.ext}">${esc(t.label)}</option>`).join("")}</optgroup>`).join("");
  targetSelect.disabled = false;
  convertBtn.disabled = false;
  updateOptions();
  setStatus("Gotowy do konwersji", "ok");
}

function renderInfo(info, category) {
  const chips = [];
  if (category === "image") {
    if (info.width) chips.push(`${info.width}×${info.height}`);
    if (info.frames > 1) chips.push(`${info.frames} klatek`);
  } else {
    if (info.hasVideo && info.width) chips.push(`${info.width}×${info.height}`);
    if (info.hasVideo && info.fps) chips.push(`${Math.round(info.fps)} kl/s`);
    if (info.duration) chips.push(fmtTime(info.duration));
    const codecs = [info.hasVideo && codecName(info.vcodec), info.hasAudio && codecName(info.acodec)].filter(Boolean);
    if (codecs.length) chips.push(codecs.join(" + "));
    if (!info.hasAudio && info.hasVideo) chips.push("bez dźwięku");
  }
  chips.push(fmtSize(info.size));
  fileInfoEl.innerHTML = chips.map((c) => `<span class="m-chip muted">${esc(c)}</span>`).join("");
  fileInfoEl.classList.add("show");
}

// Pokazujemy tylko opcje, które mają sens dla wybranego formatu
function updateOptions() {
  const ext = targetSelect.value;
  const isVideoOut = VIDEO_TARGETS.includes(ext);
  const showQuality = current && !LOSSLESS.includes(ext) && current.targets.category !== "image";
  const copyOption = qualitySelect.querySelector('option[value="copy"]');
  const canCopy = Boolean(current && isVideoOut && current.copyable[ext]);
  copyOption.disabled = !canCopy;
  copyOption.textContent = canCopy ? "Bez ponownego kodowania (szybko)" : "Bez ponownego kodowania — niedostępne";
  if (!canCopy && qualitySelect.value === "copy") qualitySelect.value = "balanced";
  const showEncoder = isVideoOut && ext !== "webm" && qualitySelect.value !== "copy";
  qualityGroup.style.display = showQuality ? "" : "none";
  gpuGroup.style.display = showEncoder ? "" : "none";
  optionsRow.style.display = showQuality || showEncoder ? "" : "none";
  optionsRow.classList.toggle("single", !(showQuality && showEncoder));
}
targetSelect.addEventListener("change", updateOptions);
qualitySelect.addEventListener("change", updateOptions);

// ───── Konwersja ─────
function setBusy(on) {
  busy = on;
  panel.classList.toggle("converting", on);
  convertBtn.disabled = on || !current;
  targetSelect.disabled = on || !current;
  qualitySelect.disabled = on;
  encoderSelect.disabled = on;
  dropZone.style.opacity = on ? "0.6" : "";
  dropZone.style.pointerEvents = on ? "none" : "";
  progressContainer.style.display = on ? "block" : "none";
  if (on) { progressBar.style.width = "0%"; $("stat-left").textContent = "0%"; $("stat-right").textContent = ""; }
}

window.api.onProgress((p) => {
  if (!busy) return;
  const percent = p.percent || 0;
  progressBar.style.width = `${percent}%`;
  $("stat-left").textContent = `${percent}%${p.speed ? ` · ${p.speed.toFixed(1)}×` : ""}`;
  $("stat-right").textContent = [p.bytes ? fmtSize(p.bytes) : "", p.eta ? `zostało ~${fmtTime(p.eta)}` : ""].filter(Boolean).join(" · ");
});
window.api.onNotice((text) => { setStatus(text, "warn"); PitayaUI.showToast(text, "info"); });

convertBtn.addEventListener("click", async () => {
  if (!current || busy) return;
  const ext = targetSelect.value;
  const job = { input: current.path, ext, quality: qualitySelect.value, encoder: encoderSelect.value };
  showOutputBtn.classList.remove("show");
  setBusy(true);
  setStatus(`Konwertowanie do .${ext.toUpperCase()}…`, "warn");
  const started = Date.now();
  const res = await window.api.start(job);
  setBusy(false);
  if (res.ok) {
    const name = res.output.split(/[/\\]/).pop();
    const how = res.encoderLabel ? ` · ${res.encoderLabel}` : res.encoder === "copy" ? " · bez ponownego kodowania" : "";
    setStatus(`Gotowe w ${fmtTime((Date.now() - started) / 1000)}: ${name}${how}`, "ok");
    showOutputBtn.classList.add("show");
    PitayaUI.showToast("Konwersja ukończona!", "success");
  } else if (res.cancelled) {
    setStatus("Konwersja przerwana.", "warn");
  } else {
    setStatus(res.error, "err");
  }
});
cancelBtn.addEventListener("click", () => window.api.cancel());

updateOptions();
loadEncoders(false);
