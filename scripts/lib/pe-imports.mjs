// The DLLs a Windows program loads at start (its PE import table, plus delay-loaded DLLs). `pnpm package` uses it
// to refuse a helper or app that needs the Visual C++ runtime (VCRUNTIME140.dll): that DLL is not part of Windows,
// so on a PC without the Visual C++ Redistributable the program does not start at all (STATUS_DLL_NOT_FOUND).
import { readFileSync } from "node:fs";

/** DLL names a program needs that are not part of Windows: the Visual C++ runtime and the C++ standard library. */
export const REDISTRIBUTABLE_DLL = /^(vcruntime|msvcp|concrt|vccorlib)\d+(_\d+)?\.dll$/i;

/** The DLL names imported by the PE image in `buffer`, in file order. */
export function dllImports(buffer) {
  const u16 = (at) => buffer.readUInt16LE(at);
  const u32 = (at) => buffer.readUInt32LE(at);
  if (buffer.length < 0x40 || u16(0) !== 0x5a4d) throw new Error("not a Windows program (no MZ header)");
  const pe = u32(0x3c);
  if (u32(pe) !== 0x0000_4550) throw new Error("not a Windows program (no PE header)");
  const sections = u16(pe + 6);
  const optional = pe + 24;
  const optionalSize = u16(pe + 20);
  const magic = u16(optional);
  if (magic !== 0x10b && magic !== 0x20b) throw new Error(`unknown PE optional header 0x${magic.toString(16)}`);
  const plus = magic === 0x20b;
  const directoryCount = u32(optional + (plus ? 108 : 92));
  const directories = optional + (plus ? 112 : 96);
  const table = optional + optionalSize;

  const offsetOf = (rva) => {
    for (let i = 0; i < sections; i++) {
      const section = table + i * 40;
      const start = u32(section + 12);
      const size = Math.max(u32(section + 8), u32(section + 16));
      if (rva >= start && rva < start + size) return u32(section + 20) + (rva - start);
    }
    throw new Error(`address 0x${rva.toString(16)} is in no section`);
  };
  const name = (rva) => {
    const start = offsetOf(rva);
    const end = buffer.indexOf(0, start);
    return buffer.toString("latin1", start, end === -1 ? buffer.length : end);
  };

  const names = [];
  // Import directory (index 1): 20-byte descriptors, the DLL name's address at +12, ended by an all-zero entry.
  if (directoryCount > 1 && u32(directories + 8) !== 0) {
    for (let at = offsetOf(u32(directories + 8)); u32(at + 12) !== 0 || u32(at + 16) !== 0; at += 20) {
      names.push(name(u32(at + 12)));
    }
  }
  // Delay-load directory (index 13): 32-byte descriptors, the DLL name's address at +4.
  if (directoryCount > 13 && u32(directories + 13 * 8) !== 0) {
    for (let at = offsetOf(u32(directories + 13 * 8)); u32(at + 4) !== 0; at += 32) names.push(name(u32(at + 4)));
  }
  return names;
}

/** The redistributable DLLs the program at `path` needs (empty when it runs on a bare Windows install). */
export function redistributableImports(path) {
  return dllImports(readFileSync(path)).filter((dll) => REDISTRIBUTABLE_DLL.test(dll));
}
