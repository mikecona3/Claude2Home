#Helpers for handling auto clips sent from the browswer

import os
import tempfile
import uuid


def save_temp_audio(data: bytes, suffix: str = ".webm") -> str:
    path = os.path.join(tempfile.gettempdir(), f"clip_{uuid.uuid4().hex}{suffix}")
    with open(path, "wb") as f:
        f.write(data)
    return path


def cleanup(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass
