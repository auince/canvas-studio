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
    hidden: true, textContent: "", style: {}, attributes: {},
    classList: { add() {}, remove() {} },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
  };
}
function getElement(id) {
  if (!elements.has(id)) elements.set(id, element());
  return elements.get(id);
}

class FakeXHR {
  constructor() {
    this.events = {};
    this.uploadEvents = {};
    this.upload = { addEventListener: (name, callback) => { this.uploadEvents[name] = callback; } };
  }
  addEventListener(name, callback) { this.events[name] = callback; }
  open(method, url) { assert.equal(method, "POST"); assert.equal(url, "/api/loras"); }
  send() {
    this.uploadEvents.progress({ loaded: 50, total: 100, lengthComputable: true });
    assert.equal(getElement("uploadPercent").textContent, "50%");
    assert.equal(getElement("uploadFill").style.width, "50%");
    this.uploadEvents.load();
    assert.match(getElement("uploadDetail").textContent, /服务器正在校验/);
    this.status = 200;
    this.responseText = '{"name":"small.safetensors"}';
    this.events.load();
  }
}

const context = vm.createContext({
  XMLHttpRequest: FakeXHR,
  clearTimeout() {}, setTimeout() {},
  document: { getElementById: getElement, body: { style: {} } },
});
vm.runInContext(source, context);

(async () => {
  vm.runInContext("uploading = true; beginUpload('LoRA · small.safetensors');", context);
  const result = await vm.runInContext("uploadRequest('/api/loras', {}, updateUpload)", context);
  assert.equal(result.name, "small.safetensors");
  vm.runInContext("openBackgroundPage('/prompts')", context);
  assert.equal(getElement("backgroundPage").hidden, false);
  assert.equal(getElement("backgroundFrame").src, "/prompts");
  assert.equal(vm.runInContext("uploading", context), true, "switching the embedded page must not stop upload");
  vm.runInContext("closeBackgroundPage()", context);
  assert.equal(getElement("backgroundPage").hidden, true);
  console.log("UPLOAD_PROGRESS_OK: bytes and percent update; embedded navigation preserves upload state");
})().catch((error) => { console.error(error); process.exitCode = 1; });
