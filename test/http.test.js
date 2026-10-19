import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core.js";
import { createApp } from "../src/server.js";
const phone = "+12405550101";
const assigned = "+14155550100";

test("agent-led HTTP: bootstrap, consent, proof, claim, isolation, SSE, reply, recovery and revocation", async () => {
  let now = Date.now(),
    allocations = 0,
    receive,
    sends = [];
  const store = new Store(":memory:", "b".repeat(64), () => now);
  const provider = {
    ready: true,
    async connect(fn) {
      receive = fn;
    },
    async allocate() {
      allocations++;
      return { id: "provider", assignedPhoneNumber: assigned };
    },
    async send(payload, text) {
      sends.push(text);
    },
  };
  const { server, closeStreams } = createApp({ store, provider });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  const request = (path, body, token, extra = {}) =>
    fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...extra,
      },
      redirect: "manual",
    });
  const bootstrap = async (purpose) => {
    const r = await request("/api/setup/bootstrap", {
      purpose: purpose || "connect",
    });
    assert.equal(r.status, 201);
    return (await r.json()).setupToken;
  };
  const verify = (challenge, sender = phone, line = "shared") =>
    receive(
      { id: "dm", platform: "imessage", type: "dm", phone: line },
      {
        id: crypto.randomUUID(),
        direction: "inbound",
        sender: { id: sender },
        content: { type: "text", text: challenge },
      },
    );
  try {
    for (const path of ["/setup", "/setup/", "/setup/setup.js"]) {
      const r = await request(path);
      assert.equal(r.status, 404);
      assert.equal(r.headers.get("location"), null);
    }
    assert.equal(
      (await request("/api/agent/pair", { code: "exposed-old-code" })).status,
      404,
    );
    assert.equal((await request("/api/agent/events")).status, 401);
    assert.equal((await request("/api/setup/status")).status, 401);
    assert.equal(
      (
        await request("/api/setup/bootstrap", {}, null, {
          Origin: "https://evil.example",
        })
      ).status,
      403,
    );
    assert.equal((await request("/api/setup/bootstrap", [])).status, 400);
    assert.equal(
      (await request("/api/setup/bootstrap", { purpose: "invalid" })).status,
      400,
    );
    const setup = await bootstrap();
    assert.equal(
      (await request("/api/setup/status", undefined, setup)).headers.get(
        "cache-control",
      ),
      "no-store",
    );
    assert.equal(
      (await request("/api/agent/status", undefined, setup)).status,
      401,
    );
    assert.equal((await request("/api/setup/claim", {}, setup)).status, 403);
    assert.equal(
      (await request("/api/setup/start", { phone, consent: true })).status,
      401,
    );
    assert.equal(
      (await request("/api/setup/start", { phone }, setup)).status,
      400,
    );
    assert.equal(
      (
        await request(
          "/api/setup/start",
          { phone: "invalid", consent: true },
          setup,
        )
      ).status,
      400,
    );
    const start = await (
      await request("/api/setup/start", { phone, consent: true }, setup)
    ).json();
    assert.equal(start.state, "awaiting_verification");
    assert.equal(start.replacementRequired, undefined);
    assert.equal(
      (
        await (
          await request("/api/setup/start", { phone, consent: true }, setup)
        ).json()
      ).challenge,
      start.challenge,
    );
    assert.equal(allocations, 1);
    assert.equal(
      (
        await request(
          "/api/setup/start",
          { phone: "+12405550102", consent: true },
          setup,
        )
      ).status,
      409,
    );
    verify(start.challenge, "+12405550102");
    verify(start.challenge, phone, "+14155559999");
    assert.equal((await request("/api/setup/claim", {}, setup)).status, 403);
    verify(start.challenge);
    const verified = await (
      await request("/api/setup/status", undefined, setup)
    ).json();
    assert.equal(verified.state, "verified");
    assert.equal(verified.challenge, undefined);
    const credential = await (
      await request("/api/setup/claim", {}, setup)
    ).json();
    assert.ok(credential.token);
    assert.equal(credential.shared, true);
    assert.equal((await request("/api/setup/claim", {}, setup)).status, 401);
    assert.equal(
      (await request("/api/setup/status", undefined, credential.token)).status,
      401,
    );
    assert.equal(
      (
        await request(
          "/api/agent/reply",
          { id: "missing", lease: "x", text: "x" },
          credential.token,
        )
      ).status,
      404,
    );
    const stream = await request(
      "/api/agent/events",
      undefined,
      credential.token,
    );
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    await reader.read();
    verify("ordinary text");
    const event = new TextDecoder().decode((await reader.read()).value);
    const job = JSON.parse(event.match(/data: (.+)/)[1]);
    const reply = await request(
      "/api/agent/reply",
      { id: job.id, lease: job.lease, text: "real adapter test" },
      credential.token,
    );
    assert.equal(reply.status, 202);
    assert.deepEqual(sends, ["real adapter test"]);
    assert.equal(
      (
        await request(
          "/api/agent/reply",
          { id: job.id, lease: job.lease, text: "different" },
          credential.token,
        )
      ).status,
      409,
    );
    for (const operation of ["send", "react", "ack"]) {
      verify("operation " + operation);
      const frame = new TextDecoder().decode((await reader.read()).value);
      const nextJob = JSON.parse(frame.match(/data: (.+)/)[1]);
      const payload = {
        id: nextJob.id,
        lease: nextJob.lease,
        ...(operation === "react"
          ? { emoji: "👍" }
          : operation === "ack"
            ? {}
            : { text: "normal text" }),
      };
      assert.equal(
        (
          await request(
            "/api/agent/" + operation,
            { ...payload, target: "other-tenant" },
            credential.token,
          )
        ).status,
        400,
      );
      assert.equal(
        (await request("/api/agent/" + operation, payload, credential.token))
          .status,
        202,
      );
    }
    await reader.cancel();
    const recover = await bootstrap();
    const rs = await (
      await request("/api/setup/start", { phone, consent: true }, recover)
    ).json();
    assert.equal(
      (await request("/api/setup/claim", { replace: true }, recover)).status,
      403,
    );
    assert.equal(
      (await request("/api/agent/status", undefined, credential.token)).status,
      200,
    );
    verify(rs.challenge);
    assert.equal((await request("/api/setup/claim", {}, recover)).status, 409);
    const next = await (
      await request("/api/setup/claim", { replace: true }, recover)
    ).json();
    assert.ok(next.token);
    assert.equal(allocations, 2);
    assert.equal(
      (await request("/api/agent/status", undefined, credential.token)).status,
      401,
    );
    const disconnect = await bootstrap("disconnect");
    const ds = await (
      await request("/api/setup/start", { phone, consent: true }, disconnect)
    ).json();
    assert.equal(
      (await request("/api/setup/disconnect", {}, disconnect)).status,
      403,
    );
    verify(ds.challenge);
    assert.equal(
      (await request("/api/setup/claim", {}, disconnect)).status,
      409,
    );
    assert.equal(
      (await request("/api/setup/disconnect", {}, disconnect)).status,
      200,
    );
    assert.equal(
      (await request("/api/agent/status", undefined, next.token)).status,
      401,
    );
    assert.equal(
      (await request("/api/setup/disconnect", {}, disconnect)).status,
      401,
    );
    const expired = await bootstrap();
    now += 900000;
    assert.equal(
      (await request("/api/setup/status", undefined, expired)).status,
      401,
    );
    const cancelled = await bootstrap();
    assert.equal(
      (await request("/api/setup/cancel", {}, cancelled)).status,
      200,
    );
    assert.equal(
      (await request("/api/setup/status", undefined, cancelled)).status,
      401,
    );
    assert.equal((await request("/api/photon/webhook", {})).status, 503);
  } finally {
    closeStreams();
    await new Promise((r) => server.close(r));
    store.db.close();
  }
});

