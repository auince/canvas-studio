"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "static", "app.js"), "utf8")
  .replace(/\nboot\(\);\s*$/, "");
const elements = new Map();
function element() {
  return {
    hidden: false, disabled: false, value: "", textContent: "", className: "", style: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, removeAttribute() {},
    querySelectorAll() { return []; },
    replaceChildren() { this.children = []; },
    append(...children) { this.children.push(...children); },
  };
}
function getElement(id) {
  if (!elements.has(id)) elements.set(id, element());
  return elements.get(id);
}
for (const [id, value] of Object.entries({
  prompt: "test image", negative: "", model: "base.safetensors", encoder: "clip.safetensors",
  vae: "vae.safetensors", width: "512", height: "512", steps: "8", cfg: "1",
  seed: "777", sampler: "euler", scheduler: "simple", denoise: "0.65",
})) getElement(id).value = value;

const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(256, 1)]);
const localFiles = new Map();
const submitted = [];
const cleaned = [];
let failSaveAt = null;
let failCleanupAt = null;
let referenceUploads = 0;
const directory = {
  name: "gen",
  async queryPermission() { return "granted"; },
  async getFileHandle(filename) {
    return {
      async createWritable() {
        return {
          async write(blob) {
            const index = Number.parseInt(filename.match(/^studiojob_([0-9a-f]{32})_/)[1], 16);
            if (index === failSaveAt) throw new Error("disk full");
            localFiles.set(filename, Buffer.from(await blob.arrayBuffer()));
          },
          async close() {}, async abort() {},
        };
      },
      async getFile() { return { size: localFiles.get(filename)?.length || 0 }; },
    };
  },
};
const jsonResponse = (body) => ({
  ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => body,
});
const context = vm.createContext({
  Blob, FormData, Uint8Array, console,
  window: { showDirectoryPicker() {} },
  document: { getElementById: getElement, createElement: element },
  URL: { createObjectURL() { return `blob:${Math.random()}`; }, revokeObjectURL() {} },
  sessionStorage: { setItem() {}, removeItem() {} },
  setTimeout(callback) { callback(); return 1; }, clearTimeout() {},
  mockDirectory: directory,
  async fetch(url, options) {
    if (url === "/api/generate") {
      if (submitted.length > 0) {
        assert.equal(cleaned.length, submitted.length, "next image must wait for local save and server cleanup");
      }
      const payload = JSON.parse(options.body);
      const index = submitted.length + 1;
      submitted.push(payload);
      return jsonResponse({ prompt_id: `job-${index}`, seed: index * 101 });
    }
    const job = url.match(/^\/api\/jobs\/job-(\d+)$/);
    if (job) {
      const index = Number(job[1]);
      return jsonResponse({
        state: "done", progress: { stage: "done", step: 8, total: 8 },
        images: [{ filename: `studiojob_${index.toString(16).padStart(32, "0")}_00001_.png`, subfolder: "Studio" }],
      });
    }
    if (url.startsWith("/api/image?")) {
      return { ok: true, blob: async () => new Blob([png], { type: "image/png" }) };
    }
    const saved = url.match(/^\/api\/jobs\/job-(\d+)\/saved$/);
    if (saved && options?.method === "POST") {
      const index = Number(saved[1]);
      if (index === failCleanupAt) {
        return { ok: false, status: 503, headers: { get: () => "text/plain" }, text: async () => "cleanup unavailable" };
      }
      const filename = `studiojob_${index.toString(16).padStart(32, "0")}_00001_.png`;
      assert.deepEqual(localFiles.get(filename), png, "cleanup must follow verified local write");
      cleaned.push(index);
      return jsonResponse({ removed: true });
    }
    throw new Error(`Unexpected fetch ${url}`);
  },
});
vm.runInContext(source, context);
vm.runInContext("outputDirectory = mockDirectory;", context);

(async () => {
  await vm.runInContext("generate(3)", context);
  assert.equal(submitted.length, 3);
  assert.deepEqual(submitted.map((item) => item.seed), [-1, -1, -1]);
  assert.deepEqual(cleaned, [1, 2, 3]);
  assert.equal(getElement("resultGrid").children.length, 3);
  assert.match(getElement("resultMeta").textContent, /已保存 3 \/ 3 张/);
  assert.match(getElement("batchRunStatus").textContent, /3 \/ 3/);

  await vm.runInContext("generate(1)", context);
  assert.equal(submitted[3].seed, 777, "single generation keeps chosen fixed seed");
  assert.equal(getElement("resultGrid").children.length, 1, "new run starts a new gallery");

  failSaveAt = 6;
  await vm.runInContext("generate(3)", context);
  assert.equal(submitted.length, 6, "failure must prevent the remaining image from being submitted");
  assert.deepEqual(cleaned, [1, 2, 3, 4, 5], "failed local write must keep its server copy");
  assert.equal(getElement("resultGrid").children.length, 1);
  assert.match(getElement("status").textContent, /disk full/);
  assert.equal(vm.runInContext("pendingJob.id", context), "job-6");
  failSaveAt = null;
  await vm.runInContext("resumeLocalSave()", context);
  assert.deepEqual(cleaned, [1, 2, 3, 4, 5, 6]);
  assert.equal(getElement("resultGrid").children.length, 2);
  assert.equal(vm.runInContext("pendingJob", context), null);

  context.mockReference = Object.assign(new Blob(["ref"], { type: "image/png" }), { name: "reference.png" });
  vm.runInContext("referenceFile = mockReference;", context);
  vm.runInContext("uploadRequest = async () => ({ name: `studio_ref_${++referenceUploads}.png` });", context);
  context.referenceUploads = referenceUploads;
  await vm.runInContext("generate(2)", context);
  assert.equal(submitted.length, 8);
  assert.equal(submitted[6].reference, "studio_ref_1.png");
  assert.equal(submitted[7].reference, "studio_ref_2.png");
  assert.deepEqual(cleaned, [1, 2, 3, 4, 5, 6, 7, 8]);

  failCleanupAt = 9;
  await vm.runInContext("generate(2)", context);
  assert.equal(submitted.length, 9, "cleanup failure must stop the next submission");
  assert.equal(getElement("resultGrid").children.length, 1, "locally saved image remains visible");
  assert.equal(vm.runInContext("pendingJob.id", context), "job-9");
  assert.equal(vm.runInContext("localImagesSaved", context), true);
  failCleanupAt = null;
  await vm.runInContext("resumeLocalSave()", context);
  assert.equal(vm.runInContext("pendingJob", context), null);
  assert.deepEqual(cleaned, [1, 2, 3, 4, 5, 6, 7, 8, 9]);

  await vm.runInContext("generate(101)", context);
  assert.equal(submitted.length, 9, "invalid count must not submit work");
  console.log("BATCH_GENERATION_OK: sequential random seeds, cumulative results, verified local saves, stop-and-retry, reference re-upload");
})().catch((error) => { console.error(error); process.exitCode = 1; });
