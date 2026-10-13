const $ = (id) => document.getElementById(id);

let library;
let family = "anima";
let referenceFile = null;
let referenceUrl = null;
let busy = false;
let uploading = false;
let managing = false;
let managedLora = null;
let batchActive = false;
let uploadHideTimer = null;
let outputDirectory = null;
let pendingJob = null;
let localImagesSaved = false;
const resultUrls = [];
const renderedFilenames = new Set();
const choices = { anima: {}, krea2: {} };

function status(message, kind = "") {
  $("status").textContent = message;
  $("status").className = `status ${kind}`;
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const type = response.headers.get("content-type") || "";
  const body = type.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) throw new Error(body.error || body || `请求失败（${response.status}）`);
  return body;
}

function uploadRequest(path, form, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.upload.addEventListener("progress", (event) => {
      onProgress(event.loaded, event.lengthComputable ? event.total : null);
    });
    xhr.upload.addEventListener("load", () => {
      $("uploadDetail").textContent = "数据已发送，服务器正在校验并保存文件…";
    });
    xhr.addEventListener("load", () => {
      let body;
      try { body = JSON.parse(xhr.responseText); } catch { body = xhr.responseText; }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(body?.error || body || `上传失败（${xhr.status}）`));
      } else resolve(body);
    });
    xhr.addEventListener("error", () => reject(new Error("网络连接中断，上传未完成。")));
    xhr.addEventListener("abort", () => reject(new Error("上传已中断。")));
    xhr.open("POST", path);
    xhr.send(form);
  });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function beginUpload(label) {
  clearTimeout(uploadHideTimer);
  $("uploadProgress").hidden = false;
  $("uploadTitle").textContent = label;
  $("uploadPercent").textContent = "0%";
  $("uploadFill").style.width = "0%";
  $("uploadTrack").classList.remove("indeterminate");
  $("uploadTrack").setAttribute("aria-valuenow", "0");
  $("uploadDetail").textContent = "开始上传；切换站内页面不会中断。";
  updateOverlayStatus();
}

function updateUpload(loaded, total) {
  if (total > 0) {
    $("uploadTrack").classList.remove("indeterminate");
    const percent = Math.max(0, Math.min(100, Math.round(loaded / total * 100)));
    $("uploadPercent").textContent = `${percent}%`;
    $("uploadFill").style.width = `${percent}%`;
    $("uploadTrack").setAttribute("aria-valuenow", String(percent));
    $("uploadDetail").textContent = `${formatBytes(loaded)} / ${formatBytes(total)} 已发送；请保持标签页打开。`;
  } else {
    $("uploadTrack").classList.add("indeterminate");
    $("uploadPercent").textContent = "上传中";
    $("uploadTrack").removeAttribute("aria-valuenow");
    $("uploadDetail").textContent = `${formatBytes(loaded)} 已发送；请保持标签页打开。`;
  }
  updateOverlayStatus();
}

function finishUpload(message, error = false) {
  $("uploadTitle").textContent = error ? "上传失败" : "上传完成";
  $("uploadPercent").textContent = error ? "未完成" : "100%";
  if (!error) {
    $("uploadTrack").classList.remove("indeterminate");
    $("uploadFill").style.width = "100%";
    $("uploadTrack").setAttribute("aria-valuenow", "100");
  }
  $("uploadDetail").textContent = message;
  updateOverlayStatus();
  uploadHideTimer = setTimeout(() => { $("uploadProgress").hidden = true; }, 6000);
}

function navigationProtected() { return busy || uploading || managing; }

function updateOverlayStatus() {
  if (uploading) {
    $("backgroundPageStatus").textContent = `${$("uploadTitle").textContent} · ${$("uploadPercent").textContent}，任务在创作页继续`;
  } else if (busy) {
    $("backgroundPageStatus").textContent = "当前任务仍在创作页运行；可随时返回查看进度";
  } else {
    $("backgroundPageStatus").textContent = "任务已结束；返回创作页查看结果";
  }
}

function openBackgroundPage(path) {
  $("backgroundPage").hidden = false;
  $("backgroundFrame").src = path;
  document.body.style.overflow = "hidden";
  updateOverlayStatus();
}

function closeBackgroundPage() {
  $("backgroundPage").hidden = true;
  $("backgroundFrame").src = "about:blank";
  document.body.style.overflow = "";
}