test("HTTP rate limiting and provider unavailable fail closed", async () => {
  const store = new Store(":memory:", "b".repeat(64));
  const { server } = createApp({ store });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  const post = (path, body, token) =>
    fetch(base + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      body: JSON.stringify(body),
    });
  try {
    const b = await (await post("/api/setup/bootstrap", {})).json();
    assert.equal(
      (await post("/api/setup/start", { phone, consent: true }, b.setupToken))
        .status,
      503,
    );
    for (let i = 0; i < 9; i++)
      assert.equal((await post("/api/setup/bootstrap", {})).status, 201);
    assert.equal((await post("/api/setup/bootstrap", {})).status, 429);
  } finally {
    await new Promise((r) => server.close(r));
    store.db.close();
  }
});


test("new setup reconciles stale provider routing and fails closed on provider outage", async () => {
  const store = new Store(":memory:", "b".repeat(64));
  const old = store.bootstrap();
  store.begin(phone, {id: "removed-provider-user", assignedPhoneNumber: assigned}, old.setupToken);
  let fail = true, calls = 0;
  const currentNumber = "+14155550199";
  const provider = {
    ready: true,
    async connect() {},
    async allocate(value) {
      calls++;
      assert.equal(value, phone);
      if (fail) throw new Error("provider unavailable");
      return {id: "current-provider-user", assignedPhoneNumber: currentNumber};
    },
  };
  const {server} = createApp({store, provider});
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const fresh = store.bootstrap();
  const start = () => fetch(`http://127.0.0.1:${server.address().port}/api/setup/start`, {
    method: "POST", headers: {"Content-Type": "application/json", Authorization: `Bearer ${fresh.setupToken}`},
    body: JSON.stringify({phone, consent: true}),
  });
  try {
    assert.equal((await start()).status, 500);
    assert.equal(store.setupStatus(fresh.setupToken).state, "awaiting_phone");
    fail = false;
    const response = await start();
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.assigned, currentNumber);
    assert.equal(result.state, "awaiting_verification");
    assert.equal(store.db.prepare("SELECT provider_id FROM accounts").get().provider_id, "current-provider-user");
    const retry = await (await start()).json();
    assert.equal(retry.challenge, result.challenge);
    assert.equal(calls, 2);
    assert.throws(() => store.completeSetup(fresh.setupToken, "connect"), /challenge/);
  } finally {
    await new Promise(r => server.close(r));
    store.db.close();
  }
});

