#!/usr/bin/env python3
"""Resident-model STT worker for wa-stt.mjs (issue #23).

Keeps an mlx_whisper model loaded once and serves live, incrementally-
corrected transcripts over a Unix domain socket. One connection = one
logical mic: the client streams raw 16 kHz mono s16le PCM in; the worker
writes newline-delimited JSON transcript events back on the *same* socket
(full duplex — audio only ever flows one way, text only the other, so no
framing is needed on either side).

    node -> [PCM bytes]  -> worker
    node <- [JSON lines] <- worker

Events:
    {"type":"partial","text":"...","words":[[text,start,end],...]}
        The current best guess for the in-progress utterance. Sent every
        ~TICK_MS while there's buffered audio. Supersedes the previous
        partial entirely — the client redraws, it doesn't append.
    {"type":"final","text":"...","words":[...]}
        Sent once a silence gap closes the utterance. The buffer resets
        after this; the next partial starts a new utterance.

Usage:
    python3 scripts/stt_worker.py [--socket PATH] [--model REPO]
"""
import argparse
import asyncio
import json
import os
import sys
import threading
import time

# Silence HF Hub download bars and mlx_whisper's per-chunk tqdm progress —
# both write straight to stderr regardless of our own verbose=False, and would
# otherwise spam the daemon log on every tick. TQDM_DISABLE isn't honoured by
# every tqdm version, so force every tqdm instance's `disable` directly.
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
import tqdm as _tqdm

_orig_tqdm_init = _tqdm.tqdm.__init__
_tqdm.tqdm.__init__ = lambda self, *a, **kw: _orig_tqdm_init(self, *a, **{**kw, "disable": True})

import numpy as np

SAMPLE_RATE = 16000
TICK_MS = 400  # re-transcribe cadence
SILENCE_MS = 700  # trailing quiet before an utterance finalizes
SILENCE_RMS = 0.006  # s16-normalized RMS below this counts as quiet
MAX_UTTERANCE_S = 20  # force-finalize a runaway utterance


def log(*a):
    print(*a, file=sys.stderr, flush=True)


class MicSession:
    def __init__(self, transcribe):
        self._transcribe = transcribe
        self.buf = np.zeros(0, dtype=np.float32)
        self.last_partial_text = None

    def push(self, pcm_bytes):
        chunk = np.frombuffer(pcm_bytes, dtype="<i2").astype(np.float32) / 32768.0
        self.buf = np.concatenate([self.buf, chunk])

    def trailing_is_silent(self):
        n = int(SILENCE_MS / 1000 * SAMPLE_RATE)
        if len(self.buf) < n:
            return False
        tail = self.buf[-n:]
        return float(np.sqrt(np.mean(tail**2))) < SILENCE_RMS

    def duration_s(self):
        return len(self.buf) / SAMPLE_RATE

    def transcribe_current(self):
        if len(self.buf) < SAMPLE_RATE * 0.2:  # <200ms — not worth a call
            return None
        r = self._transcribe(self.buf)
        words = [
            [w["word"], round(w["start"], 2), round(w["end"], 2)]
            for seg in r.get("segments", [])
            for w in seg.get("words", [])
        ]
        return {"text": r["text"].strip(), "words": words}

    def reset(self):
        self.buf = np.zeros(0, dtype=np.float32)
        self.last_partial_text = None


async def handle_conn(reader, writer, transcribe):
    peer = writer.get_extra_info("peername") or id(writer)
    log(f"[{peer}] connected")
    session = MicSession(transcribe)
    closed = False

    async def reader_loop():
        nonlocal closed
        try:
            while True:
                data = await reader.read(65536)
                if not data:
                    break
                session.push(data)
        finally:
            closed = True

    debug = os.environ.get("STT_DEBUG")

    async def tick_loop():
        while not closed:
            await asyncio.sleep(TICK_MS / 1000)
            if debug:
                log(f"[{peer}] loop wake t={time.time():.3f} buflen={len(session.buf)}")
            if len(session.buf) == 0:
                continue
            force = session.duration_s() >= MAX_UTTERANCE_S
            silent = session.trailing_is_silent()
            if debug:
                n = int(SILENCE_MS / 1000 * SAMPLE_RATE)
                tail_rms = float(np.sqrt(np.mean(session.buf[-n:] ** 2))) if len(session.buf) >= n else -1
                log(f"[{peer}] TICK buf={session.duration_s():.2f}s tail_rms={tail_rms:.4f} silent={silent} force={force} t={time.time():.3f}")
            t0 = time.time()
            result = await asyncio.to_thread(session.transcribe_current)
            if debug:
                log(f"[{peer}] transcribe took {time.time()-t0:.2f}s")
            if result is None:
                continue
            if debug:
                log(f"[{peer}] transcribe -> {result['text']!r}")
            if silent or force:
                send(writer, {"type": "final", **result})
                session.reset()
            elif result["text"] != session.last_partial_text:
                session.last_partial_text = result["text"]
                send(writer, {"type": "partial", **result})

    def send(w, obj):
        try:
            w.write((json.dumps(obj) + "\n").encode("utf-8"))
        except Exception as e:
            log(f"[{peer}] send failed: {e}")

    await asyncio.gather(reader_loop(), tick_loop())
    # flush whatever's left as a final utterance
    if len(session.buf) > 0:
        result = await asyncio.to_thread(session.transcribe_current)
        if result:
            send(writer, {"type": "final", **result})
    writer.close()
    log(f"[{peer}] disconnected")


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--socket", default=os.path.join(os.path.dirname(__file__), "..", ".wa-stt.sock"))
    ap.add_argument("--model", default="mlx-community/whisper-tiny")
    args = ap.parse_args()

    import mlx_whisper

    # Multiple mic sessions each run their tick loop on their own thread (via
    # asyncio.to_thread), but MLX's Metal backend isn't safe for concurrent
    # inference calls sharing a command buffer — two overlapping transcribe()
    # calls crash the whole process ("command encoder is already encoding").
    # Serialize GPU access across all sessions; the tick loops themselves stay
    # concurrent, only the actual inference call queues.
    gpu_lock = threading.Lock()

    def transcribe(audio):
        with gpu_lock:
            return mlx_whisper.transcribe(
                audio,
                path_or_hf_repo=args.model,
                word_timestamps=True,
                verbose=False,
                condition_on_previous_text=False,
            )

    # warm the model once at startup so the first real utterance isn't slow
    t0 = time.time()
    transcribe(np.zeros(SAMPLE_RATE // 2, dtype=np.float32))
    log(f"model warm ({args.model}) in {time.time()-t0:.1f}s")

    sock_path = os.path.abspath(args.socket)
    if os.path.exists(sock_path):
        os.remove(sock_path)
    server = await asyncio.start_unix_server(lambda r, w: handle_conn(r, w, transcribe), path=sock_path)
    log(f"listening on {sock_path}")
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
