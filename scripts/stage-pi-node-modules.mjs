import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");
const outputRoot = path.join(projectRoot, "src-tauri", "pi-node_modules");

const ROOT_PACKAGES = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "@earendil-works/pi-ai",
  "pi-cursor-sdk",
  "@cursor/sdk",
];

function findInNodeModules(name, startDir) {
  let dir = startDir;
  const segments = name.startsWith("@") ? name.split("/") : [name];
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", ...segments);
    const manifest = path.join(candidate, "package.json");
    if (fs.existsSync(manifest)) {
      const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
      if (pkg.name === name) {
        return candidate;
      }
    }
    dir = path.dirname(dir);
  }
  return null;
}

function resolvePackageRoot(name, fromDir) {
  const resolver = createRequire(path.join(fromDir, "package.json"));
  try {
    return path.dirname(resolver.resolve(`${name}/package.json`));
  } catch {
    try {
      const entry = resolver.resolve(name);
      let dir = path.dirname(entry);
      while (dir !== path.dirname(dir)) {
        const manifest = path.join(dir, "package.json");
        if (fs.existsSync(manifest)) {
          const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
          if (pkg.name === name) {
            return dir;
          }
        }
        dir = path.dirname(dir);
      }
    } catch {
      // Fall through to node_modules walk.
    }
  }

  const found = findInNodeModules(name, fromDir) ?? findInNodeModules(name, projectRoot);
  if (found) {
    return found;
  }

  throw new Error(`Could not resolve package root for ${name} from ${fromDir}`);
}

function destinationForPackage(name) {
  if (name.startsWith("@")) {
    const slash = name.indexOf("/");
    return path.join(outputRoot, name.slice(0, slash), name.slice(slash + 1));
  }
  return path.join(outputRoot, name);
}

function collectDependencies(name, fromDir, seen = new Map()) {
  if (seen.has(name)) {
    return seen;
  }
  const packageRoot = resolvePackageRoot(name, fromDir);
  seen.set(name, packageRoot);
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    collectDependencies(dependency, packageRoot, seen);
  }
  return seen;
}

function copyPackage(name, packageRoot) {
  const destination = destinationForPackage(name);
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(packageRoot, destination, { recursive: true, dereference: true });
}

fs.rmSync(outputRoot, { recursive: true, force: true });
fs.mkdirSync(outputRoot, { recursive: true });

const packages = new Map();
for (const rootPackage of ROOT_PACKAGES) {
  collectDependencies(rootPackage, projectRoot, packages);
}

for (const [name, packageRoot] of [...packages.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  copyPackage(name, packageRoot);
}

// Sanity check: pi-tui must resolve its runtime deps from the staged tree.
const stagedRequire = createRequire(path.join(outputRoot, "package.json"));
stagedRequire.resolve("get-east-asian-width");
stagedRequire.resolve("marked");

console.log(`Staged ${packages.size} Pi packages into ${outputRoot}`);
