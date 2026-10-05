// Assembles everything the installer ships into ../build/app. Keeps all output on this drive.
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const app = path.join(root, "build", "app");
const run = (cmd, cwd, env = {}) => execSync(cmd, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
const step = (m) => console.log(`\n=== ${m}`);

// Overwrites in place and never deletes: a stale file from an earlier stage is harmless, and a recursive
// delete of a multi-GB tree is a decision for the person running this, not the script.
mkdirSync(app, { recursive: true });

step("compile backend");
run("npx tsc -p .", path.join(root, "backend"));

step("build frontend (same-origin API, so no port is baked in)");
run("npx vite build", path.join(root, "frontend"), { VITE_API_URL: "" });
cpSync(path.join(root, "frontend", "dist"), path.join(app, "frontend"), { recursive: true });

step("backend runtime (production dependencies only)");
const be = path.join(app, "backend");
mkdirSync(be, { recursive: true });
cpSync(path.join(root, "backend", "dist"), path.join(be, "dist"), { recursive: true });
cpSync(path.join(root, "backend", "prisma"), path.join(be, "prisma"), { recursive: true });
for (const f of ["package.json", "package-lock.json"]) cpSync(path.join(root, "backend", f), path.join(be, f));
run("npm ci --omit=dev --ignore-scripts", be);
run("npx prisma generate", path.join(root, "backend"));
cpSync(path.join(root, "backend", "node_modules", ".prisma"), path.join(be, "node_modules", ".prisma"), { recursive: true });
cpSync(path.join(root, "backend", "node_modules", "@prisma", "client"), path.join(be, "node_modules", "@prisma", "client"), { recursive: true });

step("seed database (schema applied, no data)");
const seed = path.join(app, "seed");
mkdirSync(seed, { recursive: true });
// schema.prisma hardcodes the dev database path, so migrate against a copy that points at the seed
// file instead. This leaves the development setup untouched.
const seedSchema = path.join(root, "build", "seed-schema.prisma");
writeFileSync(seedSchema, readFileSync(path.join(root, "backend", "prisma", "schema.prisma"), "utf8")
  .replace(/url\s*=\s*"file:[^"]*"/, `url = "file:${path.join(seed, "app.db").replaceAll("\\", "/")}"`));
cpSync(path.join(root, "backend", "prisma", "migrations"), path.join(root, "build", "migrations"), { recursive: true });
run(`npx prisma migrate deploy --schema "${seedSchema}"`, path.join(root, "backend"));

step("engine");
const engine = path.join(be, "engine");  // backend/src/engine.ts resolves <dist>/../engine
const frozen = path.join(root, "build", process.env.ENGINE_BUILD ?? "engine3", "pramaan-engine");
if (!existsSync(frozen)) throw new Error(`frozen engine missing at ${frozen} — run the PyInstaller build first`);
cpSync(frozen, engine, { recursive: true });
cpSync(path.join(root, "backend", "engine", "ffmpeg.exe"), path.join(engine, "ffmpeg.exe"));
for (const extra of ["models", "upscayl-cli"]) {
  const from = path.join(root, "backend", "engine", extra);
  if (existsSync(from)) cpSync(from, path.join(engine, extra), { recursive: true });
  else console.log(`  (${extra} absent — the module that needs it will report it)`);
}

// Packages PyInstaller cannot bundle correctly ship as plain files in _internal, copied from the venv that
// is known to work: chardet is mypyc-compiled with helper modules nothing imports by name, and setuptools /
// pkg_resources vendor jaraco and backports through a path hack. paddle and paddlex import all of them.
const site = path.join(root, "backend", "engine", ".venv", "Lib", "site-packages");
for (const pkg of ["chardet", "setuptools", "pkg_resources", "_distutils_hack"]) {
  const from = path.join(site, pkg);
  if (!existsSync(from)) { console.log(`  (${pkg} not in the venv)`); continue; }
  cpSync(from, path.join(engine, "_internal", pkg), { recursive: true, filter: (src) => !src.endsWith("__pycache__") });
}

// paddlex decides whether OCR dependencies are installed by reading package metadata (.dist-info). PyInstaller
// only keeps it for the packages it was told about, so ship all of it: ~12 MB.
for (const entry of readdirSync(site, { withFileTypes: true })) {
  if (entry.isDirectory() && entry.name.endsWith(".dist-info"))
    cpSync(path.join(site, entry.name), path.join(engine, "_internal", entry.name), { recursive: true, force: false, errorOnExist: false });
}

// Visual C++ runtime. A clean Windows machine may not have the redistributable (torch_cpu.dll needs
// vcruntime140_threads.dll, which only recent redistributables carry), so ship the set with the app, beside
// the engine and beside torch's own DLLs where the loader looks first. Microsoft permits app-local deployment.
const sys32 = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
const vcRuntime = ["vcruntime140.dll", "vcruntime140_1.dll", "vcruntime140_threads.dll", "msvcp140.dll", "msvcp140_1.dll",
  "msvcp140_2.dll", "msvcp140_atomic_wait.dll", "msvcp140_codecvt_ids.dll", "concrt140.dll", "vcomp140.dll"];
for (const dir of [path.join(engine, "_internal"), path.join(engine, "_internal", "torch", "lib")]) {
  if (!existsSync(dir)) continue;
  for (const dll of vcRuntime) if (existsSync(path.join(sys32, dll))) cpSync(path.join(sys32, dll), path.join(dir, dll));
}

// Object-detection weights live in the user's profile on a dev machine; ship a copy inside the app.
const weights = path.join(process.env.USERPROFILE ?? "", ".roboflow", "models", "rf-detr-base.pth");
if (existsSync(weights)) {
  mkdirSync(path.join(engine, "models", "rfdetr"), { recursive: true });
  cpSync(weights, path.join(engine, "models", "rfdetr", "rf-detr-base.pth"));
} else console.log("  (rf-detr-base.pth not found — object detection will need its weights downloaded)");

const mb = (p) => {
  let total = 0;
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else total += statSync(f).size; } };
  walk(p); return (total / 1024 ** 2).toFixed(0);
};
step("staged");
for (const part of ["backend", "frontend", "seed"]) console.log(`  ${part.padEnd(10)} ${mb(path.join(app, part))} MB`);
