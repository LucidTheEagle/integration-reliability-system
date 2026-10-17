import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POOL_SETTINGS, createDatabase } from "@irs/db";

// VPF-1(e): @irs/db loads across packages under Node ESM.
describe("@irs/db cross-package import", () => {
  it("loads the built package and constructs a database without I/O", async () => {
    assert.equal(DEFAULT_POOL_SETTINGS.maxConnections, 10);
    const db = createDatabase({
      connectionString: "postgresql://irs_no_io@127.0.0.1:1/irs_no_io_test",
    });
    assert.equal(typeof db.ping, "function");
    await db.prisma.$disconnect();
  });
});
