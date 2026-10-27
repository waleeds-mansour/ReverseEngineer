// The seeded test server (seeded.ts) is only ever a test server: without development login, on the
// live cluster or on the live server's port, it refuses before it touches any database.
import { describe, expect, it } from "vitest";
import { seedGate, startSeeded } from "./seeded.ts";

const TEST = "postgres://hearth@localhost:5499/postgres";

describe("seedGate", () => {
  it("allows a server with development login on the test cluster", () => {
    expect(seedGate({ HEARTH_DEV_AUTH: "1", HEARTH_TEST_DATABASE_URL: TEST }, 4486)).toEqual([]);
  });

  it("refuses without development login, which the live install never has", () => {
    for (const HEARTH_DEV_AUTH of [undefined, "", "0", "true"])
      expect(seedGate({ HEARTH_DEV_AUTH, HEARTH_TEST_DATABASE_URL: TEST }, 4486)).toEqual([
        expect.stringContaining("HEARTH_DEV_AUTH=1"),
      ]);
  });

  it("refuses the live cluster, the live server's ports, and no test cluster at all", () => {
    const dev = { HEARTH_DEV_AUTH: "1" };
    for (const url of ["postgres://hearth@localhost:5432/postgres", "postgres://localhost/hearth"])
      expect(seedGate({ ...dev, HEARTH_TEST_DATABASE_URL: url }, 4486)).toEqual([
        expect.stringContaining("5432"),
      ]);
    for (const port of [4400, 4443])
      expect(seedGate({ ...dev, HEARTH_TEST_DATABASE_URL: TEST }, port)).toEqual([
        `Port ${port} is the live server's.`,
      ]);
    expect(seedGate(dev, 4486)).toEqual([expect.stringContaining("HEARTH_TEST_DATABASE_URL")]);
  });
});

describe("startSeeded", () => {
  it("refuses before reaching any database", async () => {
    // Nothing listens on port 1: a server that tried to connect would fail another way.
    const env = { HEARTH_TEST_DATABASE_URL: "postgres://hearth@127.0.0.1:1/postgres" };
    await expect(startSeeded({ port: 4486, webDist: "", env })).rejects.toThrow(
      /^Not seeding a server: .*HEARTH_DEV_AUTH=1/,
    );
  });
});
