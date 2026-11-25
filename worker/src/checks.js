// The checks every version passes before it can go live. These run in the Worker; tidegate.json
// "checks" (tests and the like) run on the runner as a "check" run.

const SECRETS = [
  ["an Anthropic API key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["an OpenAI API key", /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ["a GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36}\b/],
  ["an AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["a Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ["a Stripe live key", /\bsk_live_[A-Za-z0-9]{24,}/],
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];
const TEXT = /\.(py|js|mjs|cjs|ts|json|txt|md|ya?ml|toml|cfg|ini|env|sh|html?)$/i;
const MAX_SCAN = 2_000_000;
// The file an agent's command starts, when the command names one: "python agent.py", "node src/index.js".
const ENTRY = /^(?:python3?|node|bun|deno run|uv run|sh|bash)\s+(?:-[\w-]+\s+)*([\w./-]+\.(?:py|js|mjs|cjs|ts|sh))\b/;

export function findSecrets(path, text) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    for (const [what, rx] of SECRETS) if (rx.test(line)) out.push(`${path}:${i + 1}: looks like ${what}; remove it and use "tidegate secret set"`);
  });
  return out;
}

/** files: Map of every uploaded path to its sha. read(path) returns the file's text. */
export async function checkVersion(files, config, read) {
  const problems = [];
  for (const a of config.agents) {
    const entry = ENTRY.exec(a.run.trim())?.[1]?.replace(/^\.\//, "");
    if (entry && !files.has(entry)) problems.push(`tidegate.json: agent "${a.name}" runs ${entry}, which is not in the upload`);
  }
  for (const path of files.keys()) {
    if (!TEXT.test(path)) continue;
    const text = await read(path);
    if (text.length <= MAX_SCAN) problems.push(...findSecrets(path, text));
  }
  return problems;
}
