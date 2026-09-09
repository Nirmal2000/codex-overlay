import { readFile } from "node:fs/promises";
import { extname } from "node:path";

export function mediaTypeForPath(path) {
  const extension = extname(path).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  return "image/png";
}

export async function imageFromPath(path) {
  const data = await readFile(path);
  return { type: "image", data: data.toString("base64"), mimeType: mediaTypeForPath(path) };
}

export async function imagesFromPaths(paths = []) {
  return Promise.all(paths.filter(Boolean).map(imageFromPath));
}
