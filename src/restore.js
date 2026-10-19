import { readFileSync, existsSync } from "node:fs";
import { createDecipheriv } from "node:crypto";
import { Store } from "./core.js";
const [file, target] = process.argv.slice(2);
if (!file || !target || existsSync(target))
  throw new Error(
    "Usage: DATA_KEY=... node src/restore.js BACKUP NEW_DATABASE (target must not exist)",
  );
const key = process.env.DATA_KEY,
  b = readFileSync(file),
  d = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(key || "", "hex"),
    b.subarray(0, 12),
  );
d.setAAD(Buffer.from("numby-backup-v1"));
d.setAuthTag(b.subarray(12, 28));
const data = JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]));
if (data.version !== 1) throw new Error("Unsupported backup version");
const s = new Store(target, key);
s.db.exec("BEGIN IMMEDIATE");
try {
  for (const a of data.accounts)
    s.db
      .prepare("INSERT INTO accounts VALUES(?,?,?,?,?,?)")
      .run(a.id, a.phone, a.assigned, a.provider_id, a.verified, a.created);
  for (const a of data.agents)
    s.db
      .prepare("INSERT INTO agents VALUES(?,?,?)")
      .run(a.token_hash, a.account_id, a.created);
  for (const j of data.jobs)
    s.db
      .prepare(
        "INSERT INTO jobs(id,account_id,state,created,updated) VALUES(?,?,'expired',?,?)",
      )
      .run(j.id, j.account_id, j.created, j.updated);
  s.db.exec("COMMIT");
  console.log(
    "Routing restored. Owners must sign in again. Message bodies are not in this backup.",
  );
} catch (e) {
  s.db.exec("ROLLBACK");
  throw e;
} finally {
  s.db.close();
}
