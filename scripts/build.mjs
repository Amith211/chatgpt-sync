import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..");
const targets = ["chromium", "firefox"];
const sourceFiles = ["content.js", "interceptor.js"];
const iconSourceDir = resolve(root, "assets", "icons");

const iconFiles = [
  "icon-16.png",
  "icon-32.png",
  "icon-48.png",
  "icon-96.png",
  "icon-128.png"
];

const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const version = packageJson.version;

for (const target of targets) {
  const manifestPath = resolve(root, "platforms", target, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

  if (manifest.version !== version) {
    throw new Error(`${target} manifest version ${manifest.version} does not match package version ${version}.`);
  }

  const outputDir = resolve(root, "dist", target);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await cp(manifestPath, resolve(outputDir, "manifest.json"));

  for (const file of sourceFiles) {
    await cp(resolve(root, "src", file), resolve(outputDir, file));
  }

  const iconOutputDir = resolve(outputDir, "icons");
  await mkdir(iconOutputDir, { recursive: true });

  for (const iconFile of iconFiles) {
    await cp(
      resolve(iconSourceDir, iconFile),
      resolve(iconOutputDir, iconFile)
    );
  }
}

await writeFile(resolve(root, "dist", ".version"), `${version}\n`, "utf8");
console.log(`Built ChatGPT Sync ${version} for ${targets.join(" and ")}.`);