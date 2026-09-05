# Claude2Home — v1.0 beta
It's Claude for your smart device! Use an old tablet or build your own hardware. 

This log covers current standings for v1.0 beta


## What's here
- **Voice Support** Tablet browser captures the mic, transcribes with local Whisper, sends the text to Claude and speaks the reply back.
- **Wake Word/Tap** Say "Hey Claude" (via Porcupine) or tap the screen.
- **Two-Tier Model Routing.** Simple commands go to Haiku 4.5, complex questions go to Sonnet 5. This model auto falls back to Haiku if
  Sonnet hits limits, instead of failing silently. Opus and Fable models are not currently supported on this version. 
- **Basic Smart Home Controls** If Claude's reply looks like a service call command, it automatically goes to Home Assistant's REST API
  instead of read aloud.
- **A Beautiful, Intuitive UI (v1.1)** Clean, intuitive UI featuring a bold centered clock, time of day greetings, with familiar Claude branding.


## What Doesn't (or Sometimes) Works
- "Hey Claude" is unproven in v1.0 - while I haven't had much trouble with it working, it hasn't been stress tested over time for false positives yet.
- Echo/Self Triggering is a Risk - trying to avoid using 'echoCancellation' mic and speaker live closely, sometimes it self triggers.
- Silence Detection Cut Offs - both 'speech_threshold' and 'silence_ms' will need tuning over time and they are likely to cut you off mid sentence,
  due to the natural way humans speak.
- Home Assistant Commands Fragility - currently based on Claude responding with a specific JSON shape and hoping it complies exactly. There is not
  currently schema validation, no retry logic, no confirmation step before a command fires. Treat it as a very early beta, not something to rely on
  (locks, validation, etc need more guardrails).
- No Persistence - History lives in memory per websocket connection — once refreshed/reset the tablet's browser the context is gone.
- Single User w/No Authorization Requirements - works fine for a single family home, not fine for public/multi use areas
- Whisper's Model Tradeoff - speed over accuracy for this build, don't expect high accuracy on mumbled words or heavy accented speech.
  

## Setup (*PLEASE NOTE: You are doing this at your own risk. This is a beta and performs like beta software)
# Claude Home Assistant (prototype)
bash
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...
# optional (for smart-home control)
export HA_URL=http://homeassistant.local:8123
export HA_TOKEN=your-long-lived-access-token

## Run
bash
python main.py

Then open `http://<device-ip>:8000` in the tablet's browser and go fullscreen
(Chromium kiosk mode: `chromium-browser --kiosk http://localhost:8000`).

## Wake word setup ("Hey Claude")
Wake-word detection runs entirely in the tablet's browser via Picovoice's
Porcupine engine (WASM) — no audio streams anywhere just to listen for the
trigger phrase. You'll need:

1. A free account at [console.picovoice.ai](https://console.picovoice.ai) — grab your **AccessKey** from the dashboard.
2. Train a custom keyword for **"Hey Claude"** in the console (Wake Word → train a keyword, type the phrase, pick Web/WASM as the target
   platform),then download the resulting `.ppn` file.
3. Download `porcupine_params.pv` (the default English model) from the [Porcupine GitHub repo](https://github.com/Picovoice/porcupine) —
   it's under `lib/common/`.
4. Place both files in `static/` as `static/hey-claude.ppn` and `static/porcupine_params.pv`.
5. In `static/index.html`, replace `PASTE_YOUR_ACCESS_KEY_HERE` with your AccessKey.

If you do not set the access key, the device falls back automatically to tap for inputs — tap anywhere on the screen starts recording,
same as if the wake word fired. That fallback stays available even after wake word is working, so you always have both options.

## Auto-updates from GitHub
The `deploy/` folder has a simple self-update setup: a systemd timer checks `origin/main` once every 24 hours, and if there's a new 
commit, pulls it, reinstalls dependencies, and restarts the service.

The main service itself is set to restart automatically on any exit (crash, power loss, manual reboot) and to start on boot — so after a
shutdown or restart, both the assistant and the update-checker come back on their own without you needing to SSH in and start anything by hand.

The `enable` flag (not just `start`) is what makes both come back after a reboot — `start` alone would only run them until the next shutdown.

**Known limitations of this setup:**
- The update check runs every 24 hours (with `Persistent=true`, so if the device happened to be off at check time, it catches  after the next
  boot instead of waiting a full day). Not instant — a push to `main` can take up to a day to actually land on the device.
- A restart mid-conversation will drop whatever's in progress.
- Currently no rollback. If a pushed commit is broken, the update will force hardware into a broken state and keep retrying. It is highly
  recommended you do not force update from the 'beta' branch.