function applyFramedPrompt(message) {
  if (!library?.families[message.family] || typeof message.prompt !== "string") return;
  rememberChoices();
  family = message.family;
  renderSettings(true);
  $("prompt").value = message.prompt.slice(0, 12000);
  $("promptCount").textContent = `${$("prompt").value.length} / 12000`;
  closeBackgroundPage();
  if (!navigationProtected()) status("提示词已填入；可以继续生成。", "success");
}

function applyFramedTemplate(message) {
  const template = message.template;
  if (!template || !library?.families[template.family] || !template.config ||
      !Array.isArray(template.config.loras)) return;
  rememberChoices();
  family = template.family;
  choices[family].model = template.config.model;
  choices[family].presetApplied = true;
  choices[family].loras = {};
  for (const item of template.config.loras) {
    choices[family].loras[item.name] = { enabled: true, strength: item.strength };
  }
  renderSettings(true);
  $("steps").value = template.config.steps;
  $("cfg").value = template.config.cfg;
  $("sampler").value = template.config.sampler;
  $("scheduler").value = template.config.scheduler;
  if (template.config.denoise) $("denoise").value = template.config.denoise;
  $("denoiseValue").textContent = Number($("denoise").value).toFixed(2);
  closeBackgroundPage();
  if (!navigationProtected()) status(`已套用「${template.title}」。可以继续调整参数。`, "success");
}

function outputDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("canvas-studio-output", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("settings");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storedDirectory() {
  const db = await outputDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction("settings", "readonly").objectStore("settings").get("outputDirectory");
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

async function rememberDirectory(handle) {
  const db = await outputDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("settings", "readwrite");
      transaction.objectStore("settings").put(handle, "outputDirectory");
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { db.close(); }
}

async function updateDirectoryStatus() {
  const message = $("localSaveStatus");
  if (!window.showDirectoryPicker) {
    message.textContent = "此浏览器不支持选择本机文件夹；请使用最新版 Chrome 或 Edge。";
    $("generateButton").disabled = true;
    $("chooseOutputDir").disabled = true;
    return;
  }
  if (!outputDirectory) {
    message.textContent = "尚未选择本机目录。首次使用请在弹出的窗口中选 D:\\Deeplearning\\BSGetImg\\gen。";
    return;
  }
  const permission = await outputDirectory.queryPermission({ mode: "readwrite" });
  message.textContent = permission === "granted"
    ? `已授权文件夹「${outputDirectory.name}」；生成后自动写入本机。`
    : `记住了文件夹「${outputDirectory.name}」，生成时可能需要重新授权写入。`;
}

async function chooseDirectory() {
  try {
    const handle = await window.showDirectoryPicker({
      id: "canvas-studio-generated-images", mode: "readwrite",
      ...(outputDirectory ? { startIn: outputDirectory } : {}),
    });
    await rememberDirectory(handle);
    outputDirectory = handle;
    await updateDirectoryStatus();
    status(`已选择「${handle.name}」。请确认系统选择器中的完整路径是你需要的目录。`, "success");
  } catch (error) {
    if (error.name !== "AbortError") status(`无法选择本机目录：${error.message}`, "error");
  }
}

async function writableDirectory() {
  if (!outputDirectory) throw new Error("请先选择本机保存文件夹，再开始生成。");
  if (await outputDirectory.queryPermission({ mode: "readwrite" }) !== "granted" &&
      await outputDirectory.requestPermission({ mode: "readwrite" }) !== "granted") {
    throw new Error("未获得本机文件夹写入权限；请重新选择或授权后重试。");
  }
  return outputDirectory;
}

function optionList(select, files, preferred) {
  select.replaceChildren();
  for (const file of files) {
    const option = document.createElement("option");
    option.value = file.name;
    option.textContent = file.name;
    select.append(option);
  }
  if (files.some((item) => item.name === preferred)) select.value = preferred;
}

function rememberChoices() {
  if (!library) return;
  const state = choices[family];
  state.model = $("model").value;
  state.encoder = $("encoder").value;
  state.vae = $("vae").value;
  state.loras = {};
  for (const row of $("loraList").querySelectorAll(".lora-item")) {
    state.loras[row.dataset.name] = {
      enabled: row.querySelector("input[type=checkbox]").checked,
      strength: Number(row.querySelector("input[type=number]").value),
    };
  }
}

function renderFamilies() {
  $("familyChoices").replaceChildren();
  for (const [key, data] of Object.entries(library.families)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `family-choice ${key === family ? "selected" : ""}`;
    const title = document.createElement("strong");
    title.textContent = data.label;
    const count = document.createElement("span");
    count.textContent = `${data.models.length} 个基座 · ${data.loras.length} 个 LoRA`;
    button.append(title, count);
    button.addEventListener("click", () => {
      if (key === family) return;
      rememberChoices();
      family = key;
      renderSettings(true);
    });
    $("familyChoices").append(button);
  }
}

function renderLoras() {
  const list = $("loraList");
  list.replaceChildren();
  const files = library.families[family].loras;
  if (!files.length) {
    const empty = document.createElement("p");
    empty.className = "lora-empty";
    empty.textContent = "此系列尚无 LoRA。可在下面上传 .safetensors 文件。";
    list.append(empty);
    return;
  }
  const ordered = [...files].sort((a, b) =>
    (a.group || "未分组").localeCompare(b.group || "未分组", "zh-CN") || a.name.localeCompare(b.name));
  let previousGroup = null;
  for (const file of ordered) {
    const group = file.group || "未分组";
    if (group !== previousGroup) {
      const heading = document.createElement("h4");
      heading.className = "lora-group-heading";
      heading.textContent = group;
      list.append(heading);
      previousGroup = group;
    }
    const saved = choices[family].loras?.[file.name];
    const recommended = 0.8;
    const row = document.createElement("div");
    row.className = "lora-item";
    row.dataset.name = file.name;
    const label = document.createElement("label");
    label.className = "lora-toggle";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = saved ? saved.enabled : false;
    const name = document.createElement("span");
    name.textContent = file.name.replace(/\.safetensors$/i, "");
    name.title = file.name;
    label.append(checkbox, name);
    const strength = document.createElement("input");
    strength.type = "number";
    strength.min = "-4";
    strength.max = "4";
    strength.step = "0.05";
    strength.value = String(saved?.strength ?? recommended);
    strength.title = `${file.name} 的 LoRA 强度`;
    strength.setAttribute("aria-label", `${file.name} 的 LoRA 强度`);
    checkbox.addEventListener("change", () => row.classList.toggle("is-off", !checkbox.checked));
    row.classList.toggle("is-off", !checkbox.checked);
    row.append(label, strength);
    if (file.manageable) {
      const manage = document.createElement("button");
      manage.type = "button";
      manage.className = "lora-manage";
      manage.textContent = "管理";
      manage.setAttribute("aria-label", `管理 ${file.name}`);
      manage.disabled = navigationProtected();
      manage.addEventListener("click", () => openLoraManager(file));
      row.append(manage);
    }
    list.append(row);
  }
}

function openLoraManager(file) {
  if (navigationProtected() || !file.manageable) return;
  managedLora = { family, name: file.name };
  $("loraManageName").value = file.name;
  $("loraManageGroup").value = file.group || "";
  $("loraManagerInfo").textContent = `${library.families[family].label} · ${formatBytes(file.bytes)} · ${file.name}`;
  $("loraManagerWarning").textContent = "重命名或删除会影响引用旧文件名的外部工作流；站内模板会跟随重命名，删除后相关模板将不可用。生成队列有任务时禁止重命名或删除。";
  $("loraManagerStatus").textContent = "";
  $("loraGroupNames").replaceChildren();
  const groups = [...new Set(library.families[family].loras.map((item) => item.group).filter(Boolean))];
  for (const group of groups) {
    const option = document.createElement("option");
    option.value = group;
    $("loraGroupNames").append(option);
  }
  $("loraManager").showModal();
}

async function changeLora(remove = false) {
  if (!managedLora || managing) return;
  const selected = managedLora;
  const newName = $("loraManageName").value.trim();
  const group = $("loraManageGroup").value.trim();
  if (!remove && (!newName.toLowerCase().endsWith(".safetensors") || !newName)) {
    $("loraManagerStatus").textContent = "文件名必须以 .safetensors 结尾。";
    return;
  }
  if (remove && !window.confirm(`确定删除 ${selected.name} 吗？此操作不可撤销，相关外部工作流可能失效。`)) return;
  rememberChoices();
  managing = true;
  setBusy(busy);
  $("loraManagerStatus").textContent = remove ? "正在删除文件…" : "正在保存更改…";
  try {
    const result = await api("/api/loras", {
      method: remove ? "DELETE" : "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(remove ? { ...selected, confirm_name: selected.name } :
        { ...selected, new_name: newName, group }),
    });
    const saved = choices[selected.family].loras?.[selected.name];
    delete choices[selected.family].loras[selected.name];
    if (!remove && saved) choices[selected.family].loras[result.name] = saved;
    library = await api("/api/catalog");
    renderSettings();
    $("loraManager").close();
    managedLora = null;
    $("uploadStatus").textContent = remove ? `已删除 ${selected.name}。` : `已保存 ${result.name} 的名称与分组。`;
  } catch (error) {
    $("loraManagerStatus").textContent = error.message;
  } finally {
    managing = false;
    setBusy(busy);
  }
}

function renderSettings(useDefaults = false) {
  renderFamilies();
  const data = library.families[family];
  const selected = choices[family];
  optionList($("model"), data.models, selected.model || data.models[0]?.name || "");
  optionList($("encoder"), data.encoders, selected.encoder);
  optionList($("vae"), data.vaes, selected.vae);
  renderLoras();
  if (useDefaults) {
    $("steps").value = data.defaults.steps;
    $("cfg").value = data.defaults.cfg;
  }
  optionList($("sampler"), library.samplers.map((name) => ({ name })), useDefaults ? data.defaults.sampler : $("sampler").value || data.defaults.sampler);
  optionList($("scheduler"), library.schedulers.map((name) => ({ name })), useDefaults ? data.defaults.scheduler : $("scheduler").value || data.defaults.scheduler);
  updateModelGuides(false);
  $("negativeSection").hidden = family === "krea2";
  $("uploadStatus").textContent = "";
}

function updateModelGuides(resetValues) {
  const turbo = family === "anima" && $("model").value.includes("turbo");
  const recommended = turbo ? { steps: 10, cfg: 1, sampler: "euler" } : library.families[family].defaults;
  $("stepsGuide").textContent = `推荐 ${recommended.steps} 步`;
  $("cfgGuide").textContent = `推荐 ${recommended.cfg}`;
  $("samplerGuide").textContent = `推荐 ${recommended.sampler}`;
  if (resetValues) {
    $("steps").value = recommended.steps;
    $("cfg").value = recommended.cfg;
    $("sampler").value = recommended.sampler;
  }
}

function setReference(file) {
  if (referenceUrl) URL.revokeObjectURL(referenceUrl);
  referenceFile = file;
  referenceUrl = file ? URL.createObjectURL(file) : null;
  $("referencePreview").hidden = !file;
  $("dropzone").hidden = !!file;
  $("denoiseField").hidden = !file;
  $("referenceFile").value = "";
  if (file) {
    $("referenceImage").src = referenceUrl;
    $("referenceName").textContent = file.name;
  }
}

function config(reference = null) {
  const loras = [];
  for (const row of $("loraList").querySelectorAll(".lora-item")) {
    if (row.querySelector("input[type=checkbox]").checked) {
      loras.push({ name: row.dataset.name, strength: Number(row.querySelector("input[type=number]").value) });
    }
  }
  return {
    family, model: $("model").value, encoder: $("encoder").value, vae: $("vae").value,
    prompt: $("prompt").value, negative: $("negative").value,
    width: Number($("width").value), height: Number($("height").value),
    steps: Number($("steps").value), cfg: Number($("cfg").value),
    seed: Number($("seed").value), sampler: $("sampler").value,
    scheduler: $("scheduler").value, loras, reference,
    denoise: Number($("denoise").value),
  };
}

async function uploadReference(file = referenceFile) {
  if (!file) return null;
  const form = new FormData();
  form.append("file", file);
  beginUpload(`参考图 · ${file.name}`);
  try {
    const result = await uploadRequest("/api/reference", form, updateUpload);
    finishUpload("参考图上传完成，继续生成工作流。 ");
    return result.name;
  } catch (error) {
    finishUpload(error.message, true);
    throw error;
  }
}

function setBusy(value) {
  busy = value;
  const locked = navigationProtected();
  $("generateButton").disabled = locked || !window.showDirectoryPicker;
  $("batchGenerateButton").disabled = locked || !window.showDirectoryPicker;
  $("batchCount").disabled = locked;
  $("workflowButton").disabled = locked;
  $("chooseOutputDir").disabled = locked || !window.showDirectoryPicker;
  $("retryLocalSave").disabled = locked;
  $("loraFile").disabled = locked;
  for (const button of $("loraList").querySelectorAll(".lora-manage")) button.disabled = locked;
  for (const id of ["loraManageName", "loraManageGroup", "loraManageSave", "loraManageDelete", "loraManageCancel"]) {
    $(id).disabled = managing;
  }
  updateOverlayStatus();
}

function renderProgress(progress) {
  const section = $("generationProgress");
  const track = $("progressTrack");
  const fill = $("progressFill");
  section.hidden = false;
  const stage = progress?.stage || "queued";
  const labels = {
    queued: "正在排队", loading: "正在加载模型与 LoRA", encoding: "正在处理提示词或参考图",
    sampling: "正在采样", decoding: "采样完成，正在解码图像",
    saving: "采样完成，正在保存图像", finishing: "正在整理生成结果",
    local_save: "正在保存到本机文件夹",
    done: "生成完成", error: "生成失败",
  };
  $("progressStage").textContent = labels[stage] || "正在生成";
  const step = Number(progress?.step) || 0;
  const total = Number(progress?.total) || 0;
  const showSampling = ["sampling", "decoding", "saving", "finishing", "local_save", "done"].includes(stage) && total > 0;
  if (showSampling) {
    const percent = stage === "sampling" ? Math.max(0, Math.min(100, Math.round(step / total * 100))) : 100;
    track.classList.remove("indeterminate");
    fill.style.width = `${percent}%`;
    track.setAttribute("aria-valuenow", String(percent));
    $("progressSteps").textContent = stage === "sampling" ? `${step} / ${total} 步 · ${percent}%` : "采样 100%";
  } else {
    track.classList.add("indeterminate");
    fill.style.width = "";
    track.removeAttribute("aria-valuenow");
    $("progressSteps").textContent = stage === "queued" ? "等待执行" : "处理中";
  }
  section.classList.toggle("is-error", stage === "error");
}

async function pollJob(id, seed, position = null) {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 750));
    const job = await api(`/api/jobs/${encodeURIComponent(id)}`);
    renderProgress(job.progress || { stage: job.state === "done" ? "done" : "queued" });
    if (job.state === "running") continue;
    if (job.state === "error") {
      renderProgress({ stage: "error" });
      throw new Error(job.error || "ComfyUI 执行失败，请检查模型和参数");
    }
    if (!job.images.length) throw new Error("生成任务完成，但没有保存图片");
    renderProgress({ stage: "local_save", step: 1, total: 1 });
    status("生成完成，正在写入本机文件夹…", "working");
    await saveJobImages(job.images, seed, position);
    localImagesSaved = true;
    if (!await clearServerCopies()) {
      throw new Error("本机图片已保存，但服务器临时副本尚未清理；批量生成已暂停，请点击“继续保存并清理服务器”");
    }
    break;
  }
}

