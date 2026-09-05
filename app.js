// ---------- config ----------
const USER_NAME = "Mike";

const SPEECH_THRESHOLD = 0.02;   // used only to detect when you've stopped talking
const SILENCE_MS = 800;
const MAX_RECORDING_MS = 15000;  // hard stop so a clip can never run forever

// Requires a free Picovoice access key and a custom keyword file trained
// for the phrase at console.picovoice.ai — see README for setup.
const PICOVOICE_ACCESS_KEY = "PASTE_YOUR_ACCESS_KEY_HERE";

// ---------- element refs ----------
const clockEl = document.getElementById("clock");
const ampmEl = document.getElementById("ampm");
const dateEl = document.getElementById("date");
const greetingEl = document.getElementById("greeting");
const statusEl = document.getElementById("status");
const statusTextEl = document.getElementById("status-text");
const exchangeEl = document.getElementById("exchange");

// clock - date - greetings
function greetingForHour(h) {
  if (h < 5)  return "Still up";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  if (h < 21) return "Good evening";
  return "Good night";
}

function updateClock() {
  const now = new Date();
  let hours = now.getHours();
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  const minutes = String(now.getMinutes()).padStart(2, "0");

  clockEl.textContent = `${hours}:${minutes}`;
  ampmEl.textContent = ampm;
  dateEl.textContent = now.toLocaleDateString(undefined, {
    weekday: "long", month: "long", day: "numeric"
  });
  greetingEl.textContent = `${greetingForHour(now.getHours())}, ${USER_NAME}`;
}
setInterval(updateClock, 1000);
updateClock();

// current status - conversation mode
let idleStatusText = "loading...";

function setStatus(text, active) {
  statusTextEl.textContent = text;
  statusEl.classList.toggle("active", !!active);
}

function setIdleStatus(text) {
  idleStatusText = text;
  setStatus(text, false);
}

function returnToIdle() {
  setStatus(idleStatusText, false);
}

function showBubble(role, text) {
  exchangeEl.replaceChildren();
  const bubble = document.createElement("div");
  bubble.className = `bubble ${role}`;
  bubble.textContent = text;
  exchangeEl.appendChild(bubble);
}

// web socket
const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
const ws = new WebSocket(`${wsProtocol}//${location.host}/ws`);
ws.binaryType = "arraybuffer";

let micReady = false;

ws.onopen = () => {
  if (!micReady) setIdleStatus("connected");
  else returnToIdle();
};

ws.onmessage = (event) => {
  if (event.data instanceof ArrayBuffer) {
    playReply(event.data);
    return;
  }
  try {
    const msg = JSON.parse(event.data);
    showBubble(msg.role, msg.text);
    if (msg.role === "user") setStatus("thinking", true);
  } catch (err) {
    console.error("Bad message from server:", event.data, err);
  }
};

ws.onclose = () => setIdleStatus("disconnected — reload to reconnect");
ws.onerror = () => console.error("WebSocket error");

function sendAudio(buffer) {
  if (ws.readyState !== WebSocket.OPEN) {
    setIdleStatus("not connected — clip discarded");
    return;
  }
  ws.send(buffer);
}

// audio clip control
let ttsPlaying = false;

function playReply(arrayBuffer) {
  ttsPlaying = true;
  setStatus("speaking", true);

  const blob = new Blob([arrayBuffer], { type: "audio/wav" });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);

  const finish = () => {
    ttsPlaying = false;
    URL.revokeObjectURL(url);
    returnToIdle();
  };

  audio.onended = finish;
  audio.onerror = finish;

  // Fail-safe for ttsPlaying
  const played = audio.play();
  if (played && typeof played.catch === "function") {
    played.catch((err) => {
      console.error("Playback failed:", err);
      finish();
    });
  }
}

// recording 
let recording = false;
let silenceStart = null;
let maxLengthTimer = null;
let chunks = [];
let mediaRecorder, analyser, audioContext;

function pickMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4"
  ];
  if (typeof MediaRecorder === "undefined") return null;
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || "";
}

async function initMic() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error("microphone not available (needs https or localhost)");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true }
  });

  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioContext.createMediaStreamSource(stream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);

  const mimeType = pickMimeType();
  if (mimeType === null) throw new Error("recording not supported in this browser");

  mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  mediaRecorder.onstop = () => {
    clearTimeout(maxLengthTimer);
    const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
    chunks = [];
    if (blob.size === 0) { returnToIdle(); return; }
    blob.arrayBuffer().then(sendAudio).catch((err) => {
      console.error("Could not read clip:", err);
      setIdleStatus("recording failed — tap to try again");
    });
  };

  micReady = true;
  monitorSilence();
  return stream;
}

function currentVolume() {
  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const v = (data[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / data.length);
}

// Mic watcher - once recording waits for gaps in speech
function monitorSilence() {
  if (recording && !ttsPlaying) {
    const volume = currentVolume();
    if (volume < SPEECH_THRESHOLD) {
      if (silenceStart === null) silenceStart = Date.now();
      else if (Date.now() - silenceStart > SILENCE_MS) stopRecording();
    } else {
      silenceStart = null;
    }
  }
  requestAnimationFrame(monitorSilence);
}

function stopRecording() {
  if (!recording) return;
  recording = false;
  clearTimeout(maxLengthTimer);
  if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.stop();
}

function startRecording() {
  if (recording || ttsPlaying || !micReady) return;
  if (mediaRecorder.state !== "inactive") return;
  if (audioContext.state === "suspended") audioContext.resume();

  recording = true;
  chunks = [];
  silenceStart = null;
  mediaRecorder.start();
  setStatus("recording", true);

  maxLengthTimer = setTimeout(stopRecording, MAX_RECORDING_MS);
}

// ---------- tap-to-talk ----------
document.body.addEventListener("click", () => startRecording());

// Listens for 'Hey Claude'
async function initWakeWord() {
  if (PICOVOICE_ACCESS_KEY.startsWith("PASTE_")) {
    setIdleStatus("tap to talk (no wake word key set)");
    return;
  }
  if (typeof PorcupineWeb === "undefined" || typeof WebVoiceProcessor === "undefined") {
    setIdleStatus("tap to talk (wake word scripts did not load)");
    return;
  }
  try {
    const porcupine = await PorcupineWeb.PorcupineWorker.create(
      PICOVOICE_ACCESS_KEY,
      { publicPath: "/static/hey-claude.ppn", label: "hey claude" },
      () => startRecording(),                        // fires on "Hey Claude"
      { publicPath: "/static/porcupine_params.pv" }  // default English model
    );
    await WebVoiceProcessor.WebVoiceProcessor.subscribe(porcupine);
    setIdleStatus('say "Hey Claude" or tap to talk');
  } catch (err) {
    console.error("Wake word init failed:", err);
    setIdleStatus("tap to talk (wake word unavailable)");
  }
}

initMic()
  .then(initWakeWord)
  .catch((err) => setIdleStatus(`mic error: ${err.message}`));
