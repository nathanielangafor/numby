import { createServer } from "node:http";
import { readFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Store, Failure, hash, phoneOK, verifyWebhook } from "./core.js";
import { Photon, deliveryFailure } from "./provider.js";
import { fileURLToPath } from "node:url";
export function createApp({
  store,
  provider = null,
  origin = "https://numby.io",
  signingSecret = "",
}) {
  const streams = new Map();
  const polls = new Map();
  const waiters = new Map();
  let sending = false;
  const log = (event, extra = {}) =>
    console.log(JSON.stringify({ event, ...extra }));
  function push(account) {
    waiters.get(account)?.check();
    const stream = streams.get(account);
    if (!stream || stream.destroyed) return;
    const job = store.lease(account);
    if (job) stream.write(`event: message\ndata: ${JSON.stringify(job)}\n\n`);
  }
  async function sendPending() {
    if (sending || !provider?.ready) return;
    sending = true;
    try {
      for (const j of store.db
        .prepare(
          "SELECT * FROM jobs WHERE state='outbound' ORDER BY created LIMIT 10",
        )
        .all()) {
        // Disconnect can cancel a later job while a previous provider send awaits.
        const claimed = store.db
          .prepare(
            "UPDATE jobs SET state='sending',updated=? WHERE id=? AND state='outbound'",
          )
          .run(Date.now(), j.id);
        if (!claimed.changes) continue;
        const sendStarted = Date.now();
        try {
          await provider.send(
            store.open(j.payload),
            store.open(j.reply),
            j.operation,
          );
          store.db
            .prepare(
              "UPDATE jobs SET state='sent',payload=NULL,reply=NULL,updated=? WHERE id=?",
            )
            .run(Date.now(), j.id);
          log("reply_sent", { id: j.id, operation: j.operation, elapsedMs: Date.now() - sendStarted });
          push(j.account_id);
        } catch (error) {
          store.db
            .prepare("UPDATE jobs SET state='uncertain',updated=? WHERE id=?")
            .run(Date.now(), j.id);
          log("reply_outcome_uncertain", { id: j.id, operation: j.operation,
            elapsedMs: Date.now() - sendStarted, ...deliveryFailure(error) });
        }
      }
    } finally {
      sending = false;
    }
  }
  if (provider)
    provider
      .connect((s, m) => {
        try {
          const a = store.ingest(s, m);
          if (a) push(a);
        } catch {
          log("inbound_persistence_failed");
          process.exitCode = 1;
          process.kill(process.pid, "SIGTERM");
        }
      })
      .catch(() => {
        log("provider_connection_failed");
        setTimeout(() => process.exit(1), 1000);
      });
  function bearer(req) {
    return /^Bearer ([A-Za-z0-9_-]+)$/.exec(
      req.headers.authorization || "",
    )?.[1];
  }
  async function body(req, maximum = 65536) {
    let n = 0,
      parts = [];
    for await (const chunk of req) {
      n += chunk.length;
      if (n > maximum) throw new Failure(413, "Request too large.");
      parts.push(chunk);
    }
    return Buffer.concat(parts);
  }
  function json(res, status, value) {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(JSON.stringify(value));
  }
  function sameOrigin(req) {
    if (req.headers.origin && req.headers.origin !== origin)
      throw new Failure(403, "Cross-origin request denied.");
  }
  const staticFiles = {
    "/skill.md": "../skills/numby/SKILL.md",
    "/agent-guide": "guide.txt",
    "/agent-guide/": "guide.txt",
    "/agent-guide.txt": "guide.txt",
    "/connector/numby-bridge.py": "../connector/numby-bridge.py",
    "/connector/numby-hook.sh": "../connector/numby-hook.sh",
  };
  const starts = new Set();
  const root = resolve(import.meta.dirname, "../public");
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin),
        path = url.pathname;
      if (req.method === "GET" && staticFiles[path]) {
        const file = staticFiles[path],
          type = file.endsWith(".css")
            ? "text/css"
            : file.endsWith(".js")
              ? "text/javascript"
              : file.endsWith(".html")
                ? "text/html"
                : "text/plain";
        res.writeHead(200, {
          "Content-Type": type + "; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy":
            "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        });
        res.end(readFileSync(join(root, file)));
        return;
      }
      if (path === "/api/health" && req.method === "GET") {
        json(res, 200, { ok: true, provisioning: !!provider?.ready });
        return;
      }
      if (path === "/api/setup/status" && req.method === "GET") {
        sameOrigin(req);
        const credential = bearer(req);
        store.setup(credential);
        store.limit("setup-status:" + hash(credential), 30, 60000);
        json(res, 200, store.setupStatus(credential));
        return;
      }
      if (path === "/api/agent/status" && req.method === "GET") {
        const accountId = store.agent(bearer(req));
        const a = store.db
          .prepare("SELECT assigned FROM accounts WHERE id=?")
          .get(accountId);
        const counts = store.db
          .prepare(
            "SELECT SUM(state IN ('queued','leased','outbound','sending')) pending,SUM(state IN ('uncertain','failed')) attention FROM jobs WHERE account_id=?",
          )
          .get(accountId);
        json(res, 200, {
          assigned: a.assigned,
          shared: true,
          agentConnected: waiters.has(accountId) || !!streams.get(accountId) || Date.now() - (polls.get(accountId) || 0) < 15000,
          pending: !!counts.pending,
          needsAttention: !!counts.attention,
        });
        return;
      }
      if (path === "/api/agent/poll" && req.method === "GET") {
        const accountId = store.agent(bearer(req));
        const wait = Number(url.searchParams.get("wait") || 0);
        if (!Number.isInteger(wait) || wait < 0 || wait > 20)
          throw new Failure(400, "wait must be an integer from 0 to 20 seconds.");
        store.limit("poll:" + accountId, 120, 60000);
        if (waiters.has(accountId))
          throw new Failure(409, "A delivery request is already waiting. Run one listener.");
        polls.set(accountId, Date.now());
        const message = store.lease(accountId);
        if (message || !wait) {
          json(res, 200, { message });
          return;
        }
        let timer;
        const cleanup = () => {
          clearTimeout(timer);
          if (waiters.get(accountId) === waiter) waiters.delete(accountId);
        };
        const finish = (status, value) => {
          cleanup();
          if (!res.destroyed && !res.writableEnded) {
            polls.set(accountId, Date.now());
            json(res, status, value);
          }
        };
        const waiter = {
          finish,
          check(expired = false) {
            if (res.destroyed || res.writableEnded) { cleanup(); return; }
            try {
              // Recheck the credential before leasing, including after replacement.
              store.agent(bearer(req));
              const message = store.lease(accountId);
              if (message || expired) finish(200, { message });
            } catch (e) {
              finish(e.status || 500, { error: e.status ? e.message : "Delivery unavailable." });
            }
          },
        };
        waiters.set(accountId, waiter);
        timer = setTimeout(() => waiter.check(true), wait * 1000);
        res.once("close", cleanup);
        return;
      }
      if (path === "/api/agent/events" && req.method === "GET") {
        const a = store.agent(bearer(req));
        streams.get(a)?.end();
        streams.set(a, res);
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.write(": connected\n\n");
        push(a);
        const heartbeat = setInterval(() => {
          try {
            if (store.agent(bearer(req)) !== a) res.end();
            else res.write(": keepalive\n\n");
          } catch {
            res.end();
          }
        }, 20000);
        res.on("close", () => {
          clearInterval(heartbeat);
          if (streams.get(a) === res) streams.delete(a);
        });
        return;
      }
      if (req.method !== "POST") throw new Failure(404, "Not found.");
      const mediaOperation = ["/api/agent/send-content", "/api/agent/reply-content"].includes(path);
      if (mediaOperation) {
        const account = store.agent(bearer(req));
        store.limit("media:" + account, 12, 60000);
      }
      const raw = await body(req, mediaOperation ? 15 * 1024 * 1024 : 65536);
      if (path === "/api/photon/webhook") {
        if (!signingSecret) throw new Failure(503, "Webhook not configured.");
        if (!verifyWebhook(raw, req.headers, signingSecret))
          throw new Failure(401, "Invalid signature.");
        let p;
        try {
          p = JSON.parse(raw);
        } catch {
          throw new Failure(400, "Invalid JSON.");
        }
        if (p.event !== "messages" || !p.message || !p.space)
          throw new Failure(422, "Unsupported webhook schema.");
        const a = store.ingest(p.space, p.message);
        json(res, 200, { ok: true });
        if (a) push(a);
        return;
      }
      let input;
      try {
        input = JSON.parse(raw);
      } catch {
        throw new Failure(400, "Invalid JSON.");
      }
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Failure(400, "JSON object required.");
      sameOrigin(req);
      const ipKey = hash(
        String(req.headers["x-real-ip"] || req.socket.remoteAddress),
      );
      if (path === "/api/setup/bootstrap") {
        store.limit("bootstrap-ip:" + ipKey, 10, 3600e3);
        store.limit("bootstrap-global", 100, 3600e3);
        json(res, 201, store.bootstrap(input.purpose));
        return;
      }
      if (path === "/api/setup/start") {
        const credential = bearer(req),
          setup = store.setup(credential);
        if (input.consent !== true)
          throw new Failure(
            400,
            "Ask the owner for permission to use their phone for Numby routing, then send consent: true.",
          );
        if (!phoneOK(input.phone))
          throw new Failure(
            400,
            "Use the owner's phone number with country code.",
          );
        if (setup.account_id) {
          if (setup.phone !== input.phone)
            throw new Failure(409, "This setup is already bound to a phone.");
          json(res, 200, store.setupStatus(credential));
          return;
        }
        store.limit("start-ip:" + ipKey, 5, 3600e3);
        store.limit("start-phone:" + hash(input.phone), 3, 15 * 60e3);
        store.limit("start-global", 20, 3600e3);
        if (!provider?.ready)
          throw new Failure(
            503,
            "Phone setup is temporarily unavailable. Try again shortly.",
          );
        const existing = store.db
          .prepare("SELECT * FROM accounts WHERE phone=?")
          .get(input.phone);
        if (
          !existing &&
          store.db
            .prepare("SELECT COUNT(*) n FROM accounts WHERE verified=0")
            .get().n >= 10
        )
          throw new Failure(
            503,
            "New setup is temporarily at capacity. Try again later.",
          );
        // Bound concurrent provider allocations, including the same setup using two phones.
        const keys = [
          "phone:" + hash(input.phone),
          "setup:" + setup.token_hash,
        ];
        if (keys.some((k) => starts.has(k)))
          throw new Failure(
            409,
            "Setup is in progress. Retry this request shortly.",
          );
        keys.forEach((k) => starts.add(k));
        try {
          // Photon shared-user creation is idempotent by phone. Reconcile on
          // every new setup: a local account may outlive its provider routing.
          const allocation = await provider.allocate(input.phone);
          if (!phoneOK(allocation.assignedPhoneNumber) || !allocation.id)
            throw new Failure(502, "The provider could not assign a number.");
          json(res, 200, store.begin(input.phone, allocation, credential));
        } finally {
          keys.forEach((k) => starts.delete(k));
        }
        return;
      }
      if (path === "/api/setup/cancel") {
        const s = store.setup(bearer(req));
        store.db
          .prepare("DELETE FROM setups WHERE token_hash=?")
          .run(s.token_hash);
        json(res, 200, { cancelled: true });
        return;
      }
      if (path === "/api/setup/claim" || path === "/api/setup/disconnect") {
        const credential = bearer(req);
        store.setup(credential);
        store.limit("setup-complete:" + hash(credential), 10, 60000);
        const result = store.completeSetup(
          credential,
          path.endsWith("/claim") ? "connect" : "disconnect",
          input.replace,
        );
        streams.get(result.accountId)?.end();
        waiters.get(result.accountId)?.check();
        const { accountId, ...publicResult } = result;
        json(res, 200, publicResult);
        return;
      }
      if (path === "/api/agent/disconnect") {
        const accountId = store.agent(bearer(req));
        store.revoke(accountId);
        streams.get(accountId)?.end();
        waiters.get(accountId)?.check();
        json(res, 200, { disconnected: true });
        return;
      }
      if (["/api/agent/download", "/api/agent/typing"].includes(path)) {
        const a = store.agent(bearer(req));
        store.limit("auxiliary:" + a, 60, 60000);
        if (typeof input.id !== "string" || typeof input.lease !== "string" ||
            Object.keys(input).some(k => !["id", "lease", ...(path.endsWith("/typing") ? ["active"] : [])].includes(k)))
          throw new Failure(400, "Invalid message operation.");
        const payload = store.leasedPayload(a, input.id, input.lease);
        if (!provider?.ready) throw new Failure(503, "Provider unavailable.");
        if (path.endsWith("/typing")) {
          if (typeof input.active !== "boolean") throw new Failure(400, "active must be boolean.");
          await provider.signal(payload, input.active);
          json(res, 200, {ok: true});
        } else {
          if (!["attachment", "voice"].includes(payload.message.content.type)) throw new Failure(400, "This event has no attachment.");
          const data = await provider.download(payload);
          // Revalidate after downloading in case ownership or the lease changed.
          store.leasedPayload(a, input.id, input.lease);
          store.agent(bearer(req));
          res.writeHead(200, {"Content-Type": "application/octet-stream", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Length": data.length});
          res.end(data);
        }
        return;
      }
      if (
        [
          "/api/agent/send-content",
          "/api/agent/reply-content",
          "/api/agent/send",
          "/api/agent/reply",
          "/api/agent/react",
          "/api/agent/ack",
        ].includes(path)
      ) {
        const a = store.agent(bearer(req));
        store.limit("reply:" + a, 120, 60000);
        if (typeof input.id !== "string" || typeof input.lease !== "string")
          throw new Failure(400, "Message and lease required.");
        const operation = path.split("/").at(-1);
        const fields = [
          "id",
          "lease",
          ...(operation.endsWith("-content") ? ["parts"] : operation === "react"
            ? ["emoji"]
            : operation === "ack"
              ? []
              : ["text"]),
        ];
        if (Object.keys(input).some((k) => !fields.includes(k)))
          throw new Failure(
            400,
            "Unsupported message fields; target comes from the leased event.",
          );
        const state = store.reply(
          a,
          input.id,
          input.lease,
          operation.endsWith("-content") ? input.parts : operation === "react" ? input.emoji : input.text,
          operation,
        );
        json(res, 202, { state });
        if (operation === "ack") push(a);
        else void sendPending();
        return;
      }
      throw new Failure(404, "Not found.");
    } catch (e) {
      json(res, e.status || 500, {
        error: e.status ? e.message : "Something went wrong. Please try again.",
      });
      if (!e.status) log("request_failed");
    }
  });
  server.headersTimeout = 15000;
  server.requestTimeout = 20000;
  server.keepAliveTimeout = 5000;
  const recovery = setInterval(() => {
    for (const [id, seen] of polls) {
      if (Date.now() - seen >= 15000) polls.delete(id);
    }
    for (const a of new Set([...streams.keys(), ...waiters.keys()])) push(a);
    void sendPending();
  }, 30000);
  const cleanup = setInterval(() => store.cleanup(), 3600000);
  recovery.unref();
  cleanup.unref();
  store.cleanup();
  server.on("close", () => {
    clearInterval(recovery);
    clearInterval(cleanup);
  });
  return {
    server,
    closeStreams: () => {
      for (const r of streams.values()) r.end();
      for (const w of waiters.values()) w.finish(503, { error: "Server restarting." });
    },
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const data = process.env.DATA_DIR || "./data";
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const store = new Store(join(data, "numby.sqlite"), process.env.DATA_KEY);
  const provider = process.env.PHOTON_PROJECT_SECRET
    ? new Photon(
        process.env.PHOTON_PROJECT_ID,
        process.env.PHOTON_PROJECT_SECRET,
      )
    : null;
  const app = createApp({
    store,
    provider,
    origin: process.env.PUBLIC_ORIGIN || "https://numby.io",
    signingSecret: process.env.PHOTON_SIGNING_SECRET,
  });
  app.server.listen(Number(process.env.PORT || 3000), "127.0.0.1", () =>
    console.log(JSON.stringify({ event: "server_started" })),
  );
  process.on("SIGTERM", () => {
    app.closeStreams();
    app.server.close(() => {
      store.db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
