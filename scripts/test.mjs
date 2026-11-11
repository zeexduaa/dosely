// Runs the compiled tests. Node 20's test runner doesn't expand glob patterns, so list the files here.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const dir = join("dist", "test");
const files = readdirSync(dir).filter((f) => f.endsWith(".test.js")).sort().map((f) => join(dir, f));
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
