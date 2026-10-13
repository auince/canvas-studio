const grid = document.getElementById("templateGrid");
const message = document.getElementById("templateStatus");

async function loadTemplates() {
  try {
    const response = await fetch("/api/templates");
    if (!response.ok) throw new Error(`模板服务返回 ${response.status}`);
    const templates = await response.json();
    for (const template of templates) {
      const card = document.createElement("article");
      card.className = "template-card";
      const head = document.createElement("div");
      head.className = "template-card-head";
      const badge = document.createElement("span");
      badge.className = "template-badge";
      badge.textContent = template.family === "anima" ? "ANIMA" : "KREA 2";
      const availability = document.createElement("span");
      availability.className = "template-source";
      availability.textContent = template.ready ? "● 可运行" : "◌ 等待模型文件";
      head.append(badge, availability);
      const title = document.createElement("h2");
      title.textContent = template.title;
      const description = document.createElement("p");
      description.textContent = template.description;
      const footer = document.createElement("footer");
      const source = document.createElement(template.has_source || template.source_url ? "a" : "span");
      source.textContent = template.has_source ? "下载 Comfy 原始模板 ↗" : template.source;
      if (template.has_source) {
        source.href = `/api/templates/${encodeURIComponent(template.id)}/source`;
        source.className = "template-source";
      } else if (template.source_url) {
        source.href = template.source_url;
        source.target = "_blank";
        source.rel = "noopener noreferrer";
        source.className = "template-source";
      }
      const use = document.createElement("button");
      use.type = "button";
      use.className = "template-use";
      use.textContent = "使用模板 ↗";
      use.disabled = !template.ready;
      use.addEventListener("click", () => {
        if (window.parent !== window) {
          window.parent.postMessage({ type: "studio:template", template: {
            title: template.title, family: template.family, config: template.config,
          } }, location.origin);
          return;
        }
        sessionStorage.setItem("studioTemplate", JSON.stringify({ title: template.title, family: template.family, config: template.config }));
        location.href = "/";
      });
      footer.append(source, use);
      card.append(head, title, description, footer);
      grid.append(card);
    }
    message.textContent = `${templates.filter((item) => item.ready).length} 个模板已可运行 · ${templates.length} 个模板已收录`;
    message.className = "status success";
  } catch (error) {
    message.textContent = `无法加载模板：${error.message}`;
    message.className = "status error";
  }
}

if (window.parent !== window) {
  document.querySelector('a[href="/"]').addEventListener("click", (event) => {
    event.preventDefault();
    window.parent.postMessage({ type: "studio:close" }, location.origin);
  });
}

loadTemplates();
