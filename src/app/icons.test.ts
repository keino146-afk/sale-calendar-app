import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// The app icons are generated from the approved icon artwork (Phase 6P); the
// artwork itself is not part of the repository.

async function pngSize(path: string) {
  const data = await readFile(path);
  expect(data.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  expect(data.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

describe("app icons", () => {
  it.each([
    ["src/app/apple-icon.png", 180],
    ["public/icons/icon-192.png", 192],
    ["public/icons/icon-512.png", 512],
    ["public/icons/icon-maskable-512.png", 512],
  ])("%s is a square %ipx PNG", async (path, size) => {
    expect(await pngSize(path)).toEqual({ width: size, height: size });
  });

  it("replaces the create-next-app favicon with a 48px icon", async () => {
    const data = await readFile("src/app/favicon.ico");
    // ICONDIR: reserved 0, type 1 (icon), one image of 48x48.
    expect(data.readUInt16LE(0)).toBe(0);
    expect(data.readUInt16LE(2)).toBe(1);
    expect(data.readUInt16LE(4)).toBe(1);
    expect([data[6], data[7]]).toEqual([48, 48]);
    expect(data.length).not.toBe(25931);
  });

  it("keeps only the generated icons in public/ and no source artwork", async () => {
    expect((await readdir("public")).sort()).toEqual(["icons"]);
    expect((await readdir("public/icons")).sort()).toEqual(["icon-192.png", "icon-512.png", "icon-maskable-512.png"]);
    for (const dir of ["src/app", "public", "public/icons"]) {
      expect((await readdir(dir)).filter((name) => /icon-source|ChatGPT/i.test(name))).toEqual([]);
    }
  });
});