function resetResultGallery() {
  for (const url of resultUrls) URL.revokeObjectURL(url);
  resultUrls.length = 0;
  renderedFilenames.clear();
  $("resultGrid").replaceChildren();
  $("resultGrid").hidden = true;
  $("resultEmpty").hidden = false;
  $("resultMeta").textContent = "";
}

async function saveJobImages(images, seed, position = null) {
  const directory = await writableDirectory();
  const saved = [];
  for (const item of images) {
    if (!/^studiojob_[0-9a-f]{32}_[0-9]+_\.png$/.test(item.filename) || item.subfolder !== "Studio") {
      throw new Error("服务器返回了非本站管理的图片路径，已停止自动保存和清理。");
    }
    const url = `/api/image?filename=${encodeURIComponent(item.filename)}&subfolder=Studio`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`获取生成图片失败（${response.status}）`);
    const blob = await response.blob();
    const signature = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
    if (blob.size < 100 || signature.join(",") !== "137,80,78,71,13,10,26,10") {
      throw new Error("收到的生成图片不是完整 PNG；服务器副本暂时保留，可重试保存。");
    }
    const file = await directory.getFileHandle(item.filename, { create: true });
    const writer = await file.createWritable();
    try {
      await writer.write(blob);
      await writer.close();
    } catch (error) {
      await writer.abort().catch(() => {});
      throw error;
    }
    if ((await file.getFile()).size !== blob.size) {
      throw new Error("本机图片大小校验失败；服务器副本暂时保留，可重试保存。");
    }
    saved.push({ filename: item.filename, blob });
  }
  const grid = $("resultGrid");
  for (const item of saved) {
    if (renderedFilenames.has(item.filename)) continue;
    const url = URL.createObjectURL(item.blob);
    resultUrls.push(url);
    renderedFilenames.add(item.filename);
    const link = document.createElement("a");
    link.href = url;
    link.download = item.filename;
    const image = document.createElement("img");
    image.src = url;
    image.alt = `已保存到本机的 ${item.filename}`;
    const caption = document.createElement("span");
    caption.className = "result-caption";
    caption.textContent = position?.total > 1 ? `第 ${position.index} / ${position.total} 张 · 种子 ${seed}` : `种子 ${seed}`;
    link.append(image, caption);
    grid.append(link);
  }
  grid.hidden = false;
  $("resultEmpty").hidden = true;
  $("resultMeta").textContent = position?.total > 1
    ? `已保存 ${position.index} / ${position.total} 张到本机 · 最新种子 ${seed}`
    : `种子 ${seed} · 已保存 ${saved.length} 张到本机`;
}

