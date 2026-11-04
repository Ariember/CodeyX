import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../public/model-request-gate.js", import.meta.url), "utf8");
function fixture() {
  const window = {};
  vm.runInNewContext(source, { window });
  class Client {
    hostId = "local";
    enqueueRequest(method, params) { return { method, params }; }
    createRequest(method, params) { return { request: { method, params } }; }
    onResult(_id, value) { return value; }
  }
  const client = new Client();
  window.__codeyLoadCodexRequestClient = async () => client;
  const create = (options = {}) => window.__codeyCreateModelRequestGate({
    rewriteRequest: (method, params) => ({ method, params: { ...params, checked: true } }),
    trackRequest() {}, rewriteResult: (_id, _method, value) => value, ...options,
  });
  return { window, Client, client, create };
}

test("the standalone gate validates local requests and leaves remote ownership intact", async () => {
  const { Client, client, create } = fixture();
  const original = Client.prototype.enqueueRequest;
  const gate = create();
  assert.equal(gate.isReady(), false);
  await gate.ensure();
  assert.equal(gate.isReady(), true);
  assert.equal(client.enqueueRequest("turn/start", {}).params.checked, true);
  const remote = new Client();
  remote.hostId = "ssh";
  assert.equal(remote.enqueueRequest("turn/start", {}).params.checked, undefined);
  gate.dispose();
  gate.dispose();
  assert.equal(gate.isReady(), false);
  assert.equal(Client.prototype.enqueueRequest, original);
  await assert.rejects(gate.ensure(), /重新加载/);
});

test("a partial installation is rolled back and never reported as verified", async () => {
  const { window, Client, client, create } = fixture();
  const original = Client.prototype.enqueueRequest;
  let rejectInstall = true;
  Object.setPrototypeOf(client, new Proxy(Client.prototype, {
    defineProperty(target, name, descriptor) {
      if (rejectInstall && name === "createRequest") throw new Error("read-only client");
      return Reflect.defineProperty(target, name, descriptor);
    },
  }));
  const gate = create();
  await assert.rejects(gate.ensure(), /read-only client/);
  assert.equal(gate.isReady(), false);
  assert.equal(Client.prototype.enqueueRequest, original);
  assert.equal(window.__codeyAppServerRequestClients, undefined);
  rejectInstall = false;
  assert.equal(await gate.ensure(), true);
  assert.equal(gate.isReady(), true);
  assert.equal(client.enqueueRequest("turn/start", {}).params.checked, true);
  gate.dispose();
  assert.equal(Client.prototype.enqueueRequest, original);
});

test("disposal during discovery prevents a late gate from patching the client", async () => {
  const { window, Client, client, create } = fixture();
  const original = Client.prototype.enqueueRequest;
  let finish;
  window.__codeyLoadCodexRequestClient = () => new Promise(resolve => { finish = resolve; });
  const gate = create();
  const pending = gate.ensure();
  assert.equal(gate.isReady(), false);
  assert.equal(gate.ensure(), pending);
  await new Promise(resolve => setImmediate(resolve));
  gate.dispose();
  finish(client);
  await assert.rejects(pending, /重新加载/);
  assert.equal(gate.isReady(), false);
  assert.equal(Client.prototype.enqueueRequest, original);
});

test("failed validation does not reach the original transport", async () => {
  const { client, create } = fixture();
  const gate = create({ rewriteRequest() { throw new Error("blocked route"); } });
  await gate.ensure();
  await assert.rejects(client.enqueueRequest("turn/start", {}), /blocked route/);
  gate.dispose();
});

test("native selection and the complete source gate are ready only while active", async () => {
  for (const nativeSelectionOnly of [false, true]) {
    const { window, create } = fixture();
    const gate = create({ nativeSelectionOnly });
    assert.equal(gate.isReady(), nativeSelectionOnly);
    window.__codeyModelRequestSourceGateInstalled = true;
    assert.equal(gate.isReady(), true);
    assert.equal(await gate.ensure(), true);
    gate.dispose();
    assert.equal(gate.isReady(), false);
  }
});

test("a patched enqueue method alone does not certify the complete request gate", async () => {
  const { Client, client, create } = fixture();
  const enqueue = Client.prototype.enqueueRequest;
  Client.prototype.enqueueRequest = function (...args) {
    const marker = "__codeyModelWhitelistPatch";
    return marker && enqueue.apply(this, args);
  };
  const partial = Client.prototype.enqueueRequest;
  const gate = create();
  assert.equal(gate.isReady(), false);
  assert.equal(await gate.ensure(), true);
  assert.equal(gate.isReady(), true);
  assert.equal(client.enqueueRequest("turn/start", {}).params.checked, true);
  gate.dispose();
  assert.equal(Client.prototype.enqueueRequest, partial);
});
