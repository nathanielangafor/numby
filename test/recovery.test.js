import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core.js";
test("restart preserves queued work and quarantines ambiguous sends", () => {
  const dir = mkdtempSync(join(tmpdir(), "numby-recovery-")),
    file = join(dir, "db"),
    key = "d".repeat(64);
  try {
    let s = new Store(file, key);
    const setupToken = s.bootstrap().setupToken;
    const p = s.begin(
        "+12405550100",
        {
          id: "p",
          assignedPhoneNumber: "+14155550100",
        },
        setupToken,
      ),
      a = s.setup(setupToken).account_id;
    s.db.prepare("UPDATE accounts SET verified=1").run();
    const space = {
        id: "dm",
        platform: "imessage",
        type: "dm",
        phone: "shared",
      },
      msg = (id) => ({
        id,
        direction: "inbound",
        sender: { id: "+12405550100" },
        content: { type: "text", text: id },
      });
    s.ingest(space, msg("queued"));
    s.ingest(space, msg("ambiguous"));
    s.db.prepare("UPDATE jobs SET state='sending' WHERE id='ambiguous'").run();
    s.db.close();
    s = new Store(file, key);
    assert.equal(s.setupStatus(setupToken).challenge, p.challenge);
    assert.equal(
      s.db.prepare("SELECT state FROM jobs WHERE id='ambiguous'").get().state,
      "uncertain",
    );
    assert.equal(s.lease(a).id, "queued");
    assert.equal(s.ingest(space, msg("queued")), null);
    s.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("additive migration preserves existing routing and agent credentials without recreating browser routes", () => {
  const dir = mkdtempSync(join(tmpdir(), "numby-migrate-")),
    file = join(dir, "db"),
    key = "e".repeat(64);
  try {
    let s = new Store(file, key);
    const setup = s.bootstrap();
    s.begin(
      "+12405550100",
      { id: "provider", assignedPhoneNumber: "+14155550100" },
      setup.setupToken,
    );
    s.db.prepare("UPDATE setups SET verified=1").run();
    const agent = s.completeSetup(setup.setupToken, "connect");
    s.db.exec(
      "DROP TABLE setups; ALTER TABLE jobs DROP COLUMN operation; PRAGMA user_version=1;",
    );
    s.db.close();
    s = new Store(file, key);
    assert.equal(s.agent(agent.token), agent.accountId);
    assert.equal(s.db.prepare("SELECT count(*) n FROM accounts").get().n, 1);
    assert.ok(
      s.db
        .prepare("PRAGMA table_info(jobs)")
        .all()
        .some((c) => c.name === "operation"),
    );
    assert.equal(
      s.db
        .prepare(
          "SELECT count(*) n FROM sqlite_master WHERE name IN ('sessions','claims')",
        )
        .get().n,
      0,
    );
    s.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
