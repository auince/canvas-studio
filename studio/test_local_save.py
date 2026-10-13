"""Integration test for temporary generation, reference upload, and cleanup.

This simulates a client that verifies image bytes before acknowledging local
save. It does not test the Windows browser's folder picker or write permission.
"""

import asyncio
import io
import time
from pathlib import Path

from aiohttp import ClientSession, FormData
from PIL import Image


URL = "http://127.0.0.1:8189"
OUTPUT = Path("/opt/ComfyUI-Anima/output/Studio")
INPUT = Path("/opt/ComfyUI-Anima/input")


async def run():
    async with ClientSession() as session:
        async with session.get(URL + "/api/catalog") as response:
            assert response.status == 200
            catalog = await response.json()
        family = catalog["families"]["anima"]
        picture = io.BytesIO()
        Image.new("RGB", (512, 512), (76, 118, 130)).save(picture, format="PNG")
        form = FormData()
        form.add_field("file", picture.getvalue(), filename="reference.png", content_type="image/png")
        async with session.post(URL + "/api/reference", data=form) as response:
            body = await response.json()
            assert response.status == 200, body
        reference = body["name"]
        assert reference.startswith("studio_ref_") and (INPUT / reference).is_file()
        config = {
            "family": "anima", "model": family["models"][0]["name"],
            "encoder": family["encoders"][0]["name"], "vae": family["vaes"][0]["name"],
            "prompt": "a quiet garden at sunrise, a single red flower, detailed illustration",
            "width": 512, "height": 512, "steps": 4, "cfg": family["defaults"]["cfg"],
            "sampler": family["defaults"]["sampler"], "scheduler": family["defaults"]["scheduler"],
            "seed": 42, "loras": [], "reference": reference, "denoise": 0.65,
        }
        async with session.post(URL + "/api/generate", json=config) as response:
            body = await response.json()
            assert response.status == 200, body
        prompt_id = body["prompt_id"]
        deadline = time.monotonic() + 600
        while time.monotonic() < deadline:
            await asyncio.sleep(2)
            async with session.get(URL + f"/api/jobs/{prompt_id}") as response:
                job = await response.json()
                assert response.status == 200, job
            if job["state"] == "running":
                continue
            assert job["state"] == "done" and job["images"], job
            async with session.get("http://127.0.0.1:8188/history/" + prompt_id) as response:
                history = await response.json()
                assert response.status == 200 and prompt_id in history
            all_images = [item for output in history[prompt_id]["outputs"].values()
                          for item in output.get("images", [])]
            assert all(item["type"] == "output" for item in all_images), all_images
            for item in job["images"]:
                assert item["filename"].startswith("studiojob_")
                assert (OUTPUT / item["filename"]).is_file()
                async with session.get(URL + "/api/image", params=item) as response:
                    content = await response.read()
                    assert response.status == 200 and content.startswith(b"\x89PNG") and len(content) > 10000
            async with session.post(URL + f"/api/jobs/{prompt_id}/saved") as response:
                result = await response.json()
                assert response.status == 200 and result["removed"], result
            assert not (INPUT / reference).exists()
            assert all(not (OUTPUT / item["filename"]).exists() for item in job["images"])
            print(f"LOCAL_SAVE_CLEANUP_OK {prompt_id}: {len(job['images'])} image(s), reference removed")
            return
        raise TimeoutError("Reference generation exceeded 10 minutes")


if __name__ == "__main__":
    asyncio.run(run())
