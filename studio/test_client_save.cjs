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
    replaceChildren() { this.children = []; },
    append(child) { this.children.push(child); },
  };
}
function getElement(id) {
  if (!elements.has(id)) elements.set(id, element());
  return elements.get(id);
}

const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(256, 1)]);
const filename = `studiojob_${"a".repeat(32)}_00001_.png`;
let localBytes = null;
let cleanupCalls = 0;
const directory = {
  name: "gen",
  async queryPermission() { return "granted"; },
  async getFileHandle() {
    return {
      async createWritable() {
        return {
          async write(blob) { localBytes = Buffer.from(await blob.arrayBuffer()); },
          async close() {}, async abort() {},
        };
      },
      async getFile() { return { size: localBytes?.length || 0 }; },
    };
  },
};
const context = vm.createContext({
  Blob, Uint8Array, console,
  window: { showDirectoryPicker() {} },
  document: { getElementById: getElement, createElement: element },
  URL: { createObjectURL() { return "blob:verified"; }, revokeObjectURL() {} },
  sessionStorage: { removeItem() {} },
  mockDirectory: directory,
  async fetch(url, options) {
    if (url.startsWith("/api/image?")) {
      return { ok: true, blob: async () => new Blob([png], { type: "image/png" }) };
    }
    if (url.endsWith("/saved") && options?.method === "POST") {
      assert.deepEqual(localBytes, png, "server cleanup must follow verified local write");
      cleanupCalls++;
      return { ok: true, headers: { get: () => "application/json" }, json: async () => ({ removed: true }) };
    }
    throw new Error(`Unexpected fetch ${url}`);
  },
});
vm.runInContext(source, context);

(async () => {
  vm.runInContext("outputDirectory = mockDirectory; pendingJob = { id: '123e4567-e89b-12d3-a456-426614174000', seed: 42 };", context);
  await vm.runInContext(`saveJobImages([{ filename: '${filename}', subfolder: 'Studio' }], 42)`, context);
  assert.deepEqual(localBytes, png);
  assert.equal(cleanupCalls, 0, "saving alone must not acknowledge cleanup");
  await vm.runInContext("clearServerCopies()", context);
  assert.equal(cleanupCalls, 1);
  assert.match(getElement("status").textContent, /服务器临时副本已清理/);
  assert.equal(getElement("resultGrid").children.length, 1);

  context.mockDirectory = { ...directory, async getFileHandle() { throw new Error("disk full"); } };
  vm.runInContext("outputDirectory = mockDirectory;", context);
  await assert.rejects(vm.runInContext(`saveJobImages([{ filename: '${filename}', subfolder: 'Studio' }], 42)`, context), /disk full/);
  assert.equal(cleanupCalls, 1, "a failed local write must leave the server copy pending");
  console.log("CLIENT_LOCAL_SAVE_OK: write verified before cleanup; failed write does not cleanup");
})().catch((error) => { console.error(error); process.exitCode = 1; });
