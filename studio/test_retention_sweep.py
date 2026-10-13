"""Pure filesystem/queue test for the managed-job expiry cleaner."""

import asyncio
import json
import os
import tempfile
import time
import uuid
from pathlib import Path

import app


class FakeResponse:
    status = 200

    def __init__(self, body=None):
        self.body = body

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False

    async def json(self):
        return self.body


class FakeSession:
    def __init__(self, active_id):
        self.active_id = active_id
        self.deleted = []

    def get(self, url):
        running = [[0, self.active_id]] if self.active_id else []
        return FakeResponse({"queue_running": running, "queue_pending": []})

    def post(self, url, json):
        self.deleted.extend(json["delete"])
        return FakeResponse()


async def check():
    original = app.OUTPUT_DIR, app.INPUT_DIR, app.MANAGED_JOBS
    with tempfile.TemporaryDirectory(prefix="canvas-retention-test-") as root:
        base = Path(root)
        app.OUTPUT_DIR = base / "output"
        app.INPUT_DIR = base / "input"
        app.MANAGED_JOBS = base / "jobs"
        for folder in (app.OUTPUT_DIR, app.INPUT_DIR, app.MANAGED_JOBS):
            folder.mkdir()
        try:
            job_id = str(uuid.uuid4())
            token = uuid.uuid4().hex
            reference = f"studio_ref_{uuid.uuid4().hex}.png"
            output = app.OUTPUT_DIR / f"studiojob_{token}_00001_.png"
            ref_path = app.INPUT_DIR / reference
            unrelated = app.OUTPUT_DIR / "anima_00001_.png"
            manifest = app.MANAGED_JOBS / f"{job_id}.json"
            output.write_bytes(b"temporary output")
            ref_path.write_bytes(b"temporary reference")
            unrelated.write_bytes(b"existing user image")
            manifest.write_text(json.dumps({"token": token, "reference": reference}), encoding="utf-8")
            old = time.time() - 2 * app.TEMP_RETENTION_SECONDS
            for path in (output, ref_path, manifest):
                os.utime(path, (old, old))
            session = FakeSession(job_id)
            state = {"comfy_session": session, "job_progress": {}, "progress_tasks": {}}
            await app.sweep_managed_files(state)
            assert output.exists() and ref_path.exists() and manifest.exists()
            session.active_id = None
            await app.sweep_managed_files(state)
            assert not output.exists() and not ref_path.exists() and not manifest.exists()
            assert unrelated.exists() and session.deleted == [job_id]
            print("RETENTION_SWEEP_OK: active jobs kept; expired managed files removed; old user image kept")
        finally:
            app.OUTPUT_DIR, app.INPUT_DIR, app.MANAGED_JOBS = original


if __name__ == "__main__":
    asyncio.run(check())
