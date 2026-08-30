import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const trackedFiles = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);

const forbiddenPaths = trackedFiles.filter(
  (file) =>
    file === ".env" ||
    (file.startsWith(".env.") && file !== ".env.example") ||
    file.startsWith(".data/") ||
    file.startsWith("artifacts/"),
);

const patterns = [
  { label: "OpenAI-style API key", expression: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/u },
  { label: "GitHub token", expression: /\bgh[oprsu]_[A-Za-z0-9]{20,}\b/u },
  {
    label: "populated credential assignment",
    expression:
      /(?:OPENAI_API_KEY|BRIGHT_DATA_API_KEY|DAYTONA_API_KEY|TRUEFORGE_TOKEN)[ \t]*=(?!=)[ \t]*[^\s#][^\r\n]*/u,
  },
];

const findings = [];

for (const file of trackedFiles) {
  if (file === "package-lock.json" || file === "scripts/check-secrets.mjs") continue;

  let contents;
  try {
    contents = readFileSync(file, "utf8");
  } catch {
    continue;
  }

  for (const pattern of patterns) {
    if (pattern.expression.test(contents)) findings.push(`${file}: ${pattern.label}`);
  }
}

if (forbiddenPaths.length > 0 || findings.length > 0) {
  for (const path of forbiddenPaths) console.error(`${path}: forbidden tracked path`);
  for (const finding of findings) console.error(finding);
  process.exitCode = 1;
} else {
  console.log(`Secret scan passed for ${trackedFiles.length} tracked files.`);
}