test("finite polling authenticates, isolates tenants and preserves exclusive leases", async () => {
  let now = Date.now();
  const store = new Store(":memory:", "b".repeat(64), () => now);
  function paired(owner) {
    const setup = store.bootstrap();
    const result = store.begin(owner, {id: owner, assignedPhoneNumber: assigned}, setup.setupToken);
    store.ingest({platform: "imessage", type: "dm", phone: "shared", id: owner}, {
      id: crypto.randomUUID(), direction: "inbound", sender: {id: owner}, content: {type: "text", text: result.challenge},
    });
    return store.completeSetup(setup.setupToken, "connect").token;
  }
  const credential = paired(phone), other = paired("+12405550102");
  store.ingest({platform: "imessage", type: "dm", phone: "shared", id: "owner-dm"}, {
    id: "poll-message", direction: "inbound", sender: {id: phone}, content: {type: "text", text: "poll test"},
  });
  const {server} = createApp({store});
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const get = (path, token) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {headers: token ? {Authorization: `Bearer ${token}`} : {}});
  try {
    assert.equal((await get("/api/agent/poll")).status, 401);
    assert.equal((await get("/api/agent/poll", store.bootstrap().setupToken)).status, 401);
    assert.equal((await (await get("/api/agent/poll", other)).json()).message, null);
    const response = await get("/api/agent/poll", credential);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const first = (await response.json()).message;
    assert.equal(first.text, "poll test");
    assert.equal((await (await get("/api/agent/status", credential)).json()).agentConnected, true);
    assert.equal((await (await get("/api/agent/poll", credential)).json()).message, null);
    now += 600001;
    const retry = (await (await get("/api/agent/poll", credential)).json()).message;
    assert.equal(retry.id, first.id);
    assert.notEqual(retry.lease, first.lease);
    store.revoke(store.agent(credential));
    assert.equal((await get("/api/agent/poll", credential)).status, 401);
  } finally {
    await new Promise(r => server.close(r)); store.db.close();
  }
});

test("long polling delivers on arrival, handles idle, duplicate, abort and revocation", async () => {
  const store = new Store(":memory:", "b".repeat(64));
  let receive;
  const {server, closeStreams} = createApp({store, provider: {
    ready: true, async connect(fn) { receive = fn; }, async send() {},
  }});
  const setup = store.bootstrap();
  const challenge = store.begin(phone, {id: phone, assignedPhoneNumber: assigned}, setup.setupToken).challenge;
  const inbound = text => receive({platform: "imessage", type: "dm", phone: "shared", id: "dm"}, {
    id: crypto.randomUUID(), direction: "inbound", sender: {id: phone}, content: {type: "text", text},
  });
  inbound(challenge);
  const token = store.completeSetup(setup.setupToken, "connect").token;
  const account = store.agent(token);
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path, signal) => fetch(base + path, {headers: {Authorization: `Bearer ${token}`}, signal});
  // Synchronize on request registration, not a guessed network sleep.
  const registered = () => new Promise(resolve => server.once("request", resolve));
  try {
    for (const wait of ["-1", "21", "foo", "0.5"])
      assert.equal((await get('/api/agent/poll?wait=' + wait)).status, 400);
    let ready = registered();
    const pending = get('/api/agent/poll?wait=20');
    await ready;
    assert.equal((await get('/api/agent/poll?wait=20')).status, 409);
    assert.equal((await (await get('/api/agent/status')).json()).agentConnected, true);
    const start = performance.now();
    inbound('immediate arrival');
    const job = (await (await pending).json()).message;
    const elapsed = performance.now() - start;
    assert.equal(job.text, 'immediate arrival');
    assert.ok(elapsed < 1000, `delivery took ${elapsed}ms`);
    console.log(`long-poll arrival delivered in ${elapsed.toFixed(1)}ms`);
    assert.equal((await (await get('/api/agent/poll')).json()).message, null);
    store.reply(account, job.id, job.lease, undefined, 'ack');
    const idleStart = performance.now();
    assert.equal((await (await get('/api/agent/poll?wait=1')).json()).message, null);
    assert.ok(performance.now() - idleStart >= 900);
    const abort = new AbortController();
    ready = registered();
    const cancelled = get('/api/agent/poll?wait=20', abort.signal);
    await ready;
    abort.abort();
    await assert.rejects(cancelled, {name: 'AbortError'});
    // Wait until the server observes socket closure before the next delivery.
    await new Promise(resolve => setTimeout(resolve, 50));
    inbound('after client disconnect');
    const after = (await (await get('/api/agent/poll')).json()).message;
    assert.equal(after.text, 'after client disconnect');
    store.reply(account, after.id, after.lease, undefined, 'ack');
    ready = registered();
    const revoked = get('/api/agent/poll?wait=20');
    await ready;
    await fetch(base + '/api/agent/disconnect', {method:'POST', headers:{Authorization:`Bearer ${token}`, 'Content-Type':'application/json'}, body:'{}'});
    assert.equal((await revoked).status, 401);
  } finally {
    closeStreams();
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    store.db.close();
  }
});
