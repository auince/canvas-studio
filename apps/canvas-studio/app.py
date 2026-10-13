import asyncio
import json
import os
import re
import secrets
import tempfile
import time
import uuid
from pathlib import Path
from urllib.parse import urlencode

from aiohttp import ClientError, ClientSession, ClientTimeout, FormData, WSMsgType, web
from safetensors import SafetensorError, safe_open


ROOT = Path(__file__).resolve().parent
COMFY = os.environ.get("COMFY_URL", "http://127.0.0.1:8188")
PUBLIC_ORIGIN = os.environ.get("CANVAS_PUBLIC_ORIGIN", "")
FAMILIES = {
    "anima": {
        "label": "Anima Base 1.0",
        "directory": Path(os.environ.get("ANIMA_RESOURCE_ROOT", ROOT / "models" / "anima")),
        "model_directory": Path(os.environ.get("ANIMA_CHECKPOINT_DIR", ROOT / "models" / "anima" / "checkpoints")),
        "clip_type": "stable_diffusion",
        "defaults": {"steps": 30, "cfg": 4, "sampler": "er_sde", "scheduler": "simple"},
    },
    "krea2": {
        "label": "Krea 2 Turbo",
        "directory": Path(os.environ.get("KREA2_RESOURCE_ROOT", ROOT / "models" / "krea2")),
        "model_directory": Path(os.environ.get("KREA2_CHECKPOINT_DIR", ROOT / "models" / "krea2" / "checkpoints")),
        "clip_type": "krea2",
        "defaults": {"steps": 8, "cfg": 1, "sampler": "euler", "scheduler": "simple"},
    },
}
MAX_LORA = 5 * 1024**3
MAX_REFERENCE = 30 * 1024**2
OUTPUT_DIR = Path(os.environ.get("COMFY_OUTPUT_DIR", ROOT / "runtime" / "output"))
INPUT_DIR = Path(os.environ.get("COMFY_INPUT_DIR", ROOT / "runtime" / "input"))
MANAGED_JOBS = ROOT / "state" / "managed-jobs"
LORA_METADATA = ROOT / "state" / "lora-metadata.json"
TEMP_RETENTION_SECONDS = 3600
JOB_TOKEN = re.compile(r"[0-9a-f]{32}\Z")
REFERENCE_NAME = re.compile(r"studio_ref_[0-9a-f]{32}\.(?:png|jpg|jpeg|webp)\Z")
TEMPLATES: list[dict] = []


def files_in(directory):
    if not directory.is_dir():
        return []
    return [
        {"name": file.name, "bytes": file.stat().st_size}
        for file in sorted(directory.iterdir(), key=lambda path: path.name.casefold())
        if file.is_file() and file.suffix.lower() == ".safetensors"
    ]


def lora_metadata():
    if not LORA_METADATA.exists():
        return {"groups": {}, "aliases": {}}
    try:
        value = json.loads(LORA_METADATA.read_text(encoding="utf-8"))
    except (ValueError, UnicodeError):
        raise web.HTTPServiceUnavailable(text="LoRA 管理数据损坏，请先检查服务器上的元数据文件")
    if (not isinstance(value, dict) or
            not all(isinstance(value.get(key), dict) and
                    all(isinstance(entries, dict) and
                        all(isinstance(name, str) and isinstance(label, str) for name, label in entries.items())
                        for entries in value[key].values()) for key in ("groups", "aliases"))):
        raise web.HTTPServiceUnavailable(text="LoRA 管理数据格式无效，请先检查服务器上的元数据文件")
    return value


