import { validateParts } from "./media.js";
import { DatabaseSync } from "node:sqlite";
import {
  randomBytes,
  randomUUID,
  createHash,
  createHmac,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
export const token = () => randomBytes(32).toString("base64url");
export const hash = (x) => createHash("sha256").update(x).digest("hex");
export const phoneOK = (x) =>
  typeof x === "string" && /^\+[1-9]\d{6,14}$/.test(x);
export class Failure extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export function verifyWebhook(raw, headers, secret, now = Date.now()) {
  if (!secret) return false;
  const timestamp = headers["x-spectrum-timestamp"];
  if (
    !/^\d+$/.test(timestamp || "") ||
    Math.abs(now / 1000 - Number(timestamp)) > 300
  )
    return false;
  const expected =
    "v0=" +
    createHmac("sha256", secret)
      .update(`v0:${timestamp}:`)
      .update(raw)
      .digest("hex");
  const actual = headers["x-spectrum-signature"] || "";
  return (
    Buffer.byteLength(actual) === expected.length &&
    timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
  );
}
export class Store {
  constructor(file, key, clock = () => Date.now()) {
    if (!/^[a-f0-9]{64}$/.test(key))
      throw new Error("A 32-byte encryption key is required");
    this.key = Buffer.from(key, "hex");
    this.now = clock;
    this.db = new DatabaseSync(file);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,phone TEXT UNIQUE NOT NULL,assigned TEXT NOT NULL,provider_id TEXT NOT NULL,verified INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agents(token_hash TEXT PRIMARY KEY,account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id),created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),payload TEXT,state TEXT NOT NULL DEFAULT 'queued',lease TEXT,lease_until INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,reply TEXT,reply_hash TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_account_state ON jobs(account_id,state,created);
      CREATE TABLE IF NOT EXISTS limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS setups(token_hash TEXT PRIMARY KEY,account_id TEXT REFERENCES accounts(id),challenge_hash TEXT,challenge TEXT,expires INTEGER NOT NULL,verified INTEGER NOT NULL DEFAULT 0,purpose TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS setups_account ON setups(account_id);
      PRAGMA user_version=2;`);
    if (
      !this.db
        .prepare("PRAGMA table_info(jobs)")
        .all()
        .some((c) => c.name === "operation")
    )
      this.db.exec(
        "ALTER TABLE jobs ADD COLUMN operation TEXT NOT NULL DEFAULT 'send'",
      );
    // A crash after a provider send starts is ambiguous. Never silently resend it.
    this.db
      .prepare("UPDATE jobs SET state='uncertain' WHERE state='sending'")
      .run();
  }
  seal(value) {
    const iv = randomBytes(12),
      c = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([c.update(JSON.stringify(value)), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), data]).toString("base64");
  }
  open(value) {
    const b = Buffer.from(value, "base64"),
      d = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([d.update(b.subarray(28)), d.final()]).toString(),
    );
  }
  limit(key, maximum, window) {
    const row = this.db.prepare("SELECT * FROM limits WHERE key=?").get(key),
      now = this.now();
    if (row && row.expires > now && row.count >= maximum)
      throw new Failure(429, "Too many attempts. Please try again later.");
    this.db
      .prepare(
        "INSERT INTO limits VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count,expires=excluded.expires",
      )
      .run(
        key,
        row && row.expires > now ? row.count + 1 : 1,
        row && row.expires > now ? row.expires : now + window,
      );
  }
  bootstrap(purpose = "connect") {
    if (!["connect", "disconnect"].includes(purpose))
      throw new Failure(400, "Purpose must be connect or disconnect.");
    const secret = token(),
      expires = this.now() + 15 * 60e3;
    this.db
      .prepare("INSERT INTO setups(token_hash,expires,purpose) VALUES(?,?,?)")
      .run(hash(secret), expires, purpose);
    return { setupToken: secret, expiresAt: expires, purpose };
  }
  setup(value, verified = false) {
    const s = this.db
      .prepare(
        `SELECT s.*,a.phone,a.assigned FROM setups s
      LEFT JOIN accounts a ON a.id=s.account_id WHERE token_hash=?`,
      )
      .get(hash(value || ""));
    if (!s || s.expires <= this.now())
      throw new Failure(
        401,
        "Setup expired, cancelled, or already completed. Start again.",
      );
    if (verified && !s.verified)
      throw new Failure(
        403,
        "Send the ownership challenge from your phone first.",
      );
    return s;
  }
  setupStatus(value) {
    const s = this.setup(value);
    return {
      state: s.verified
        ? "verified"
        : s.account_id
          ? "awaiting_verification"
          : "awaiting_phone",
      purpose: s.purpose,
      expiresAt: s.expires,
      ...(s.account_id ? { assigned: s.assigned, shared: true } : {}),
      ...(s.challenge ? { challenge: this.open(s.challenge) } : {}),
      ...(s.verified
        ? {
            replacementRequired: !!this.db
              .prepare("SELECT 1 FROM agents WHERE account_id=?")
              .get(s.account_id),
          }
        : {}),
    };
  }
  begin(phone, provider, setupToken) {
    const s = this.setup(setupToken);
    if (s.account_id) {
      if (s.phone !== phone)
        throw new Failure(
          409,
          "This setup is already bound to a phone. Start again to change it.",
        );
      return this.setupStatus(setupToken);
    }
    let a = this.db.prepare("SELECT * FROM accounts WHERE phone=?").get(phone);
    if (!a) {
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO accounts(id,phone,assigned,provider_id,created) VALUES(?,?,?,?,?)",
        )
        .run(id, phone, provider.assignedPhoneNumber, provider.id, this.now());
      a = this.db.prepare("SELECT * FROM accounts WHERE id=?").get(id);
    }
    // The provider is authoritative for the current shared-line assignment.
    this.db
      .prepare("UPDATE accounts SET assigned=?,provider_id=? WHERE id=?")
      .run(provider.assignedPhoneNumber, provider.id, a.id);
    const challenge = "NUMBY " + randomBytes(12).toString("hex");
    this.db
      .prepare(
        "UPDATE setups SET account_id=?,challenge_hash=?,challenge=? WHERE token_hash=?",
      )
      .run(a.id, hash(challenge), this.seal(challenge), s.token_hash);
    return this.setupStatus(setupToken);
  }
  invalidateSetup(accountId) {
    this.db.prepare("DELETE FROM setups WHERE account_id=?").run(accountId);
  }
  revoke(accountId) {
    this.db.prepare("DELETE FROM agents WHERE account_id=?").run(accountId);
    this.invalidateSetup(accountId);
    this.db.prepare("UPDATE accounts SET verified=0 WHERE id=?").run(accountId);
    this.db
      .prepare(
        "UPDATE jobs SET state='expired',payload=NULL,reply=NULL,lease=NULL WHERE account_id=? AND state IN ('queued','leased','outbound')",
      )
      .run(accountId);
  }
  completeSetup(value, action, replace = false) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const s = this.setup(value, true);
      if (s.purpose !== action)
        throw new Failure(409, "This setup has a different purpose.");
      const paired = !!this.db
        .prepare("SELECT 1 FROM agents WHERE account_id=?")
        .get(s.account_id);
      if (action === "connect" && paired && replace !== true)
        throw new Failure(
          409,
          "An agent is already paired. Ask the owner before replacing it, then use replace: true.",
        );
      this.revoke(s.account_id);
      const secret = action === "connect" ? token() : null;
      if (secret) {
        this.db
          .prepare("INSERT INTO agents VALUES(?,?,?)")
          .run(hash(secret), s.account_id, this.now());
        this.db
          .prepare("UPDATE accounts SET verified=1 WHERE id=?")
          .run(s.account_id);
      }
      this.db.exec("COMMIT");
      return {
        ...(secret ? { token: secret } : { disconnected: true }),
        accountId: s.account_id,
        assigned: s.assigned,
        shared: true,
      };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  agent(value) {
    const a = this.db
      .prepare("SELECT * FROM agents WHERE token_hash=?")
      .get(hash(value || ""));
    if (!a) throw new Failure(401, "Invalid agent credential.");
    return a.account_id;
  }
  ingest(space, message) {
    if (
      !["imessage", "iMessage"].includes(space?.platform) ||
      space.type !== "dm" ||
      message.direction !== "inbound" ||
      !["text", "reply", "reaction", "attachment", "voice"].includes(message.content?.type) ||
      !phoneOK(message.sender?.id) ||
      typeof message.id !== "string" ||
      message.id.length > 256 ||
      (message.content.type === "reaction"
        ? typeof message.content.emoji !== "string" ||
          message.content.emoji.length > 32 ||
          typeof message.content.targetId !== "string"
        : ["attachment", "voice"].includes(message.content.type)
          ? typeof message.content.id !== "string" || message.content.id.length > 256 ||
            typeof message.content.name !== "string" || message.content.name.length > 500 ||
            typeof message.content.mimeType !== "string" || message.content.mimeType.length > 150
          : typeof message.content.text !== "string" ||
          message.content.text.length > 16000)
    )
      return null;
    const a = this.db
      .prepare("SELECT * FROM accounts WHERE phone=?")
      .get(message.sender.id);
    if (!a) return null;
    if (space.phone !== "shared" && space.phone !== a.assigned) return null;
    const text = (message.content.text || "").trim();
    if (text.startsWith("NUMBY ")) {
      this.db
        .prepare(
          `UPDATE setups SET verified=1,challenge_hash=NULL,challenge=NULL
        WHERE account_id=? AND challenge_hash=? AND expires>? AND verified=0`,
        )
        .run(a.id, hash(text), this.now());
      return null;
    }
    if (!a.verified) return null;
    const inserted = this.db
      .prepare(
        "INSERT OR IGNORE INTO jobs(id,account_id,payload,created,updated) VALUES(?,?,?,?,?)",
      )
      .run(
        message.id,
        a.id,
        this.seal({ space, message }),
        this.now(),
        this.now(),
      );
    return inserted.changes ? a.id : null;
  }
  lease(accountId) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const busy = this.db
        .prepare(
          "SELECT 1 FROM jobs WHERE account_id=? AND ((state='leased' AND lease_until>=?) OR state IN ('outbound','sending'))",
        )
        .get(accountId, this.now());
      if (busy) {
        this.db.exec("COMMIT");
        return null;
      }
      const j = this.db
        .prepare(
          "SELECT * FROM jobs WHERE account_id=? AND (state='queued' OR (state='leased' AND lease_until<?)) ORDER BY created LIMIT 1",
        )
        .get(accountId, this.now());
      if (!j) {
        this.db.exec("COMMIT");
        return null;
      }
      if (j.attempts >= 10) {
        this.db.prepare("UPDATE jobs SET state='failed' WHERE id=?").run(j.id);
        this.db.exec("COMMIT");
        return null;
      }
      const lease = token();
      this.db
        .prepare(
          "UPDATE jobs SET state='leased',lease=?,lease_until=?,attempts=attempts+1,updated=? WHERE id=?",
        )
        .run(hash(lease), this.now() + 10 * 60e3, this.now(), j.id);
      this.db.exec("COMMIT");
      const p = this.open(j.payload);
      return {
        id: j.id,
        lease,
        kind: p.message.content.type,
        ...(["attachment", "voice"].includes(p.message.content.type)
          ? {attachment: p.message.content}
          : p.message.content.type === "reaction"
          ? {
              emoji: p.message.content.emoji,
              targetId: p.message.content.targetId,
            }
          : {
              text: p.message.content.text,
              ...(p.message.content.targetId
                ? { replyTo: p.message.content.targetId }
                : {}),
            }),
        conversation: p.space.id,
      };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  leasedPayload(accountId, id, lease) {
    const j = this.db.prepare("SELECT * FROM jobs WHERE id=? AND account_id=?").get(id, accountId);
    if (!j) throw new Failure(404, "Message not found.");
    if (j.state !== "leased" || j.lease !== hash(lease || "") || j.lease_until < this.now()) throw new Failure(409, "Message lease expired.");
    return this.open(j.payload);
  }
  reply(accountId, id, lease, text, operation = "send") {
    if (!["send", "reply", "react", "ack", "send-content", "reply-content"].includes(operation))
      throw new Failure(400, "Unsupported message operation.");
    if (
      operation === "react" &&
      (typeof text !== "string" ||
        text.length > 32 ||
        !/\p{Extended_Pictographic}/u.test(text) ||
        [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text)]
          .length !== 1)
    )
      throw new Failure(400, "Reaction must be one emoji.");
    if (["send-content", "reply-content"].includes(operation)) validateParts(text);
    if (
      !["ack", "send-content", "reply-content"].includes(operation) &&
      (typeof text !== "string" || !text.trim() || text.length > 4000)
    )
      throw new Failure(400, "Reply must contain 1–4000 characters.");
    const j = this.db
      .prepare("SELECT * FROM jobs WHERE id=? AND account_id=?")
      .get(id, accountId);
    if (!j) throw new Failure(404, "Message not found.");
    const responseHash = hash(
      JSON.stringify({ operation, value: operation === "ack" ? null : text }),
    );
    if (j.reply_hash) {
      if (j.reply_hash === responseHash) return j.state;
      throw new Failure(409, "A different reply already exists.");
    }
    if (
      j.state !== "leased" ||
      j.lease !== hash(lease || "") ||
      j.lease_until < this.now()
    )
      throw new Failure(409, "Message lease expired.");
    const payload = this.open(j.payload);
    if (
      ["reply", "reply-content", "react"].includes(operation) &&
      payload.message.content.type === "reaction"
    )
      throw new Failure(
        422,
        "Reaction events cannot be threaded or reacted to. Send a text or acknowledge instead.",
      );
    if (operation === "ack") {
      this.db
        .prepare(
          "UPDATE jobs SET reply_hash=?,operation='ack',state='sent',payload=NULL,updated=? WHERE id=?",
        )
        .run(responseHash, this.now(), id);
      return "sent";
    }
    this.db
      .prepare(
        "UPDATE jobs SET reply=?,reply_hash=?,operation=?,state='outbound',updated=? WHERE id=?",
      )
      .run(this.seal(text), responseHash, operation, this.now(), id);
    return "outbound";
  }
  cleanup() {
    this.db.prepare("DELETE FROM setups WHERE expires<=?").run(this.now());
    this.db.prepare("DELETE FROM limits WHERE expires<?").run(this.now());
    // Keep IDs for 30-day dedupe; message bodies retained at most 24 hours.
    this.db
      .prepare(
        "UPDATE jobs SET payload=NULL,reply=NULL,state=CASE WHEN state='sent' THEN 'sent' ELSE 'expired' END WHERE created<? AND payload IS NOT NULL",
      )
      .run(this.now() - 86400e3);
    this.db
      .prepare("DELETE FROM jobs WHERE created<?")
      .run(this.now() - 30 * 86400e3);
  }
}
