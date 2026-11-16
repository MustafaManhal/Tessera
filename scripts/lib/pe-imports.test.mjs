import { describe, expect, it } from "vitest";
import { dllImports, REDISTRIBUTABLE_DLL } from "./pe-imports.mjs";

/** A minimal 64-bit PE image with one section holding an import table for `dlls`. */
function fakeProgram(dlls) {
  const buffer = Buffer.alloc(0x400);
  buffer.writeUInt16LE(0x5a4d, 0); // MZ
  buffer.writeUInt32LE(0x40, 0x3c); // e_lfanew
  buffer.writeUInt32LE(0x0000_4550, 0x40); // PE\0\0
  buffer.writeUInt16LE(0x8664, 0x44); // x64
  buffer.writeUInt16LE(1, 0x46); // one section
  buffer.writeUInt16LE(0xf0, 0x54); // size of the optional header
  const optional = 0x58;
  buffer.writeUInt16LE(0x20b, optional); // PE32+
  buffer.writeUInt32LE(16, optional + 108); // data directories
  buffer.writeUInt32LE(0x1000, optional + 112 + 8); // import directory address
  buffer.writeUInt32LE(20 * (dlls.length + 1), optional + 112 + 12);
  const section = optional + 0xf0;
  buffer.writeUInt32LE(0x200, section + 8); // virtual size
  buffer.writeUInt32LE(0x1000, section + 12); // virtual address
  buffer.writeUInt32LE(0x200, section + 16); // raw size
  buffer.writeUInt32LE(0x200, section + 20); // raw offset
  dlls.forEach((dll, i) => {
    const descriptor = 0x200 + i * 20;
    buffer.writeUInt32LE(0x1100 + i * 0x20, descriptor + 12); // name
    buffer.writeUInt32LE(0x1180, descriptor + 16); // first thunk
    buffer.write(`${dll}\0`, 0x300 + i * 0x20, "latin1");
  });
  return buffer;
}

describe("dllImports", () => {
  it("lists the DLLs in the import table", () => {
    expect(dllImports(fakeProgram(["KERNEL32.dll", "VCRUNTIME140.dll"]))).toEqual(["KERNEL32.dll", "VCRUNTIME140.dll"]);
    expect(dllImports(fakeProgram([]))).toEqual([]);
  });

  it("refuses files that are not Windows programs", () => {
    expect(() => dllImports(Buffer.from("#!/bin/sh\n".padEnd(0x80)))).toThrow(/MZ/);
  });

  it("flags the Visual C++ runtime but not Windows' own C runtime", () => {
    for (const dll of ["VCRUNTIME140.dll", "vcruntime140_1.dll", "MSVCP140.dll"])
      expect(REDISTRIBUTABLE_DLL.test(dll)).toBe(true);
    for (const dll of ["api-ms-win-crt-heap-l1-1-0.dll", "ucrtbase.dll", "KERNEL32.dll", "msvcrt.dll"])
      expect(REDISTRIBUTABLE_DLL.test(dll)).toBe(false);
  });
});
