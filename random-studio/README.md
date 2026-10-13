# Random Studio

Random Studio is a web frontend and Python service for composing batch image-generation jobs for ComfyUI. Its source is maintained in the same Canvas Studio monorepo as the primary creator.

## Run locally

Install the package and development dependencies with `python -m pip install -e ".[dev]"`, then start the service with `python run.py`. By default it connects to a ComfyUI endpoint on the local machine. Runtime paths and optional worker endpoints are supplied through environment variables rather than committed machine-specific configuration.

Prompt catalogs, workflow graphs, model/LoRA inventories, generated images, encryption keys, and other runtime data are intentionally not part of this repository. Supply those resources separately for a working generation setup. The repository contains no model weights or user-authored prompt library.

Tests are in `tests/` and can be run with `python -m pytest`.
