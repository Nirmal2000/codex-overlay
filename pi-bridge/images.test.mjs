import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { imageFromPath, imagesFromPaths, mediaTypeForPath } from "./images.mjs";

test("maps screenshot extensions to MIME types", () => {
  assert.equal(mediaTypeForPath("/tmp/a.png"), "image/png");
  assert.equal(mediaTypeForPath("/tmp/a.JPG"), "image/jpeg");
  assert.equal(mediaTypeForPath("/tmp/a.jpeg"), "image/jpeg");
  assert.equal(mediaTypeForPath("/tmp/a.webp"), "image/webp");
});

test("encodes multiple image paths as separate prompt attachments", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bridge-images-"));
  const first = join(dir, "alpha.png");
  const second = join(dir, "beta.jpg");
  await writeFile(first, Buffer.from("alpha-bytes"));
  await writeFile(second, Buffer.from("beta-bytes"));
  const images = await imagesFromPaths([first, second, ""]);
  assert.equal(images.length, 2);
  assert.deepEqual(images[0], {
    type: "image",
    mimeType: "image/png",
    data: Buffer.from("alpha-bytes").toString("base64"),
  });
  assert.deepEqual(images[1], {
    type: "image",
    mimeType: "image/jpeg",
    data: Buffer.from("beta-bytes").toString("base64"),
  });
  const single = await imageFromPath(first);
  assert.equal(single.mimeType, "image/png");
});