def save_lora_metadata(value):
    LORA_METADATA.parent.mkdir(parents=True, exist_ok=True)
    temporary = LORA_METADATA.with_name(f".{LORA_METADATA.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, LORA_METADATA)
    finally:
        temporary.unlink(missing_ok=True)


def catalog():
    result = {}
    groups = lora_metadata()["groups"]
    for key, family in FAMILIES.items():
        root = family["model_directory"]
        lora_root = family["directory"] / "loras"
        loras = files_in(lora_root)
        for entry in loras:
            entry["group"] = groups.get(key, {}).get(entry["name"], "")
            entry["manageable"] = not (lora_root / entry["name"]).is_symlink()
        result[key] = {
            "label": family["label"],
            "defaults": family["defaults"],
            "models": files_in(root / "diffusion_models"),
            "encoders": files_in(root / "text_encoders"),
            "vaes": files_in(root / "vae"),
            "loras": loras,
        }
    return result


def chosen_name(value, entries, label):
    names = {entry["name"] for entry in entries}
    if value not in names:
        raise web.HTTPBadRequest(text=f"{label} 不在可用列表中")
    return value


def integer(value, label, minimum, maximum):
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise web.HTTPBadRequest(text=f"{label} 必须是整数")
    if not minimum <= number <= maximum:
        raise web.HTTPBadRequest(text=f"{label} 必须在 {minimum}–{maximum} 之间")
    return number


def decimal(value, label, minimum, maximum):
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise web.HTTPBadRequest(text=f"{label} 必须是数字")
    if not minimum <= number <= maximum or number != number:
        raise web.HTTPBadRequest(text=f"{label} 必须在 {minimum}–{maximum} 之间")
    return number


def build_workflow(config, available, samplers, schedulers):
    family_key = config.get("family")
    if family_key not in FAMILIES:
        raise web.HTTPBadRequest(text="请选择可用的模型系列")
    family = FAMILIES[family_key]
    options = available[family_key]
    model = chosen_name(config.get("model"), options["models"], "基座模型")
    encoder = chosen_name(config.get("encoder"), options["encoders"], "文本编码器")
    vae = chosen_name(config.get("vae"), options["vaes"], "VAE")
    prompt = str(config.get("prompt", "")).strip()
    if not prompt:
        raise web.HTTPBadRequest(text="请输入文本提示")
    if len(prompt) > 12000:
        raise web.HTTPBadRequest(text="文本提示过长")
    negative = str(config.get("negative", "")).strip()
    if len(negative) > 12000:
        raise web.HTTPBadRequest(text="负面提示过长")
    width = integer(config.get("width", 1024), "宽度", 256, 4096)
    height = integer(config.get("height", 1024), "高度", 256, 4096)
    if width % 16 or height % 16:
        raise web.HTTPBadRequest(text="宽度和高度需为 16 的倍数")
    steps = integer(config.get("steps", family["defaults"]["steps"]), "步数", 1, 150)
    cfg = decimal(config.get("cfg", family["defaults"]["cfg"]), "提示词引导", 0, 30)
    sampler = config.get("sampler", family["defaults"]["sampler"])
    scheduler = config.get("scheduler", family["defaults"]["scheduler"])
    if sampler not in samplers or scheduler not in schedulers:
        raise web.HTTPBadRequest(text="采样器或调度方式不可用")
    seed_value = config.get("seed", -1)
    seed = secrets.randbelow(2**53) if str(seed_value) == "-1" else integer(seed_value, "随机种子", 0, 2**53 - 1)
    reference = config.get("reference")
    if reference is not None:
        if not isinstance(reference, str) or not reference.startswith("studio_") or "/" in reference or "\\" in reference:
            raise web.HTTPBadRequest(text="参考图名称无效，请重新上传")
        denoise = decimal(config.get("denoise", 0.65), "参考图变化强度", 0.01, 1)
    else:
        denoise = 1

    graph = {}
    next_id = 0

    def add(class_type, inputs):
        nonlocal next_id
        next_id += 1
        node_id = str(next_id)
        graph[node_id] = {"class_type": class_type, "inputs": inputs}
        return [node_id, 0]

    model_ref = add("UNETLoader", {"unet_name": model, "weight_dtype": "default"})
    clip_ref = add("CLIPLoader", {"clip_name": encoder, "type": family["clip_type"], "device": "default"})
    vae_ref = add("VAELoader", {"vae_name": vae})
    positive = add("CLIPTextEncode", {"clip": clip_ref, "text": prompt})
    if family_key == "krea2":
        negative_ref = add("ConditioningZeroOut", {"conditioning": positive})
    else:
        negative_ref = add("CLIPTextEncode", {"clip": clip_ref, "text": negative})
    if reference:
        image = add("LoadImage", {"image": reference})
        latent = add("VAEEncode", {"pixels": image, "vae": vae_ref})
    else:
        latent = add("EmptyLatentImage", {"width": width, "height": height, "batch_size": 1})

    loras = config.get("loras", [])
    if not isinstance(loras, list) or len(loras) > 16:
        raise web.HTTPBadRequest(text="LoRA 配置无效，最多使用 16 个")
    for item in loras:
        if not isinstance(item, dict):
            raise web.HTTPBadRequest(text="LoRA 配置无效")
        name = chosen_name(item.get("name"), options["loras"], "LoRA")
        strength = decimal(item.get("strength", 1), "LoRA 强度", -4, 4)
        model_ref = add("LoraLoaderModelOnly", {"model": model_ref, "lora_name": name, "strength_model": strength})

    samples = add("KSampler", {
        "model": model_ref, "positive": positive, "negative": negative_ref,
        "latent_image": latent, "seed": seed, "steps": steps, "cfg": cfg,
        "sampler_name": sampler, "scheduler": scheduler, "denoise": denoise,
    })
    image = add("VAEDecode", {"samples": samples, "vae": vae_ref})
    add("SaveImage", {"images": image, "filename_prefix": f"Studio/{family_key}"})
    add("PreviewImage", {"images": image})
    return graph, seed


async def comfy_json(request, method, path, **kwargs):
    async with request.app["comfy_session"].request(method, COMFY + path, **kwargs) as response:
        body = await response.text()
        if response.status >= 400:
            raise web.HTTPBadGateway(text=f"ComfyUI 返回 {response.status}: {body[:700]}")
        return json.loads(body)


@web.middleware
async def errors(request, handler):
    if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        origin = request.headers.get("Origin")
        local_origin = f"http://{request.host}" if request.host.startswith("127.0.0.1:") else None
        if origin and origin not in {PUBLIC_ORIGIN, local_origin}:
            return web.json_response({"error": "请求来源不匹配"}, status=403)
    try:
        return await handler(request)
    except web.HTTPException as exc:
        if request.path.startswith("/api/"):
            return web.json_response({"error": exc.text}, status=exc.status)
        raise
    except (ClientError, OSError, asyncio.TimeoutError) as exc:
        return web.json_response({"error": f"生成服务暂不可用：{exc}"}, status=502)


async def get_catalog(request):
    info = await comfy_json(request, "GET", "/object_info/KSampler")
    required = info["KSampler"]["input"]["required"]
    return web.json_response({
        "families": catalog(),
        "samplers": required["sampler_name"][0],
        "schedulers": required["scheduler"][0],
    })


def safe_filename(name):
    if (not isinstance(name, str) or not name or name != Path(name).name or "\\" in name or "/" in name
            or name.startswith(".") or len(name) > 180 or any(ord(char) < 32 or ord(char) == 127 for char in name)):
        raise web.HTTPBadRequest(text="文件名无效")
    return name


def lora_filename(name):
    name = safe_filename(name)
    if not name.lower().endswith(".safetensors"):
        raise web.HTTPBadRequest(text="LoRA 文件名必须以 .safetensors 结尾")
    return name


def lora_target(family_key, name):
    if family_key not in FAMILIES:
        raise web.HTTPBadRequest(text="模型系列无效")
    directory = FAMILIES[family_key]["directory"] / "loras"
    path = directory / lora_filename(name)
    if path.is_symlink():
        raise web.HTTPForbidden(text="不能管理符号链接 LoRA")
    if not path.is_file():
        raise web.HTTPNotFound(text="LoRA 文件不存在，请刷新列表")
    return path


def lora_group(value):
    if not isinstance(value, str):
        raise web.HTTPBadRequest(text="分组名称无效")
    group = value.strip()
    if len(group) > 60 or any(ord(char) < 32 or ord(char) == 127 for char in group):
        raise web.HTTPBadRequest(text="分组名称最多 60 字，不能包含控制字符")
    return group


async def require_idle_comfy(request):
    queue = await comfy_json(request, "GET", "/queue")
    if not isinstance(queue, dict):
        raise web.HTTPBadGateway(text="无法确认 ComfyUI 队列状态，未修改 LoRA")
    if queue.get("queue_running") or queue.get("queue_pending"):
        raise web.HTTPConflict(text="ComfyUI 正在运行或排队生成任务；完成后才能重命名或删除 LoRA")


async def lora_command(request):
    if request.content_length is not None and request.content_length > 4096:
        raise web.HTTPRequestEntityTooLarge(max_size=4096, actual_size=request.content_length)
    raw = await request.content.read(4097)
    if len(raw) > 4096:
        raise web.HTTPRequestEntityTooLarge(max_size=4096, actual_size=len(raw))
    try:
        data = json.loads(raw)
    except (ValueError, UnicodeError):
        raise web.HTTPBadRequest(text="LoRA 操作参数不是有效 JSON")
    if not isinstance(data, dict):
        raise web.HTTPBadRequest(text="LoRA 操作参数无效")
    async with request.app["lora_lock"]:
        return await apply_lora_command(request, data)


async def apply_lora_command(request, data):
    family_key = data.get("family")
    name = data.get("name")
    path = lora_target(family_key, name)
    metadata = lora_metadata()
    groups = metadata["groups"].setdefault(family_key, {})
    aliases = metadata["aliases"].setdefault(family_key, {})
    if request.method == "DELETE":
        if data.get("confirm_name") != name:
            raise web.HTTPBadRequest(text="请确认要删除的 LoRA 文件名")
        await require_idle_comfy(request)
        path.unlink()
        groups.pop(name, None)
        metadata["aliases"][family_key] = {old: new for old, new in aliases.items() if old != name and new != name}
        save_lora_metadata(metadata)
        return web.json_response({"deleted": name, "family": family_key})
    if "new_name" not in data and "group" not in data:
        raise web.HTTPBadRequest(text="没有需要保存的变更")
    if "new_name" in data and not isinstance(data["new_name"], str):
        raise web.HTTPBadRequest(text="LoRA 文件名无效")
    new_name = lora_filename(data["new_name"].strip()) if "new_name" in data else name
    group = lora_group(data["group"]) if "group" in data else groups.get(name, "")
    destination = path.with_name(new_name)
    if new_name != name:
        if destination.exists() or destination.is_symlink():
            raise web.HTTPConflict(text="同名 LoRA 已存在，不会覆盖")
        await require_idle_comfy(request)
        # No await between the last collision check and rename.
        if destination.exists() or destination.is_symlink():
            raise web.HTTPConflict(text="同名 LoRA 已存在，不会覆盖")
        path.rename(destination)
        for old, current in list(aliases.items()):
            if current == name:
                aliases[old] = new_name
        aliases[name] = new_name
        aliases.pop(new_name, None)
        groups.pop(name, None)
    if group:
        groups[new_name] = group
    else:
        groups.pop(new_name, None)
    try:
        save_lora_metadata(metadata)
    except OSError:
        if new_name != name:
            destination.rename(path)
        raise
    return web.json_response({"name": new_name, "group": group, "family": family_key})


def validate_safetensors(path):
    try:
        with safe_open(str(path), framework="pt", device="cpu") as file:
            if not file.keys():
                raise web.HTTPBadRequest(text="LoRA 文件没有权重")
    except SafetensorError:
        raise web.HTTPBadRequest(text="LoRA 不是有效的 safetensors 文件")


async def upload_lora(request):
    reader = await request.multipart()
    field = await reader.next()
    if field is None or field.name != "family":
        raise web.HTTPBadRequest(text="缺少模型系列")
    family_key = (await field.text()).strip()
    if family_key not in FAMILIES:
        raise web.HTTPBadRequest(text="模型系列无效")
    field = await reader.next()
    if field is None or field.name != "file":
        raise web.HTTPBadRequest(text="请选择 LoRA 文件")
    name = safe_filename(field.filename)
    if not name.lower().endswith(".safetensors"):
        raise web.HTTPBadRequest(text="仅支持 .safetensors LoRA 文件")
    directory = FAMILIES[family_key]["directory"] / "loras"
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / name
    if destination.exists():
        raise web.HTTPConflict(text="同名 LoRA 已存在，请先在列表中选择")
    descriptor, temporary_name = tempfile.mkstemp(prefix=".studio-upload-", dir=directory)
    os.close(descriptor)
    temporary = Path(temporary_name)
    total = 0
    try:
        with temporary.open("wb") as output:
            while chunk := await field.read_chunk(1024**2):
                total += len(chunk)
                if total > MAX_LORA:
                    raise web.HTTPRequestEntityTooLarge(max_size=MAX_LORA, actual_size=total)
                output.write(chunk)
        validate_safetensors(temporary)
        if destination.exists():
            raise web.HTTPConflict(text="同名 LoRA 已存在")
        temporary.rename(destination)
    finally:
        temporary.unlink(missing_ok=True)
    return web.json_response({"name": name, "bytes": total, "family": family_key})


async def upload_reference(request):
    reader = await request.multipart()
    field = await reader.next()
    if field is None or field.name != "file":
        raise web.HTTPBadRequest(text="请选择参考图")
    original = safe_filename(field.filename)
    suffix = Path(original).suffix.lower()
    if suffix not in {".png", ".jpg", ".jpeg", ".webp"}:
        raise web.HTTPBadRequest(text="参考图仅支持 PNG、JPG 或 WebP")
    content = bytearray()
    while chunk := await field.read_chunk(1024**2):
        content.extend(chunk)
        if len(content) > MAX_REFERENCE:
            raise web.HTTPRequestEntityTooLarge(max_size=MAX_REFERENCE, actual_size=len(content))
    name = f"studio_ref_{uuid.uuid4().hex}{suffix}"
    form = FormData()
    form.add_field("image", bytes(content), filename=name, content_type=field.headers.get("Content-Type", "application/octet-stream"))
    result = await comfy_json(request, "POST", "/upload/image", data=form)
    return web.json_response({"name": result["name"]})


async def prepare_workflow(request):
    config = await request.json()
    info = await comfy_json(request, "GET", "/object_info/KSampler")
    required = info["KSampler"]["input"]["required"]
    graph, seed = build_workflow(config, catalog(), required["sampler_name"][0], required["scheduler"][0])
    return graph, seed


async def preview_workflow(request):
    graph, seed = await prepare_workflow(request)
    return web.json_response({"workflow": graph, "seed": seed})


def progress_view(record):
    return {key: record[key] for key in ("stage", "step", "total")}


def apply_progress_event(record, event):
    data = event.get("data")
    if not isinstance(data, dict):
        return
    event_type = event.get("type")
    if event_type == "execution_start":
        record["stage"] = "loading"
    elif event_type == "executing":
        node = data.get("node")
        if node is None:
            record["stage"] = "finishing"
        else:
            node_type = record["node_types"].get(str(node))
            record["stage"] = {
                "UNETLoader": "loading", "CLIPLoader": "loading", "VAELoader": "loading",
                "LoraLoaderModelOnly": "loading", "CLIPTextEncode": "encoding",
                "ConditioningZeroOut": "encoding", "LoadImage": "encoding",
                "VAEEncode": "encoding", "EmptyLatentImage": "encoding",
                "KSampler": "sampling", "VAEDecode": "decoding",
                "SaveImage": "saving", "PreviewImage": "saving",
            }.get(node_type, "loading")
    elif event_type == "progress" and record["node_types"].get(str(data.get("node"))) == "KSampler":
        try:
            step, total = int(data["value"]), int(data["max"])
        except (KeyError, TypeError, ValueError):
            return
        if total > 0:
            record["stage"] = "sampling"
            record["step"] = max(0, min(step, total))
            record["total"] = total
    elif event_type == "execution_success":
        record["stage"] = "finishing"
    elif event_type == "execution_error":
        record["stage"] = "error"
        record["error"] = str(data.get("exception_message") or "ComfyUI 执行失败")[:700]


async def watch_progress(app, prompt_id, socket):
    record = app["job_progress"][prompt_id]
    try:
        async for message in socket:
            if message.type != WSMsgType.TEXT:
                continue
            try:
                event = json.loads(message.data)
            except json.JSONDecodeError:
                continue
            if not isinstance(event, dict):
                continue
            data = event.get("data")
            if not isinstance(data, dict) or data.get("prompt_id") != prompt_id:
                continue
            apply_progress_event(record, event)
            if record["stage"] in {"finishing", "error"}:
                break
    except (ClientError, OSError, asyncio.TimeoutError):
        pass  # History polling still reports completion if the progress socket drops.
    finally:
        await socket.close()


async def generate(request):
    graph, seed = await prepare_workflow(request)
    token = uuid.uuid4().hex
    reference = next((node["inputs"]["image"] for node in graph.values()
                      if node["class_type"] == "LoadImage"), None)
    for node_id, node in list(graph.items()):
        if node["class_type"] == "PreviewImage":
            del graph[node_id]  # SaveImage is sufficient; avoid ComfyUI temp previews.
        elif node["class_type"] == "SaveImage":
            node["inputs"]["filename_prefix"] = f"Studio/studiojob_{token}"
    client_id = str(uuid.uuid4())
    try:
        socket = await asyncio.wait_for(
            request.app["comfy_session"].ws_connect(f"{COMFY}/ws?clientId={client_id}", heartbeat=30),
            timeout=5,
        )
    except (ClientError, OSError, asyncio.TimeoutError):
        socket = None  # Generation remains available with an indeterminate progress indicator.
    try:
        result = await comfy_json(request, "POST", "/prompt", json={"prompt": graph, "client_id": client_id})
    except BaseException:
        if socket is not None:
            await socket.close()
        raise
    if "error" in result:
        if socket is not None:
            await socket.close()
        return web.json_response({"error": result["error"], "node_errors": result.get("node_errors", {})}, status=400)
    prompt_id = result["prompt_id"]
    MANAGED_JOBS.mkdir(parents=True, exist_ok=True)
    manifest = {"token": token, "reference": reference, "created": time.time()}
    temporary = MANAGED_JOBS / f".{prompt_id}.{uuid.uuid4().hex}.tmp"
    temporary.write_text(json.dumps(manifest), encoding="utf-8")
    os.replace(temporary, MANAGED_JOBS / f"{prompt_id}.json")
    for old_id, record in list(request.app["job_progress"].items()):
        if time.monotonic() - record["created"] > 4 * 3600:
            request.app["job_progress"].pop(old_id, None)
            task = request.app["progress_tasks"].pop(old_id, None)
            if task is not None:
                task.cancel()
    sampler = next(node for node in graph.values() if node["class_type"] == "KSampler")
    request.app["job_progress"][prompt_id] = {
        "stage": "queued", "step": 0, "total": sampler["inputs"]["steps"],
        "node_types": {node_id: node["class_type"] for node_id, node in graph.items()},
        "created": time.monotonic(),
    }
    if socket is not None:
        request.app["progress_tasks"][prompt_id] = asyncio.create_task(watch_progress(request.app, prompt_id, socket))
    return web.json_response({"prompt_id": prompt_id, "seed": seed})


def managed_manifest(prompt_id):
    try:
        uuid.UUID(prompt_id)
    except ValueError:
        raise web.HTTPBadRequest(text="任务编号无效")
    path = MANAGED_JOBS / f"{prompt_id}.json"
    if not path.is_file():
        raise web.HTTPNotFound(text="该任务没有待清理的临时文件")
    record = json.loads(path.read_text(encoding="utf-8"))
    if not JOB_TOKEN.fullmatch(record.get("token", "")):
        raise web.HTTPInternalServerError(text="任务清理记录无效")
    return path, record


async def remove_managed_files(app, prompt_id, path, record):
    token = record["token"]
    for output in OUTPUT_DIR.glob(f"studiojob_{token}_*.png"):
        output.unlink(missing_ok=True)
    reference = record.get("reference")
    if isinstance(reference, str) and REFERENCE_NAME.fullmatch(reference):
        (INPUT_DIR / reference).unlink(missing_ok=True)
    async with app["comfy_session"].post(f"{COMFY}/history", json={"delete": [prompt_id]}) as response:
        if response.status >= 400:
            raise web.HTTPBadGateway(text="ComfyUI 未能清除该任务历史")
    path.unlink(missing_ok=True)
    app["job_progress"].pop(prompt_id, None)
    task = app["progress_tasks"].pop(prompt_id, None)
    if task is not None:
        task.cancel()


async def mark_saved(request):
    prompt_id = request.match_info["prompt_id"]
    path, record = managed_manifest(prompt_id)
    history = await comfy_json(request, "GET", f"/history/{prompt_id}")
    if prompt_id not in history:
        queue = await comfy_json(request, "GET", "/queue")
        active = {item[1] for key in ("queue_running", "queue_pending") for item in queue.get(key, [])}
        if prompt_id in active:
            raise web.HTTPConflict(text="任务尚未完成，不能清理生成文件")
    await remove_managed_files(request.app, prompt_id, path, record)
    return web.json_response({"removed": True})


async def sweep_managed_files(app):
    async with app["comfy_session"].get(f"{COMFY}/queue") as response:
        queue = await response.json()
        if response.status >= 400:
            return
    active = {item[1] for key in ("queue_running", "queue_pending") for item in queue.get(key, [])}
    now = time.time()
    for path in MANAGED_JOBS.glob("*.json"):
        prompt_id = path.stem
        try:
            _, record = managed_manifest(prompt_id)
        except (OSError, ValueError, KeyError, web.HTTPException):
            continue
        outputs = OUTPUT_DIR.glob(f"studiojob_{record['token']}_*.png")
        last_activity = max((item.stat().st_mtime for item in outputs), default=path.stat().st_mtime)
        if prompt_id in active or now - last_activity < TEMP_RETENTION_SECONDS:
            continue
        try:
            await remove_managed_files(app, prompt_id, path, record)
        except (OSError, ValueError, KeyError, web.HTTPException, ClientError):
            continue
    # Handles uploads that never reached /api/generate and output files left by
    # a service restart between ComfyUI accepting a job and recording its ID.
    retained_refs = set()
    retained_tokens = set()
    for manifest_path in MANAGED_JOBS.glob("*.json"):
        try:
            record = json.loads(manifest_path.read_text(encoding="utf-8"))
            retained_tokens.add(record.get("token"))
            retained_refs.add(record.get("reference"))
        except (OSError, ValueError):
            continue
    for directory, pattern in ((INPUT_DIR, "studio_ref_*"), (OUTPUT_DIR, "studiojob_*.png")):
        for path in directory.glob(pattern):
            if now - path.stat().st_mtime < TEMP_RETENTION_SECONDS:
                continue
            if directory == INPUT_DIR and not REFERENCE_NAME.fullmatch(path.name):
                continue
            if directory == OUTPUT_DIR and not re.fullmatch(r"studiojob_[0-9a-f]{32}_[0-9]+_\.png", path.name):
                continue
            if directory == INPUT_DIR and path.name in retained_refs:
                continue
            if directory == OUTPUT_DIR and path.name[10:42] in retained_tokens:
                continue
            path.unlink(missing_ok=True)


async def cleanup_loop(app):
    while True:
        try:
            await sweep_managed_files(app)
        except (OSError, ClientError, asyncio.TimeoutError):
            pass
        await asyncio.sleep(300)


async def job(request):
    prompt_id = request.match_info["prompt_id"]
    try:
        uuid.UUID(prompt_id)
    except ValueError:
        raise web.HTTPBadRequest(text="任务编号无效")
    history = await comfy_json(request, "GET", f"/history/{prompt_id}")
    progress = request.app["job_progress"].get(prompt_id)
    if prompt_id not in history:
        if progress is not None and progress["stage"] == "error":
            return web.json_response({"state": "error", "error": progress.get("error"), "progress": progress_view(progress)})
        return web.json_response({"state": "running", "progress": progress_view(progress) if progress else None})
    record = history[prompt_id]
    images = []
    for output in record.get("outputs", {}).values():
        for item in output.get("images", []):
            if item.get("type") == "output":
                images.append({"filename": item["filename"], "subfolder": item.get("subfolder", "")})
    messages = record.get("status", {}).get("messages", [])
    failed = record.get("status", {}).get("status_str") == "error"
    error = next((entry[1].get("exception_message") for entry in messages if entry[0] == "execution_error"), None)
    if progress is not None:
        progress["stage"] = "error" if failed else "done"
        task = request.app["progress_tasks"].pop(prompt_id, None)
        if task is not None:
            task.cancel()
    return web.json_response({"state": "error" if failed else "done", "images": images, "error": error,
                              "progress": progress_view(progress) if progress else None})


async def image(request):
    filename = request.query.get("filename", "")
    subfolder = request.query.get("subfolder", "")
    if not filename or filename != Path(filename).name or "/" in filename or "\\" in filename or subfolder != "Studio":
        raise web.HTTPBadRequest(text="图片路径无效")
    query = urlencode({"filename": filename, "subfolder": subfolder, "type": "output"})
    async with request.app["comfy_session"].get(f"{COMFY}/view?{query}") as response:
        if response.status != 200:
            raise web.HTTPNotFound(text="生成图片不存在")
        return web.Response(body=await response.read(), content_type=response.content_type,
                            headers={"Cache-Control": "private, max-age=86400"})


async def index(request):
    return web.FileResponse(ROOT / "static" / "index.html", headers={"Content-Security-Policy": "frame-ancestors 'self'"})


async def app_script(request):
    return web.FileResponse(ROOT / "static" / "app.js")


async def templates_script(request):
    return web.FileResponse(ROOT / "static" / "templates.js")


async def stylesheet(request):
    return web.FileResponse(ROOT / "static" / "styles.css")


async def prompts_stylesheet(request):
    return web.FileResponse(ROOT / "static" / "prompts.css")


async def lora_manager_stylesheet(request):
    return web.FileResponse(ROOT / "static" / "lora-manager.css")


async def templates_page(request):
    return web.FileResponse(ROOT / "static" / "templates.html", headers={"Content-Security-Policy": "frame-ancestors 'self'"})


async def prompts_page(request):
    return web.FileResponse(ROOT / "static" / "prompts.html", headers={"Content-Security-Policy": "frame-ancestors 'self'"})


async def prompts_script(request):
    return web.FileResponse(ROOT / "static" / "prompts.js")


async def prompts_data(request):
    path = ROOT / "static" / "prompts.json"
    if not path.is_file():
        return web.json_response({"sources": [], "tags": [], "templates": []})
    return web.FileResponse(path)


async def prompt_licenses(request):
    path = ROOT / "static" / "prompt-licenses.txt"
    if not path.is_file():
        return web.Response(text="No prompt library data is bundled.", content_type="text/plain")
    return web.FileResponse(path)


async def templates_list(request):
    available = catalog()
    aliases = lora_metadata()["aliases"]
    result = []
    for template in TEMPLATES:
        family = available[template["family"]]
        config = dict(template["config"])
        installed = {file["name"] for file in family["loras"]}
        config["loras"] = [
            {**item, "name": item["name"] if item["name"] in installed else
             aliases.get(template["family"], {}).get(item["name"], item["name"])}
            for item in config["loras"]
        ]
        model_ready = config["model"] in {item["name"] for item in family["models"]}
        loras_ready = all(item["name"] in installed for item in config["loras"])
        result.append({key: value for key, value in template.items() if key != "source_file"} |
                      {"config": config, "ready": model_ready and loras_ready,
                       "has_source": template["source_file"] is not None})
    return web.json_response(result)


async def template_source(request):
    template = next((item for item in TEMPLATES if item["id"] == request.match_info["template_id"]), None)
    if template is None or template["source_file"] is None or not template["source_file"].is_file():
        raise web.HTTPNotFound(text="模板源文件不存在")
    return web.FileResponse(template["source_file"], headers={
        "Content-Disposition": f'attachment; filename="{template["id"]}-comfyui.json"'
    })


async def health(request):
    await comfy_json(request, "GET", "/system_stats")
    return web.json_response({"ok": True})


async def session_context(app):
    app["comfy_session"] = ClientSession(timeout=ClientTimeout(total=3600))
    app["job_progress"] = {}
    app["progress_tasks"] = {}
    MANAGED_JOBS.mkdir(parents=True, exist_ok=True)
    sweeper = asyncio.create_task(cleanup_loop(app))
    yield
    sweeper.cancel()
    await asyncio.gather(sweeper, return_exceptions=True)
    for task in app["progress_tasks"].values():
        task.cancel()
    await asyncio.gather(*app["progress_tasks"].values(), return_exceptions=True)
    await app["comfy_session"].close()


def create_app():
    app = web.Application(middlewares=[errors], client_max_size=MAX_LORA + 1024**2)
    app["lora_lock"] = asyncio.Lock()
    app.cleanup_ctx.append(session_context)
    app.router.add_get("/", index)
    app.router.add_get("/templates", templates_page)
    app.router.add_get("/prompts", prompts_page)
    app.router.add_get("/app.js", app_script)
    app.router.add_get("/templates.js", templates_script)
    app.router.add_get("/prompts.js", prompts_script)
    app.router.add_get("/prompts.json", prompts_data)
    app.router.add_get("/prompt-licenses.txt", prompt_licenses)
    app.router.add_get("/styles.css", stylesheet)
    app.router.add_get("/prompts.css", prompts_stylesheet)
    app.router.add_get("/lora-manager.css", lora_manager_stylesheet)
    app.router.add_get("/api/health", health)
    app.router.add_get("/api/catalog", get_catalog)
    app.router.add_get("/api/templates", templates_list)
    app.router.add_get("/api/templates/{template_id}/source", template_source)
    app.router.add_post("/api/loras", upload_lora)
    app.router.add_patch("/api/loras", lora_command)
    app.router.add_delete("/api/loras", lora_command)
    app.router.add_post("/api/reference", upload_reference)
    app.router.add_post("/api/workflow", preview_workflow)
    app.router.add_post("/api/generate", generate)
    app.router.add_get("/api/jobs/{prompt_id}", job)
    app.router.add_post("/api/jobs/{prompt_id}/saved", mark_saved)
    app.router.add_get("/api/image", image)
    return app


if __name__ == "__main__":
    web.run_app(create_app(), host="127.0.0.1", port=8189)
