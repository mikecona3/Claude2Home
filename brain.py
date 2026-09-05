import os
import tempfile
import uuid
import pyttsx3
import requests
from anthropic import Anthropic, APIStatusError, RateLimitError
from faster_whisper import WhisperModel

#Two tier model setup: Sonnet for complexity, Haiku for simple requests/answers
#Backup auto calls on Haiku if requests fail, limits are reached
PRIMARY_MODEL = "claude-sonnet-5"
FALLBACK_MODEL = "claude-haiku-4-5-20251001"

SIMPLE_KEYWORDS = ("turn on", "turn off", "set", "what time", "weather",
                    "volume", "pause", "play", "stop", "lights")

HA_URL = os.environ.get("HA_URL", "")            # e.g. "http://homeassistant.local:8123"
HA_TOKEN = os.environ.get("HA_TOKEN", "")        # long-lived access token

client = Anthropic()  # reads ANTHROPIC_API_KEY
whisper_model = WhisperModel("base.en", device="cpu", compute_type="int8")
tts_engine = pyttsx3.init()

SYSTEM_PROMPT = """You are a helpful voice assistant running on a home device.
Keep answers short and conversational — this will be read aloud.
If the user asks to control a smart home device (lights, thermostat, etc.),
respond with a JSON object like {"action": "call_service", "domain": "light",
"service": "turn_on", "entity_id": "light.kitchen"} instead of prose.
Otherwise just answer normally in plain text."""


def transcribe(audio_path: str) -> str:
    segments, _ = whisper_model.transcribe(audio_path, language="en")
    return " ".join(seg.text for seg in segments).strip()


def choose_model(user_text: str) -> str:
    text = user_text.lower()
    if len(text.split()) <= 6 and any(kw in text for kw in SIMPLE_KEYWORDS):
        return FALLBACK_MODEL
    return PRIMARY_MODEL


def _call_model(model: str, history: list) -> str:
    response = client.messages.create(
        model=model,
        max_tokens=500,
        system=SYSTEM_PROMPT,
        messages=history,
    )
    return response.content[0].text


def ask_claude(user_text: str, history: list) -> str:
    history.append({"role": "user", "content": user_text})
    model = choose_model(user_text)

    try:
        reply = _call_model(model, history)
    except RateLimitError:
        # Limits reached error, falls back to Haiku
        reply = _call_model(FALLBACK_MODEL, history)
    except APIStatusError as e:
        if e.status_code in (402, 403, 429):
            try:
                reply = _call_model(FALLBACK_MODEL, history)
            except APIStatusError:
                reply = ("I'm out of quota right now and can't reach Claude "
                          "at all — you'll need to check your API budget.")
        else:
            raise

    history.append({"role": "assistant", "content": reply})
    return reply


def maybe_run_home_command(reply_text: str) -> str | None:
    import json
    if not HA_URL or not reply_text.strip().startswith("{"):
        return None
    try:
        cmd = json.loads(reply_text)
        url = f"{HA_URL}/api/services/{cmd['domain']}/{cmd['service']}"
        headers = {"Authorization": f"Bearer {HA_TOKEN}"}
        requests.post(url, json={"entity_id": cmd["entity_id"]}, headers=headers, timeout=5)
        return f"Done — {cmd['service'].replace('_', ' ')} for {cmd['entity_id']}."
    except (json.JSONDecodeError, KeyError, requests.RequestException) as e:
        return f"Sorry, I couldn't run that command ({e})."


def synthesize_speech(text: str) -> bytes:
    path = os.path.join(tempfile.gettempdir(), f"tts_{uuid.uuid4().hex}.wav")
    tts_engine.save_to_file(text, path)
    tts_engine.runAndWait()
    with open(path, "rb") as f:
        data = f.read()
    os.remove(path)
    return data


def speak_locally(text: str) -> None:
    tts_engine.say(text)
    tts_engine.runAndWait()
