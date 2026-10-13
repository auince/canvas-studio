const el = (id) => document.getElementById(id);
let data;
let mode = "anima";
let category = "全部";
let templateCategory = "全部";
let selectedTemplate = null;
const selectedTags = new Set();
let editingPreview = false;
let tagLimit = 60;
let templateLimit = 18;

function setStatus(message, error = false) {
  el("promptLibraryStatus").textContent = message;
  el("promptLibraryStatus").classList.toggle("error-text", error);
}

function setMode(next) {
  mode = next;
  el("animaTab").classList.toggle("selected", next === "anima");
  el("kreaTab").classList.toggle("selected", next === "krea2");
  el("animaTab").setAttribute("aria-pressed", String(next === "anima"));
  el("kreaTab").setAttribute("aria-pressed", String(next === "krea2"));
  el("animaPanel").hidden = next !== "anima";
  el("kreaPanel").hidden = next !== "krea2";
  el("animaFields").hidden = next !== "anima";
  el("kreaFields").hidden = next !== "krea2";
  el("promptSearch").value = "";
  tagLimit = 60;
  templateLimit = 18;
  editingPreview = false;
  renderBrowser();
  compose();
}

function renderCategories() {
  const holder = el("tagCategories");
  holder.replaceChildren();
  const categories = ["全部", ...new Set(data.tags.map((tag) => tag.category))];
  for (const name of categories) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `category-chip ${category === name ? "selected" : ""}`;
    button.textContent = name;
    button.setAttribute("aria-pressed", String(category === name));
    button.addEventListener("click", () => { category = name; tagLimit = 60; renderBrowser(); });
    holder.append(button);
  }
}

function renderTags() {
  const holder = el("tagGrid");
  holder.replaceChildren();
  const query = el("promptSearch").value.trim().toLocaleLowerCase();
  const tags = data.tags.filter((tag) => (category === "全部" || tag.category === category) &&
    `${tag.label} ${tag.value} ${tag.guide}`.toLocaleLowerCase().includes(query));
  el("tagCount").textContent = `找到 ${tags.length} 个标签 · 显示 ${Math.min(tags.length, tagLimit)} 个`;
  el("moreTags").hidden = tags.length <= tagLimit;
  for (const tag of tags.slice(0, tagLimit)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `tag-option ${selectedTags.has(tag.value) ? "selected" : ""}`;
    button.setAttribute("aria-pressed", String(selectedTags.has(tag.value)));
    const title = document.createElement("strong");
    title.textContent = tag.label;
    const english = document.createElement("span");
    english.textContent = tag.value;
    const guide = document.createElement("small");
    guide.textContent = tag.guide;
    button.append(title, english, guide);
    button.addEventListener("click", () => {
      selectedTags.has(tag.value) ? selectedTags.delete(tag.value) : selectedTags.add(tag.value);
      editingPreview = false;
      renderTags();
      compose();
    });
    holder.append(button);
  }
  if (!tags.length) holder.textContent = "没有匹配的标签。试试其他关键词。";
}

function renderTemplates() {
  const holder = el("templateChoices");
  holder.replaceChildren();
  const categories = el("templateCategories");
  categories.replaceChildren();
  for (const name of ["全部", ...new Set(data.templates.map((item) => item.category))]) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `category-chip ${templateCategory === name ? "selected" : ""}`;
    chip.textContent = name;
    chip.setAttribute("aria-pressed", String(templateCategory === name));
    chip.addEventListener("click", () => { templateCategory = name; templateLimit = 18; renderTemplates(); });
    categories.append(chip);
  }
  const query = el("promptSearch").value.trim().toLocaleLowerCase();
  const templates = data.templates.filter((item) =>
    (templateCategory === "全部" || item.category === templateCategory) &&
    `${item.title} ${item.category} ${item.description} ${item.pattern} ${item.source_id || ""}`.toLocaleLowerCase().includes(query));
  el("templateCount").textContent = `找到 ${templates.length} 个模板 · 显示 ${Math.min(templates.length, templateLimit)} 个`;
  el("moreTemplates").hidden = templates.length <= templateLimit;
  for (const item of templates.slice(0, templateLimit)) {
    const card = document.createElement("article");
    card.className = "prompt-template-card";
    const button = document.createElement("button");
    button.type = "button";
    button.className = `prompt-template ${selectedTemplate?.id === item.id ? "selected" : ""}`;
    button.setAttribute("aria-pressed", String(selectedTemplate?.id === item.id));
    const badge = document.createElement("span");
    badge.textContent = item.category;
    const title = document.createElement("strong");
    title.textContent = item.title;
    const description = document.createElement("small");
    description.textContent = item.description;
    button.append(badge, title, description);
    button.addEventListener("click", () => {
      selectedTemplate = item;
      el("kreaSubject").value = item.subject || "";
      el("kreaSetting").value = item.setting || "";
      el("kreaLighting").value = item.lighting || "";
      el("kreaStyle").value = item.style || "";
      el("settingField").hidden = !item.pattern.includes("{setting}");
      el("lightingField").hidden = !item.pattern.includes("{lighting}");
      el("styleField").hidden = !item.pattern.includes("{style}");
      editingPreview = false;
      renderTemplates();
      compose();
    });
    card.append(button);
    if (item.source_url) {
      const link = document.createElement("a");
      link.href = item.source_url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.className = "template-source-link";
      link.textContent = `查看来源 · ${item.source_id} ↗`;
      card.append(link);
    }
    holder.append(card);
  }
  if (!templates.length) holder.textContent = "没有匹配的模板。试试其他关键词。";
}