async function clearServerCopies() {
  try {
    const finishedJob = pendingJob;
    await api(`/api/jobs/${encodeURIComponent(pendingJob.id)}/saved`, { method: "POST" });
    pendingJob = null;
    localImagesSaved = false;
    sessionStorage.removeItem("studioPendingJob");
    $("retryLocalSave").hidden = true;
    renderProgress({ stage: "done", step: 1, total: 1 });
    status(`图片已保存到本机「${outputDirectory.name}」，服务器临时副本已清理。`, "success");
    if (finishedJob.total > 1 && finishedJob.index < finishedJob.total && !batchActive) {
      $("batchRunStatus").hidden = false;
      $("batchRunStatus").textContent = `已完成 ${finishedJob.index} / ${finishedJob.total} 张；剩余图片未自动提交，可重新指定剩余数量。`;
    }
    return true;
  } catch (error) {
    $("retryLocalSave").hidden = false;
    status(`本机图片已保存，但服务器清理失败：${error.message}。请点击“继续保存并清理服务器”。`, "error");
    return false;
  }
}

async function resumeLocalSave() {
  if (busy || !pendingJob) return;
  setBusy(true);
  try {
    await writableDirectory();
    if (localImagesSaved) await clearServerCopies();
    else await pollJob(pendingJob.id, pendingJob.seed, pendingJob.total > 1 ? pendingJob : null);
  } catch (error) {
    status(`${error.message}。服务器会在任务结束一小时后清理临时文件。`, "error");
    $("retryLocalSave").hidden = false;
  } finally { setBusy(false); }
}

