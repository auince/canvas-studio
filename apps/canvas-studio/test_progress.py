"""Progress event unit checks and optional end-to-end image generation."""

import argparse
import asyncio
import time

from aiohttp import ClientSession

from app import apply_progress_event, progress_view


URL = "http://127.0.0.1:8189"


def check_events():
    record = {"stage": "queued", "step": 0, "total": 12,
              "node_types": {"1": "UNETLoader", "2": "KSampler", "3": "VAEDecode", "4": "SaveImage"}}
    apply_progress_event(record, {"type": "execution_start", "data": {}})
    assert record["stage"] == "loading"
    apply_progress_event(record, {"type": "executing", "data": {"node": "2"}})
    assert record["stage"] == "sampling"
    apply_progress_event(record, {"type": "progress", "data": {"node": "2", "value": 5, "max": 12}})
    assert progress_view(record) == {"stage": "sampling", "step": 5, "total": 12}
    apply_progress_event(record, {"type": "progress", "data": {"node": "2", "value": 99, "max": 12}})
    assert record["step"] == 12
    apply_progress_event(record, {"type": "executing", "data": {"node": "3"}})
    assert record["stage"] == "decoding"
    apply_progress_event(record, {"type": "executing", "data": {"node": "4"}})
    assert record["stage"] == "saving"
    apply_progress_event(record, {"type": "execution_success", "data": {}})
    assert record["stage"] == "finishing"
    apply_progress_event(record, {"type": "execution_error", "data": {"exception_message": "test failure"}})
    assert record["stage"] == "error" and record["error"] == "test failure"
    print("PROGRESS_EVENTS_OK")


async def check_generation():
    async with ClientSession() as session:
        async with session.get(URL + "/api/catalog") as response:
            assert response.status == 200
            catalog = await response.json()
        family = catalog["families"]["anima"]
        config = {
            "family": "anima", "model": family["models"][0]["name"],
            "encoder": family["encoders"][0]["name"], "vae": family["vaes"][0]["name"],
            "prompt": "an adult woman standing in a forest, soft lighting, anime illustration",
            "width": 512, "height": 512, "steps": 20, "cfg": 4,
            "seed": -1, "sampler": family["defaults"]["sampler"],
            "scheduler": family["defaults"]["scheduler"], "loras": [],
        }
        async with session.post(URL + "/api/generate", json=config) as response:
            result = await response.json()
            assert response.status == 200, result
        prompt_id = result["prompt_id"]
        seen = []
        deadline = time.monotonic() + 600
        while time.monotonic() < deadline:
            async with session.get(URL + f"/api/jobs/{prompt_id}") as response:
                job = await response.json()
                assert response.status == 200, job
            progress = job.get("progress")
            if progress:
                seen.append(progress)
            if job["state"] == "done":
                assert job["images"], job
                assert any(item["stage"] == "sampling" and item["step"] > 0 for item in seen), seen
                async with session.get(URL + "/api/image", params=job["images"][0]) as response:
                    assert response.status == 200 and (await response.read()).startswith(b"\x89PNG")
                async with session.post(URL + f"/api/jobs/{prompt_id}/saved") as response:
                    assert response.status == 200, await response.text()
                print(f"LIVE_PROGRESS_OK {max(item['step'] for item in seen)} / {max(item['total'] for item in seen)} steps")
                print(f"IMAGE_OK {job['images'][0]['filename']}")
                return
            assert job["state"] == "running", job
            await asyncio.sleep(0.25)
        raise TimeoutError("Generation exceeded 10 minutes")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true")
    options = parser.parse_args()
    check_events()
    if options.execute:
        asyncio.run(check_generation())
