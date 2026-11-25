// Screenshots for the feedback form: shrunk in the page before they are sent, so a report stays small (the server takes
// at most about 600 KB per image) and a full-resolution screen never leaves the computer.
import type { FeedbackAttachment } from "./types";

export const MAX_SCREENSHOTS = 3;
/** Longest side after shrinking. */
export const MAX_SIDE = 1600;
/** Target size of the encoded image in bytes (the server limit is about 600 KB; this leaves room). */
export const TARGET_BYTES = 450_000;
const QUALITIES = [0.85, 0.75, 0.65, 0.55, 0.45];

/** The scale that brings the longest side down to `maxSide`, never above 1. */
export function fitScale(width: number, height: number, maxSide = MAX_SIDE): number {
  const longest = Math.max(width, height);
  return longest <= maxSide ? 1 : maxSide / longest;
}

/** Bytes of a base64 string. */
export function base64Bytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

export function isImageFile(file: File): boolean {
  return /^image\/(png|jpe?g|webp|gif|bmp)$/i.test(file.type);
}

async function decode(
  file: File,
): Promise<{ draw(ctx: CanvasRenderingContext2D, w: number, h: number): void; width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  return { width: bitmap.width, height: bitmap.height, draw: (ctx, w, h) => ctx.drawImage(bitmap, 0, 0, w, h) };
}

/** Reads, shrinks and encodes an image as JPEG, lowering the quality and then the size until it fits. */
export async function shrinkImage(file: File): Promise<FeedbackAttachment> {
  const source = await decode(file);
  let scale = fitScale(source.width, source.height);
  for (let round = 0; round < 4; round += 1) {
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This screenshot could not be read.");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    source.draw(ctx, width, height);
    for (const quality of QUALITIES) {
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      if (base64Bytes(base64) <= TARGET_BYTES) {
        const name = `${file.name.replace(/\.[^.]+$/, "") || "screenshot"}.jpg`;
        return { name, mime: "image/jpeg", data_base64: base64 };
      }
    }
    scale *= 0.75;
  }
  throw new Error("This screenshot is too large to send even after shrinking it.");
}
