"""Optional two-image live generation and verified local-save smoke test.

Run with an SSH tunnel to the Studio service: python test_batch_live.py --execute
"""

import argparse
import asyncio
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path

from aiohttp import ClientSession, ClientTimeout


async def json_request(session, method, url, **kwargs):
    async with session.request(method, url, **kwargs) as response:
        body = await response.json()
        if response.status != 200:
            raise RuntimeError(f"{method} {url}: {response.status} {body}")
        return body


@asynccontextmanager
async def temporary_directory():
    with tempfile.TemporaryDirectory(prefix="canvas-studio-batch-live-") as directory:
        yield directory


async def test(base_url):
    async with ClientSession(timeout=ClientTimeout(total=90)) as session, temporary_directory() as directory:
        catalog = await json_request(session, "GET", base_url + "/api/catalog")
        family = catalog["families"]["krea2"]
        config = {
            "family": "krea2", "model": family["models"][0]["name"],
            "encoder": family["encoders"][0]["name"], "vae": family["vaes"][0]["name"],
            "prompt": "a single red apple on a white table, soft studio lighting, photorealistic",
            "negative": "", "width": 256, "height": 256, "steps": 8, "cfg": 1,
            "seed": -1, "sampler": family["defaults"]["sampler"],
            "scheduler": family["defaults"]["scheduler"], "loras": [], "reference": None,
        }
        seeds = []
        for index in (1, 2):
            assert len(seeds) == index - 1, "Next image submitted before previous local save"
            result = await json_request(session, "POST", base_url + "/api/generate", json=config)
            prompt_id = result["prompt_id"]
            seeds.append(result["seed"])
            deadline = time.monotonic() + 600
            while time.monotonic() < deadline:
                await asyncio.sleep(1)
                job = await json_request(session, "GET", base_url + f"/api/jobs/{prompt_id}")
                if job["state"] == "running":
                    continue
                if job["state"] == "error":
                    raise RuntimeError(f"Image {index} failed: {job.get('error')}")
                if not job["images"]:
                    raise RuntimeError(f"Image {index} completed without output")
                item = job["images"][0]
                async with session.get(base_url + "/api/image", params=item) as image_response:
                    if image_response.status != 200:
                        raise RuntimeError(f"Image download failed: {image_response.status}")
                    data = await image_response.read()
                if len(data) < 100 or not data.startswith(b"\x89PNG\r\n\x1a\n"):
                    raise RuntimeError("Downloaded output is not a complete PNG")
                local_path = Path(directory) / item["filename"]
                local_path.write_bytes(data)
                if local_path.stat().st_size != len(data):
                    raise RuntimeError("Windows local file size verification failed")
                await json_request(session, "POST", base_url + f"/api/jobs/{prompt_id}/saved")
                async with session.get(base_url + "/api/image", params=item) as removed:
                    if removed.status != 404:
                        raise RuntimeError("Server copy was not removed after verified local save")
                print(f"IMAGE_{index}_SAVED seed={result['seed']} bytes={len(data)}")
                break
            else:
                raise TimeoutError(f"Image {index} exceeded 10 minutes")
        assert seeds[0] != seeds[1], "Random seeds unexpectedly repeated"
        print("LIVE_BATCH_OK: two sequential images saved on Windows and server copies cleared")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true", help="run real two-image GPU test")
    parser.add_argument("--url", default="http://127.0.0.1:18189")
    args = parser.parse_args()
    if args.execute:
        asyncio.run(test(args.url.rstrip("/")))
    else:
        print("Add --execute to run two real generations through an SSH tunnel.")