async function generate(count = 1) {
  if (navigationProtected()) return;
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    status("生成数量必须是 2–100 之间的整数。", "error");
    return;
  }
  const multiple = count > 1;
  let completed = 0;
  setBusy(true);
  $("generationProgress").hidden = true;
  try {
    if (pendingJob) throw new Error("上一次任务尚未完成本机保存；请先点击“继续保存并清理服务器”。");
    await writableDirectory();
    const sourceReference = referenceFile;
    const baseConfig = config();
    if (!baseConfig.prompt.trim()) throw new Error("请输入文本提示");
    resetResultGallery();
    batchActive = multiple;
    $("batchRunStatus").hidden = !multiple;
    if (multiple) $("batchRunStatus").textContent = `准备生成 1 / ${count} 张；每张使用新随机种子。`;
    for (let index = 1; index <= count; index++) {
      const position = multiple ? { index, total: count } : null;
      if (multiple) $("batchRunStatus").textContent = `正在生成第 ${index} / ${count} 张；已保存 ${completed} 张。`;
      status(sourceReference ? "正在上传参考图…" : "正在构建工作流…", "working");
      const reference = await uploadReference(sourceReference);
      const payload = { ...baseConfig, reference, seed: multiple ? -1 : baseConfig.seed };
      const result = await api("/api/generate", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      pendingJob = { id: result.prompt_id, seed: result.seed, ...(position || {}) };
      localImagesSaved = false;
      sessionStorage.setItem("studioPendingJob", JSON.stringify(pendingJob));
      $("retryLocalSave").hidden = false;
      renderProgress({ stage: "queued" });
      status(`${multiple ? `第 ${index} / ${count} 张：` : ""}工作流已提交，正在生成…（种子 ${result.seed}）`, "working");
      await pollJob(result.prompt_id, result.seed, position);
      completed++;
      if (multiple) $("batchRunStatus").textContent = `已生成并保存 ${completed} / ${count} 张。`;
    }
    if (multiple) status(`${count} 张图片已依次保存到本机「${outputDirectory.name}」，服务器临时副本已清理。`, "success");
  } catch (error) {
    if (multiple) {
      $("batchRunStatus").hidden = false;
      $("batchRunStatus").textContent = `批量任务停在 ${completed} / ${count} 张；未开始的图片不会继续提交。`;
    }
    status(error.message, "error");
    if (pendingJob) $("retryLocalSave").hidden = false;
  } finally {
    batchActive = false;
    setBusy(false);
  }
}

