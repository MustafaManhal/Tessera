import { describe, expect, it } from "vitest";
import { IpcError, unwrap } from "../src/unwrap";

describe("unwrap", () => {
  it("returns the data of a successful command", () => {
    expect(unwrap({ status: "ok", data: 42 })).toBe(42);
  });

  it("throws an IpcError carrying the code and message", () => {
    try {
      unwrap({ status: "error", error: { code: "store.open_failed", message: "Could not open the database." } });
      throw new Error("unwrap should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(IpcError);
      const ipc = error as IpcError;
      expect(ipc.code).toBe("store.open_failed");
      expect(ipc.message).toBe("Could not open the database.");
      expect(ipc.cause).toEqual({ code: "store.open_failed", message: "Could not open the database." });
    }
  });

  it("uses ipc.failed for an error without a code", () => {
    expect(() => unwrap({ status: "error", error: "no backend" })).toThrowError(
      expect.objectContaining({ code: "ipc.failed", message: "no backend" }),
    );
  });

  it("awaits a command result", async () => {
    await expect(unwrap(Promise.resolve({ status: "ok" as const, data: "done" }))).resolves.toBe("done");
    await expect(
      unwrap(Promise.resolve({ status: "error" as const, error: { code: "x", message: "no" } })),
    ).rejects.toMatchObject({ code: "x", message: "no" });
  });
});
