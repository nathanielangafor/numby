import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Store, verifyWebhook, hash } from "../src/core.js";
const key = "a".repeat(64);
function begin(s, phone, allocation) {
  const { setupToken } = s.bootstrap();
  return { ...s.begin(phone, allocation, setupToken), session: setupToken };
}
function setup() {
  let now = 1000000;
  const s = new Store(":memory:", key, () => now);
  const owner = begin(s, "+12405550101", {
    id: "p1",
    assignedPhoneNumber: "+14155550100",
  });
  const owner2 = begin(s, "+12405550102", {
    id: "p2",
    assignedPhoneNumber: "+14155550101",
  });
  const space = {
    id: "dm1",
    platform: "imessage",
    type: "dm",
    phone: "shared",
  };
  const msg = (id, text, phone = "+12405550101") => ({
    id,
    direction: "inbound",
    sender: { id: phone },
    content: { type: "text", text },
  });
  s.ingest(space, msg("verify1", owner.challenge));
  s.ingest(space, msg("verify2", owner2.challenge, "+12405550102"));
  s.db.prepare("UPDATE accounts SET verified=1").run();
  return {
    s,
    owner,
    owner2,
    space,
    msg,
    advance: (n) => {
      now += n;
    },
  };
}
test("signature authenticates raw bytes and rejects tampering, stale time, missing header", () => {
  const raw = Buffer.from('{"event":"messages"}'),
    ts = String(Math.floor(Date.now() / 1000)),
    secret = "secret";
  const headers = {
    "x-spectrum-timestamp": ts,
    "x-spectrum-signature":
      "v0=" +
      createHmac("sha256", secret)
        .update(`v0:${ts}:`)
        .update(raw)
        .digest("hex"),
  };
  assert.ok(verifyWebhook(raw, headers, secret));
  assert.equal(verifyWebhook(Buffer.from("{}"), headers, secret), false);
  assert.equal(verifyWebhook(raw, headers, secret, Date.now() + 301000), false);
  assert.equal(verifyWebhook(raw, {}, secret), false);
});
test("phone verification requires matching sender, challenge, and line", () => {
  const s = new Store(":memory:", key);
  const p = begin(s, "+12405550101", {
    id: "p",
    assignedPhoneNumber: "+14155550100",
  });
  const message = {
    id: "m",
    direction: "inbound",
    sender: { id: "+12405550102" },
    content: { type: "text", text: p.challenge },
  };
  s.ingest({ platform: "imessage", type: "dm", phone: "shared" }, message);
  assert.throws(() => s.setup(p.session, true), /ownership/);
  message.sender.id = "+12405550101";
  s.ingest(
    { platform: "imessage", type: "dm", phone: "+14155559999" },
    message,
  );
  assert.throws(() => s.setup(p.session, true));
  s.ingest({ platform: "imessage", type: "dm", phone: "shared" }, message);
  assert.equal(s.setup(p.session, true).verified, 1);
  s.db.close();
});
test("claim is single use and fresh replacement proof revokes only the old account token", () => {
  const { s, owner, owner2, space, msg, advance } = setup();
  const first = s.completeSetup(owner.session, "connect");
  const other = s.completeSetup(owner2.session, "connect");
  assert.ok(s.agent(first.token));
  assert.throws(() => s.completeSetup(owner.session, "connect"));
  const next = begin(s, "+12405550101", { id: "p1", assignedPhoneNumber: "+14155550100" });
  assert.throws(
    () => s.completeSetup(next.session, "connect", true),
    /ownership/,
  );
  assert.ok(s.agent(first.token));
  s.ingest(space, msg("verify-new", next.challenge));
  assert.throws(
    () => s.completeSetup(next.session, "connect"),
    /already paired/,
  );
  const newer = s.completeSetup(next.session, "connect", true);
  assert.throws(() => s.agent(first.token));
  assert.ok(s.agent(newer.token));
  assert.ok(s.agent(other.token));
  const expired = begin(s, "+12405550101", { id: "p1", assignedPhoneNumber: "+14155550100" });
  s.ingest(space, msg("verify-expired", expired.challenge));
  advance(900000);
  assert.throws(() => s.completeSetup(expired.session, "connect", true));
  s.db.close();
});
test("dedup, tenant isolation, expiring leases, and reply idempotency", () => {
  const { s, owner, owner2, space, msg, advance } = setup();
  const a = s.setup(owner.session).account_id,
    b = s.setup(owner2.session).account_id;
  s.ingest(space, msg("m1", "hello"));
  assert.equal(s.ingest(space, msg("m1", "hello")), null);
  assert.equal(s.lease(b), null);
  const job = s.lease(a);
  assert.equal(s.lease(a), null);
  assert.throws(() => s.reply(b, job.id, job.lease, "bad"));
  advance(601000);
  const retry = s.lease(a);
  assert.notEqual(job.lease, retry.lease);
  assert.throws(() => s.reply(a, job.id, job.lease, "old"));
  assert.equal(s.reply(a, retry.id, retry.lease, "answer"), "outbound");
  assert.equal(s.reply(a, retry.id, retry.lease, "answer"), "outbound");
  assert.throws(() => s.reply(a, retry.id, retry.lease, "different"));
  s.db.close();
});
test("queued content encrypted and purged after 24h while dedupe remains", () => {
  const { s, space, msg, advance } = setup();
  s.ingest(space, msg("m", "private text"));
  assert.ok(
    !s.db
      .prepare("SELECT payload FROM jobs")
      .get()
      .payload.includes("private text"),
  );
  advance(86400001);
  s.cleanup();
  const j = s.db.prepare("SELECT * FROM jobs").get();
  assert.equal(j.payload, null);
  assert.equal(j.state, "expired");
  assert.equal(s.ingest(space, msg("m", "private text")), null);
  s.db.close();
});
test("rate limits enforce windows", () => {
  const { s, advance } = setup();
  s.limit("x", 1, 1000);
  assert.throws(() => s.limit("x", 1, 1000), /Too many/);
  advance(1001);
  s.limit("x", 1, 1000);
  s.db.close();
});
test("outbound jobs serialize account work until sending completes", () => {
  const { s, owner, space, msg } = setup();
  const a = s.setup(owner.session).account_id;
  s.ingest(space, msg("first", "first"));
  s.ingest(space, msg("second", "second"));
  const first = s.lease(a);
  assert.equal(first.id, "first");
  assert.equal(s.lease(a), null);
  s.reply(a, first.id, first.lease, "answer");
  assert.equal(s.lease(a), null);
  s.db.prepare("UPDATE jobs SET state='sent' WHERE id='first'").run();
  assert.equal(s.lease(a).id, "second");
  s.db.close();
});
test("concurrent proofs are invalidated by claim; cancel cannot revoke an active agent", () => {
  const { s, owner, space, msg } = setup();
  const parallel = begin(s, "+12405550101", { id: "p1", assignedPhoneNumber: "+14155550100" });
  s.ingest(space, msg("parallel", parallel.challenge));
  const a = s.completeSetup(owner.session, "connect");
  assert.throws(() => s.completeSetup(parallel.session, "connect", true));
  const cancelled = s.bootstrap();
  s.db
    .prepare("DELETE FROM setups WHERE token_hash=?")
    .run(hash(cancelled.setupToken));
  assert.ok(s.agent(a.token));
  assert.throws(() => s.setup(cancelled.setupToken));
  s.db.close();
});
test("agent disconnect invalidates pending proof and unsent jobs but not another tenant", () => {
  const { s, owner, owner2, space, msg } = setup();
  const a = s.completeSetup(owner.session, "connect"),
    b = s.completeSetup(owner2.session, "connect");
  const pending = begin(s, "+12405550101", { id: "p1", assignedPhoneNumber: "+14155550100" });
  s.ingest(space, msg("queued-disconnect", "private"));
  const leased = s.lease(a.accountId);
  s.reply(a.accountId, leased.id, leased.lease, "answer");
  s.revoke(a.accountId);
  assert.throws(() => s.agent(a.token));
  assert.ok(s.agent(b.token));
  assert.throws(() => s.setup(pending.session));
  const job = s.db.prepare("SELECT * FROM jobs WHERE id=?").get(leased.id);
  assert.equal(job.state, "expired");
  assert.equal(job.payload, null);
  assert.equal(job.reply, null);
  assert.equal(s.ingest(space, msg("after-disconnect", "ignored")), null);
  s.db.close();
});
test("pending challenge expires, is consumed once, and never verifies a second setup", () => {
  const { s, space, msg, advance } = setup();
  const p = begin(s, "+12405550101", { id: "p1", assignedPhoneNumber: "+14155550100" });
  advance(900000);
  s.ingest(space, msg("late", p.challenge));
  assert.throws(() => s.setup(p.session, true));
  const fresh = begin(s, "+12405550101", { id: "p1", assignedPhoneNumber: "+14155550100" });
  s.ingest(space, msg("old-replay", p.challenge));
  assert.throws(() => s.setup(fresh.session, true));
  s.ingest(space, msg("fresh", fresh.challenge));
  assert.equal(s.setup(fresh.session, true).challenge, null);
  const another = begin(s, "+12405550101", { id: "p1", assignedPhoneNumber: "+14155550100" });
  s.ingest(space, msg("fresh-replay", fresh.challenge));
  assert.throws(() => s.setup(another.session, true));
  s.db.close();
});
test("thread/reaction operations enforce tenant, lease, idempotency and supported targets", () => {
  const { s, owner, owner2, space, msg } = setup();
  const a = s.setup(owner.session).account_id,
    b = s.setup(owner2.session).account_id;
  s.ingest(space, msg("thread", "hello"));
  const job = s.lease(a);
  assert.throws(() => s.reply(b, job.id, job.lease, "👍", "react"));
  assert.throws(() => s.reply(a, job.id, "wrong", "👍", "react"));
  assert.throws(() => s.reply(a, job.id, job.lease, "not emoji", "react"));
  assert.equal(s.reply(a, job.id, job.lease, "👍", "react"), "outbound");
  assert.equal(s.reply(a, job.id, job.lease, "👍", "react"), "outbound");
  assert.throws(() => s.reply(a, job.id, job.lease, "👍", "send"), /different/);
  assert.equal(
    s.db.prepare("SELECT operation FROM jobs WHERE id=?").get(job.id).operation,
    "react",
  );
  s.db.prepare("UPDATE jobs SET state='sent' WHERE id=?").run(job.id);
  s.ingest(space, {
    ...msg("reaction", ""),
    content: { type: "reaction", emoji: "❤️", targetId: "thread" },
  });
  const r = s.lease(a);
  assert.equal(r.kind, "reaction");
  assert.equal(r.emoji, "❤️");
  assert.equal(r.text, undefined);
  assert.throws(() => s.reply(a, r.id, r.lease, "👍", "react"), /cannot/);
  assert.throws(() => s.reply(a, r.id, r.lease, "text", "reply"), /cannot/);
  assert.equal(s.reply(a, r.id, r.lease, undefined, "ack"), "sent");
  assert.equal(
    s.db.prepare("SELECT payload FROM jobs WHERE id=?").get(r.id).payload,
    null,
  );
  s.db.close();
});
