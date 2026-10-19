import { DatabaseSync } from "node:sqlite";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.DATA_DIR || "/var/lib/numby",
  key = Buffer.from(process.env.DATA_KEY || "", "hex");
if (key.length !== 32) throw new Error("Invalid backup key");
const db = new DatabaseSync(join(dir, "numby.sqlite"), { readOnly: true });
db.exec("BEGIN");
const data = {
  version: 1,
  created: new Date().toISOString(),
  accounts: db.prepare("SELECT * FROM accounts").all(),
  agents: db.prepare("SELECT * FROM agents").all(),
  jobs: db.prepare("SELECT id,account_id,created,updated FROM jobs").all(),
};
db.exec("COMMIT");
db.close();
// Deliberately exclude sessions, pairing codes, pending messages, and reply bodies.
const iv = randomBytes(12),
  cipher = createCipheriv("aes-256-gcm", key, iv);
cipher.setAAD(Buffer.from("numby-backup-v1"));
const encrypted = Buffer.concat([
  cipher.update(JSON.stringify(data)),
  cipher.final(),
]);
const out = join(dir, "backups");
mkdirSync(out, { recursive: true, mode: 0o700 });
writeFileSync(
  join(out, Date.now() + ".enc"),
  Buffer.concat([iv, cipher.getAuthTag(), encrypted]),
  { mode: 0o600 },
);
const files = readdirSync(out)
  .filter((x) => /^\d+\.enc$/.test(x))
  .sort();
for (const f of files.slice(0, -7)) unlinkSync(join(out, f));
console.log(
  JSON.stringify({
    event: "routing_backup_complete",
    accounts: data.accounts.length,
  }),
);
