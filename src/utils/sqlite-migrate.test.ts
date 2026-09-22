import { describe, it, expect, vi } from "vitest";
import { addColumnIfMissing } from "./sqlite-migrate.js";

function dupError(): Error {
  const err = new Error("duplicate column name: foo");
  err.name = "SqliteError";
  return err;
}

function realError(): Error {
  return new Error("database disk image is malformed");
}

function makeDb(): { exec: import("vitest").Mock<(sql: string) => unknown> } {
  return { exec: vi.fn((_sql: string): unknown => undefined) };
}

describe("addColumnIfMissing — migration narrowing", () => {
  it("runs the ALTER and does not swallow a duplicate-column failure on re-run", () => {
    const db = makeDb();
    db.exec.mockImplementation(() => { throw dupError(); });
    expect(() => addColumnIfMissing(db, "t", "foo TEXT")).not.toThrow();
    expect(db.exec).toHaveBeenCalledWith("ALTER TABLE t ADD COLUMN foo TEXT");
  });

  it("rethrows any non-duplicate SQLite failure instead of swallowing it", () => {
    const db = makeDb();
    db.exec.mockImplementation(() => { throw realError(); });
    expect(() => addColumnIfMissing(db, "t", "foo TEXT")).toThrow("database disk image is malformed");
  });

  it("passes the migration through when the column does not exist", () => {
    const db = makeDb();
    db.exec.mockReturnValue(undefined);
    expect(() => addColumnIfMissing(db, "t", "foo TEXT")).not.toThrow();
    expect(db.exec).toHaveBeenCalledTimes(1);
  });
});