# Canvas Studio

Canvas Studio is a web frontend and Python service for image generation through a local ComfyUI instance. The repository contains application code only; personal prompts, model and LoRA inventories, workflow graphs, generated media, and deployment secrets are intentionally kept outside version control.

## Run locally

Install Python dependencies (`aiohttp` and `safetensors`), then run `python app.py`. The service listens on `127.0.0.1:8189` and expects ComfyUI at `http://127.0.0.1:8188` by default.

Runtime locations can be supplied through environment variables:

- `COMFY_URL`, `CANVAS_PUBLIC_ORIGIN`
- `ANIMA_RESOURCE_ROOT`, `ANIMA_CHECKPOINT_DIR`
- `KREA2_RESOURCE_ROOT`, `KREA2_CHECKPOINT_DIR`
- `COMFY_OUTPUT_DIR`, `COMFY_INPUT_DIR`

The prompt library and workflow presets are deployment-owned data and are not included in this code-only repository. Model and LoRA files must be installed separately in ComfyUI; no weights or user LoRAs are distributed here.
