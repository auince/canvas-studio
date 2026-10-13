"""Exercise LoRA management without touching installed model files."""

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from aiohttp import web

import app as studio


class Body:
    def __init__(self, value):
        self.value = json.dumps(value).encode("utf-8")

    async def read(self, limit):
        return self.value[:limit]


class Request:
    def __init__(self, method, value):
        self.method = method
        self.content = Body(value)
        self.content_length = len(self.content.value)
        self.app = {"lora_lock": asyncio.Lock()}


class ManagementTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        families = {
            key: {**value, "directory": self.root / key, "model_directory": self.root / key}
            for key, value in studio.FAMILIES.items()
        }
        self.families = patch.object(studio, "FAMILIES", families)
        self.metadata = patch.object(studio, "LORA_METADATA", self.root / "state" / "lora-metadata.json")

        async def empty_queue(*args, **kwargs):
            return {"queue_running": [], "queue_pending": []}

        self.queue = patch.object(studio, "comfy_json", empty_queue)
        self.families.start()
        self.metadata.start()
        self.queue.start()
        self.directory = self.root / "anima" / "loras"
        self.directory.mkdir(parents=True)
        (self.directory / "original.safetensors").write_bytes(b"weight")

    async def asyncTearDown(self):
        self.queue.stop()
        self.metadata.stop()
        self.families.stop()
        self.temp.cleanup()

    async def test_group_rename_template_alias_and_delete(self):
        await studio.lora_command(Request("PATCH", {
            "family": "anima", "name": "original.safetensors", "group": "人像",
        }))
        entry = next(item for item in studio.catalog()["anima"]["loras"] if item["name"] == "original.safetensors")
        self.assertEqual(entry["group"], "人像")
        self.assertTrue(entry["manageable"])
        response = await studio.lora_command(Request("PATCH", {
            "family": "anima", "name": "original.safetensors",
            "new_name": "renamed.safetensors", "group": "人像",
        }))
        self.assertEqual(json.loads(response.text)["name"], "renamed.safetensors")
        self.assertFalse((self.directory / "original.safetensors").exists())
        self.assertEqual((self.directory / "renamed.safetensors").read_bytes(), b"weight")
        self.assertEqual(studio.lora_metadata()["aliases"]["anima"]["original.safetensors"], "renamed.safetensors")
        with patch.object(studio, "TEMPLATES", [{
            "id": "test", "title": "Test", "family": "anima", "source_file": None,
            "config": {"model": "base.safetensors", "loras": [{"name": "original.safetensors", "strength": 0.8}]},
        }]):
            template = json.loads((await studio.templates_list(SimpleNamespace())).text)[0]
            self.assertEqual(template["config"]["loras"][0]["name"], "renamed.safetensors")
        with self.assertRaises(web.HTTPBadRequest):
            await studio.lora_command(Request("DELETE", {
                "family": "anima", "name": "renamed.safetensors", "confirm_name": "wrong.safetensors",
            }))
        await studio.lora_command(Request("DELETE", {
            "family": "anima", "name": "renamed.safetensors", "confirm_name": "renamed.safetensors",
        }))
        self.assertFalse((self.directory / "renamed.safetensors").exists())
        self.assertEqual(studio.lora_metadata()["groups"]["anima"], {})

    async def test_collision_queue_and_invalid_paths(self):
        (self.directory / "exists.safetensors").write_bytes(b"keep")
        with self.assertRaises(web.HTTPConflict):
            await studio.lora_command(Request("PATCH", {
                "family": "anima", "name": "original.safetensors", "new_name": "exists.safetensors",
            }))
        self.assertEqual((self.directory / "exists.safetensors").read_bytes(), b"keep")
        async def busy_queue(*args, **kwargs):
            return {"queue_running": [[0, "active"]], "queue_pending": []}
        with patch.object(studio, "comfy_json", busy_queue):
            with self.assertRaises(web.HTTPConflict):
                await studio.lora_command(Request("DELETE", {
                    "family": "anima", "name": "original.safetensors", "confirm_name": "original.safetensors",
                }))
            with self.assertRaises(web.HTTPConflict):
                await studio.lora_command(Request("PATCH", {
                    "family": "anima", "name": "original.safetensors", "new_name": "new.safetensors",
                }))
            await studio.lora_command(Request("PATCH", {
                "family": "anima", "name": "original.safetensors", "group": "即使排队也可以整理",
            }))
        for value in ("../outside.safetensors", "invalid.txt", ".hidden.safetensors"):
            with self.assertRaises(web.HTTPBadRequest):
                await studio.lora_command(Request("PATCH", {
                    "family": "anima", "name": "original.safetensors", "new_name": value,
                }))
        self.assertTrue((self.directory / "original.safetensors").exists())

    async def test_symlink_is_not_manageable(self):
        link = self.directory / "link.safetensors"
        try:
            link.symlink_to(self.directory / "original.safetensors")
        except OSError:
            self.skipTest("symlinks unavailable")
        with self.assertRaises(web.HTTPForbidden):
            await studio.lora_command(Request("DELETE", {
                "family": "anima", "name": "link.safetensors", "confirm_name": "link.safetensors",
            }))
        self.assertTrue((self.directory / "original.safetensors").exists())


if __name__ == "__main__":
    unittest.main()
