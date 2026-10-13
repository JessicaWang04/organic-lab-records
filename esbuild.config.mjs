import { context, build } from "esbuild";
import { builtinModules } from "node:module";
const options = {
  entryPoints: ["src/main.ts"], bundle: true, platform: "node", format: "cjs",
  target: "es2022", external: ["obsidian", "electron", ...builtinModules],
  outfile: "main.js", sourcemap: false, logLevel: "info", loader: { ".md": "text" }
};
if (process.argv.includes("--watch")) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
