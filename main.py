#Entry point running on Pi, tablet or other backend hardware

#Browser is solely responsible for capturing the mic, detecting speech, 
#silence, and streaming audio clips over websocket. 


import asyncio
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from audio import cleanup, save_temp_audio
from brain import ask_claude, maybe_run_home_command, synthesize_speech, transcribe

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.middleware("http")
async def add_porcupine_headers(request, call_next):
    response = await call_next(request)
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    response.headers["Cross-Origin-Embedder-Policy"] = "require-corp"
    return response


@app.get("/")
async def index():
    with open("static/index.html") as f:
        return HTMLResponse(f.read())


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket):
    await websocket.accept()
    history: list[dict] = []  #saves conversation history for this session only

    try:
        while True:
            message = await websocket.receive()
            if message.get("bytes") is not None:
                await handle_audio_clip(websocket, message["bytes"], history)
            # text messages reserved for future use
    except WebSocketDisconnect:
        pass


async def handle_audio_clip(websocket: WebSocket, audio_bytes: bytes, history: list):
    clip_path = save_temp_audio(audio_bytes)
    try:
        user_text = await asyncio.to_thread(transcribe, clip_path)
    finally:
        cleanup(clip_path)

    if not user_text:
        return  # no audio/empty clip ignores and discards

    await websocket.send_json({"role": "user", "text": user_text})

    reply = await asyncio.to_thread(ask_claude, user_text, history)
    home_result = maybe_run_home_command(reply)
    spoken_reply = home_result or reply

    await websocket.send_json({"role": "assistant", "text": spoken_reply})

    audio_reply = await asyncio.to_thread(synthesize_speech, spoken_reply)
    await websocket.send_bytes(audio_reply)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