async function exportWorkflow() {
  if (busy) return;
  setBusy(true);
  try {
    status(referenceFile ? "正在上传参考图并生成工作流…" : "正在生成工作流…", "working");
    const reference = await uploadReference();
    const result = await api("/api/workflow", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(config(reference)) });
    const blob = new Blob([JSON.stringify(result.workflow, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `studio-${family}-api-workflow.json`;
    link.click();
    URL.revokeObjectURL(url);
    status("ComfyUI API 工作流已下载。", "success");
  } catch (error) {
    status(error.message, "error");
  } finally {
    setBusy(false);
  }
}

async function uploadLora(file) {
  if (!file) return;
  if (navigationProtected()) {
    $("uploadStatus").textContent = "请等待当前任务结束后再上传 LoRA。";
    return;
  }
  if (!file.name.toLowerCase().endsWith(".safetensors")) {
    $("uploadStatus").textContent = "请选择 .safetensors 文件。";
    return;
  }
  const targetFamily = family;
  uploading = true;
  setBusy(busy);
  $("uploadStatus").textContent = `正在上传 ${file.name}…`;
  beginUpload(`LoRA · ${file.name}`);
  const form = new FormData();
  form.append("family", targetFamily);
  form.append("file", file);
  try {
    await uploadRequest("/api/loras", form, updateUpload);
    rememberChoices();
    library = await api("/api/catalog");
    renderSettings();
    $("uploadStatus").textContent = `已加入 ${library.families[targetFamily].label} 的 LoRA 列表。`;
    finishUpload(`${file.name} 已上传并校验完成。`);
  } catch (error) {
    $("uploadStatus").textContent = error.message;
    finishUpload(error.message, true);
  } finally {
    uploading = false;
    $("loraFile").value = "";
    setBusy(busy);
  }
}

async function boot() {
  document.addEventListener("click", (event) => {
    const link = event.target.closest?.('a[href="/prompts"], a[href="/templates"], a[href="/random/"]');
    if (!link || !navigationProtected() || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    openBackgroundPage(link.getAttribute("href"));
  });
  $("returnToStudio").addEventListener("click", closeBackgroundPage);
  $("backgroundFrame").addEventListener("load", () => {
    try {
      if (!$("backgroundPage").hidden && $("backgroundFrame").contentWindow.location.pathname === "/") closeBackgroundPage();
    } catch { /* The frame stays open if a destination is not same-origin. */ }
  });
  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin || event.source !== $("backgroundFrame").contentWindow ||
        !event.data || typeof event.data !== "object") return;
    if (event.data.type === "studio:close") closeBackgroundPage();
    else if (event.data.type === "studio:prompt") applyFramedPrompt(event.data);
    else if (event.data.type === "studio:template") applyFramedTemplate(event.data);
  });
  window.addEventListener("beforeunload", (event) => {
    if (navigationProtected()) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  $("prompt").addEventListener("input", () => $("promptCount").textContent = `${$("prompt").value.length} / 12000`);
  $("referenceFile").addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (file) setReference(file);
  });
  $("clearReference").addEventListener("click", () => setReference(null));
  $("dropzone").addEventListener("dragover", (event) => { event.preventDefault(); $("dropzone").classList.add("dragging"); });
  $("dropzone").addEventListener("dragleave", () => $("dropzone").classList.remove("dragging"));
  $("dropzone").addEventListener("drop", (event) => {
    event.preventDefault();
    $("dropzone").classList.remove("dragging");
    const file = event.dataTransfer.files[0];
    if (file && ["image/png", "image/jpeg", "image/webp"].includes(file.type)) setReference(file);
    else status("参考图仅支持 PNG、JPG 或 WebP。", "error");
  });
  $("denoise").addEventListener("input", () => $("denoiseValue").textContent = Number($("denoise").value).toFixed(2));
  $("generateButton").addEventListener("click", () => generate(1));
  $("batchGenerateButton").addEventListener("click", () => generate(Number($("batchCount").value)));
  $("chooseOutputDir").addEventListener("click", chooseDirectory);
  $("retryLocalSave").addEventListener("click", resumeLocalSave);
  $("workflowButton").addEventListener("click", exportWorkflow);
  $("model").addEventListener("change", () => updateModelGuides(true));
  $("loraFile").addEventListener("change", (event) => uploadLora(event.target.files[0]));
  $("loraManageSave").addEventListener("click", () => changeLora(false));
  $("loraManageDelete").addEventListener("click", () => changeLora(true));
  $("loraManageCancel").addEventListener("click", () => $("loraManager").close());
  $("loraManager").addEventListener("close", () => { if (!managing) managedLora = null; });
  $("loraManager").addEventListener("cancel", (event) => { if (managing) event.preventDefault(); });
  try {
    library = await api("/api/catalog");
    const stored = sessionStorage.getItem("studioTemplate");
    sessionStorage.removeItem("studioTemplate");
    let template = null;
    if (stored) {
      try { template = JSON.parse(stored); } catch { template = null; }
    }
    if (template && library.families[template.family]) {
      family = template.family;
      choices[family].model = template.config.model;
      choices[family].presetApplied = true;
      choices[family].loras = {};
      for (const item of template.config.loras || []) {
        choices[family].loras[item.name] = { enabled: true, strength: item.strength };
      }
    }
    renderSettings(true);
    if (template && library.families[template.family]) {
      $("steps").value = template.config.steps;
      $("cfg").value = template.config.cfg;
      $("sampler").value = template.config.sampler;
      $("scheduler").value = template.config.scheduler;
      if (template.config.denoise) $("denoise").value = template.config.denoise;
      $("denoiseValue").textContent = Number($("denoise").value).toFixed(2);
    }
    const savedPrompt = sessionStorage.getItem("studioPrompt");
    sessionStorage.removeItem("studioPrompt");
    let appliedPrompt = null;
    if (savedPrompt) {
      try { appliedPrompt = JSON.parse(savedPrompt); } catch { appliedPrompt = null; }
    }
    if (appliedPrompt && library.families[appliedPrompt.family] && typeof appliedPrompt.prompt === "string") {
      if (!template) {
        family = appliedPrompt.family;
        renderSettings(true);
      }
      $("prompt").value = appliedPrompt.prompt.slice(0, 12000);
      $("promptCount").textContent = `${$("prompt").value.length} / 12000`;
    }
    $("serviceStatus").textContent = "生成服务已连接";
    status(appliedPrompt ? "已从提示词库填入画面描述；可继续修改后生成。" : template ? `已套用「${template.title}」。${template.config.wantsReference ? "请上传参考图并填写描述。" : "填写描述即可生成。"}` : "已就绪。填写描述即可生成。", "success");
    try {
      outputDirectory = await storedDirectory();
      await updateDirectoryStatus();
    } catch (error) {
      outputDirectory = null;
      $("localSaveStatus").textContent = `无法读取本机保存设置：${error.message}。请重新选择文件夹。`;
    }
    const unfinished = sessionStorage.getItem("studioPendingJob");
    if (unfinished) {
      try {
        pendingJob = JSON.parse(unfinished);
        if (!pendingJob.id || !Number.isFinite(pendingJob.seed)) throw new Error("invalid job");
        $("retryLocalSave").hidden = false;
        status("发现尚未完成本机保存的任务。请点击“继续保存并清理服务器”。", "working");
      } catch {
        pendingJob = null;
        sessionStorage.removeItem("studioPendingJob");
      }
    }
  } catch (error) {
    $("serviceStatus").textContent = "连接失败";
    status(`无法读取模型列表：${error.message}`, "error");
  }
}

boot();
