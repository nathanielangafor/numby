import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDecipheriv } from "node:crypto";
import { Store } from "../src/core.js";
test("encrypted routing backup excludes message bodies and can be decrypted", () => {
  const dir = mkdtempSync(join(tmpdir(), "numby-backup-")),
    key = "c".repeat(64);
  try {
    const s = new Store(join(dir, "numby.sqlite"), key);
    s.begin(
      "+12405550101",
      { id: "p", assignedPhoneNumber: "+14155550100" },
      s.bootstrap().setupToken,
    );
    s.db.close();
    execFileSync(process.execPath, ["src/backup.js"], {
      env: { ...process.env, DATA_DIR: dir, DATA_KEY: key },
      stdio: "pipe",
    });
    const bytes = readFileSync(
      join(dir, "backups", readdirSync(join(dir, "backups"))[0]),
    );
    assert.ok(!bytes.includes(Buffer.from("+12405550101")));
    const d = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(key, "hex"),
      bytes.subarray(0, 12),
    );
    d.setAAD(Buffer.from("numby-backup-v1"));
    d.setAuthTag(bytes.subarray(12, 28));
    const backup = JSON.parse(
      Buffer.concat([d.update(bytes.subarray(28)), d.final()]),
    );
    assert.equal(backup.accounts.length, 1);
    assert.equal(backup.sessions, undefined);
    assert.equal(backup.setups, undefined);
    assert.deepEqual(backup.jobs, []);
    const restored = join(dir, "restored.sqlite");
    execFileSync(
      process.execPath,
      [
        "src/restore.js",
        join(dir, "backups", readdirSync(join(dir, "backups"))[0]),
        restored,
      ],
      { env: { ...process.env, DATA_KEY: key }, stdio: "pipe" },
    );
    const recovered = new Store(restored, key);
    assert.equal(
      recovered.db.prepare("SELECT COUNT(*) n FROM accounts").get().n,
      1,
    );
    recovered.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
