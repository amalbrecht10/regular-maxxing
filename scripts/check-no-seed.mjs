// Fails if the local seed record ended up in dist/. Run after `npm run build`, before deploying.
// It looks for the seed's id prefixes, which every seed record carries, so the check itself
// never needs to contain a real person's name.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function listFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}

const markers = ["seed-person-", "seed-place-"];
const hits = listFiles("dist").filter((f) => {
  const text = readFileSync(f, "latin1");
  return markers.some((m) => text.includes(m));
});
if (hits.length) {
  console.error(`Seed data found in the build: ${hits.join(", ")}. Rebuild without LOCAL_SEED=1 before deploying.`);
  process.exit(1);
}
console.log(`No seed data in dist/ (${listFiles("dist").length} files checked).`);

// Second check, only on a machine that has the seed file: no tracked file may contain a seed
// person's name. This catches a real name slipping into tests, docs or scripts before a push.
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
if (existsSync("seed.local.json")) {
  const seed = JSON.parse(readFileSync("seed.local.json", "utf8"));
  const names = (seed.people ?? []).map((p) => p.name).filter((n) => typeof n === "string" && n.length >= 3);
  const tracked = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  const leaks = [];
  for (const file of tracked) {
    if (!existsSync(file) || statSync(file).isDirectory()) continue;
    const text = readFileSync(file, "latin1");
    for (const name of names) {
      if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)) leaks.push(file);
    }
  }
  if (leaks.length) {
    console.error(`A seed person's name appears in files git would commit: ${[...new Set(leaks)].join(", ")}`);
    process.exit(1);
  }
  console.log(`No seed names in ${tracked.length} committable files.`);
}