function renderBrowser() {
  if (mode === "anima") { renderCategories(); renderTags(); }
  else renderTemplates();
}

function compose() {
  if (editingPreview) return;
  if (mode === "anima") {
    const parts = [el("animaSubject").value.trim(), ...selectedTags];
    el("composedPrompt").value = parts.filter(Boolean).join(", ");
    setStatus(`${selectedTags.size} 个标签已选。建议描述主体后再加入场景和光线。`);
    return;
  }
  if (!selectedTemplate) {
    el("composedPrompt").value = "";
    setStatus("先选择一个模板，再填写主体。");
    return;
  }
  const values = {
    subject: el("kreaSubject").value.trim(),
    setting: el("kreaSetting").value.trim(),
    lighting: el("kreaLighting").value.trim(),
    style: el("kreaStyle").value.trim(),
  };
  el("composedPrompt").value = selectedTemplate.pattern.replace(/\{(subject|setting|lighting|style)\}/g,
    (_, key) => values[key] || `[请填写${{ subject: "主体", setting: "环境", lighting: "光线", style: "风格" }[key]}]`);
  setStatus("模板内容已生成。可以直接修改最终提示词。");
}

async function boot() {
  try {
    const response = await fetch("/prompts.json");
    if (!response.ok) throw new Error(`提示词数据返回 ${response.status}`);
    data = await response.json();
    if (!Array.isArray(data.tags) || !Array.isArray(data.templates)) throw new Error("提示词数据格式无效");
    el("libraryCounts").textContent = `${data.tags.length} 个标签 · ${data.templates.length} 个模板`;
    el("animaTab").addEventListener("click", () => setMode("anima"));
    el("kreaTab").addEventListener("click", () => setMode("krea2"));
    el("promptSearch").addEventListener("input", () => { tagLimit = 60; templateLimit = 18; renderBrowser(); });
    el("moreTags").addEventListener("click", () => { tagLimit += 60; renderTags(); });
    el("moreTemplates").addEventListener("click", () => { templateLimit += 18; renderTemplates(); });
    for (const id of ["animaSubject", "kreaSubject", "kreaSetting", "kreaLighting", "kreaStyle"]) {
      el(id).addEventListener("input", () => { editingPreview = false; compose(); });
    }
    el("composedPrompt").addEventListener("input", () => { editingPreview = true; });
    el("applyPrompt").addEventListener("click", () => {
      const prompt = el("composedPrompt").value.trim();
      if (!prompt || prompt.includes("[请填写")) {
        setStatus("请先填写完整提示词，再带到创作页。", true);
        return;
      }
      if (window.parent !== window) {
        window.parent.postMessage({ type: "studio:prompt", family: mode, prompt }, location.origin);
        return;
      }
      sessionStorage.removeItem("studioTemplate");
      sessionStorage.setItem("studioPrompt", JSON.stringify({ family: mode, prompt }));
      location.href = "/";
    });
    if (window.parent !== window) {
      document.querySelector('a[href="/"]').addEventListener("click", (event) => {
        event.preventDefault();
        window.parent.postMessage({ type: "studio:close" }, location.origin);
      });
    }
    renderBrowser();
    compose();
  } catch (error) {
    setStatus(`无法加载提示词库：${error.message}`, true);
    el("applyPrompt").disabled = true;
  }
}

boot();
