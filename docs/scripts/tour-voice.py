"""Render the tour's narration with Kokoro, a local neural voice.

Reads docs/src/tours/framework-tour.voice.json (written by tour-lines.mjs) and writes
one docs/static/tour/voice/<key>.m4a per line that doesn't have a clip yet, so a
re-run only renders the lines that changed. Clips no line names are deleted.

Setup, once, outside the repo:
    python3.12 -m venv .venv && .venv/bin/pip install kokoro-onnx soundfile
    curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
    curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin

Run:
    .venv/bin/python docs/scripts/tour-voice.py --model <dir with the two files> [--voice af_heart]
"""

import argparse
import json
import pathlib
import subprocess
import tempfile

import soundfile as sf
from kokoro_onnx import Kokoro

DOCS = pathlib.Path(__file__).resolve().parent.parent
VOICE_DIR = DOCS / "static" / "tour" / "voice"
LINES = DOCS / "src" / "tours" / "framework-tour.voice.json"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, help="directory with kokoro-v1.0.onnx and voices-v1.0.bin")
    parser.add_argument("--voice", default="af_heart")
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--force", action="store_true", help="render every line again")
    args = parser.parse_args()

    model = pathlib.Path(args.model)
    kokoro = Kokoro(str(model / "kokoro-v1.0.onnx"), str(model / "voices-v1.0.bin"))
    lang = "en-gb" if args.voice.startswith("b") else "en-us"
    lines = json.loads(LINES.read_text())

    keep = set()
    rendered = 0
    for line in lines:
        out = VOICE_DIR / f"{line['key']}.m4a"
        keep.add(out.name)
        if out.exists() and not args.force:
            continue
        samples, rate = kokoro.create(line["text"], voice=args.voice, speed=args.speed, lang=lang)
        with tempfile.NamedTemporaryFile(suffix=".wav") as wav:
            sf.write(wav.name, samples, rate)
            # mono AAC plays in every browser; 40 kbps is plenty for one voice
            subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error", "-i", wav.name, "-ac", "1", "-c:a", "aac", "-b:a", "40k", str(out)],
                check=True,
            )
        rendered += 1

    stale = [f for f in VOICE_DIR.glob("*.m4a") if f.name not in keep]
    for f in stale:
        f.unlink()
    print(f"{len(lines)} lines, {rendered} rendered, {len(stale)} stale clips removed")


if __name__ == "__main__":
    main()
