import { createRequire, isBuiltin } from "node:module";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(
  new URL("../package.json", import.meta.url),
);
const { build } = require("esbuild");
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--out-dir"))
  throw new Error("Usage: node scripts/build-mcp.mjs [--out-dir directory]");
const directory = args.length
  ? resolve(args[1])
  : join(root, "dist");

/*
 * Two bundles, both with every dependency inlined (only Node built-ins stay external):
 *  - hoot-lens-mcp.mjs: the single-file download served from the website (stdio server only), node 22.16.
 *  - cli.mjs: the entry of the npm package @hootlens/mcp (serve, login, logout, whoami), readable (not minified), node 20,
 *    with a shebang. Its third-party notices are the first comment of the file, so the package needs no other license file.
 */
const targets = [
  {
    entry: "src/stdio.ts",
    filename: "hoot-lens-mcp.mjs",
    target: "node22.16",
    label: "download",
    notices: "hoot-lens-mcp.LICENSES.txt",
    meta: "hoot-lens-mcp.meta.json",
  },
  {
    entry: "src/cli.ts",
    filename: "cli.mjs",
    target: "node20",
    label: "package",
    shebang: "#!/usr/bin/env node\n",
    executable: true,
    meta: "cli.meta.json",
  },
];

async function buildTarget(options) {
  const bundle = await build({
    absWorkingDir: root,
    entryPoints: [options.entry],
    outfile: join(directory, options.filename),
    bundle: true,
    platform: "node",
    format: "esm",
    target: options.target,
    write: false,
    metafile: true,
    legalComments: "inline",
    sourcemap: false,
    minify: false,
    banner: {
      js: 'import { createRequire as createNodeRequire } from "node:module"; const require = createNodeRequire(import.meta.url);',
    },
  });
  for (const output of Object.values(bundle.metafile.outputs)) {
    for (const dependency of output.imports) {
      if (dependency.external && !isBuiltin(dependency.path))
        throw new Error(
          `MCP ${options.label} has an unbundled dependency: ${dependency.path}`,
        );
    }
  }

  const packages = new Map();
  for (const input of Object.keys(bundle.metafile.inputs)) {
    if (!input.includes("node_modules/")) continue;
    let candidate = dirname(resolve(root, input));
    while (candidate !== root && dirname(candidate) !== candidate) {
      const manifest = await readFile(join(candidate, "package.json"), "utf8")
        .then(JSON.parse)
        .catch(() => null);
      if (manifest?.name && manifest.version) {
        packages.set(`${manifest.name}@${manifest.version}`, candidate);
        break;
      }
      candidate = dirname(candidate);
    }
  }
  const notices = [];
  for (const [name, packageDirectory] of [...packages].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const files = (await readdir(packageDirectory))
      .filter((file) => /^(licen[cs]e|notice)(\.|$)/i.test(file))
      .sort();
    if (!files.some((file) => /^licen[cs]e(\.|$)/i.test(file)))
      throw new Error(`No bundled license text found for ${name}`);
    const texts = await Promise.all(
      files.map(
        async (file) =>
          `${file}\n${await readFile(join(packageDirectory, file), "utf8")}`,
      ),
    );
    notices.push(`${name}\n${texts.join("\n\n")}`);
  }
  const notice = `Hoot Lens MCP bundled dependency notices\n\n${notices.join("\n\n----------------------------------------\n\n")}\n`;
  const code = bundle.outputFiles.find((file) =>
    file.path.endsWith(options.filename),
  );
  if (!code) throw new Error(`MCP ${options.label} bundle was not produced`);
  await mkdir(directory, { recursive: true });
  const target = join(directory, options.filename);
  await writeFile(
    target,
    `${options.shebang ?? ""}/*!\n${notice.replaceAll("*/", "* /")}*/\n${code.text}`,
  );
  if (options.executable) await chmod(target, 0o755);
  if (options.notices) await writeFile(join(directory, options.notices), notice);
  await writeFile(
    join(directory, options.meta),
    JSON.stringify(bundle.metafile, null, 2),
  );
  console.log(
    `Built MCP ${options.label} at ${relative(root, target)}`,
  );
}

for (const options of targets) await buildTarget(options);
