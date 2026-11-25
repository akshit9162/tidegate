#!/usr/bin/env node
// git push to deploy: `git remote add tidegate tidegate::<project>` and then `git push tidegate main`.
// Git runs this helper for tidegate:: remotes (it must be on PATH as git-remote-tidegate). It speaks git's
// remote-helper protocol on stdin/stdout: on a push it exports the pushed commit with `git archive`
// (committed files only, honouring export-ignore) and deploys that folder like `tidegate deploy`.
// Progress goes to stderr, which git shows; stdout carries only the protocol.
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { deploy } from "./tidegate.mjs";

const run = promisify(execFile);
const project = (process.argv[3] ?? "").replace(/^tidegate::/, "");
const say = (s) => process.stderr.write(`${s}\n`);
const out = (s) => process.stdout.write(s);

async function deployCommit(src) {
  const { stdout: sha } = await run("git", ["rev-parse", "--verify", `${src}^{commit}`]);
  const dir = await mkdtemp(path.join(tmpdir(), "tidegate-push-"));
  try {
    await run("sh", ["-c", `git archive --format=tar "$1" | tar -x -C "$2"`, "sh", sha.trim(), dir]);
    say(`tidegate: deploying ${sha.trim().slice(0, 12)} to ${project}`);
    return await deploy(dir, { name: project, log: (l) => say(`tidegate: ${l.replace(/\n/g, "\ntidegate: ")}`) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(project)) {
  say(`tidegate: "${project}" is not a project name; use tidegate::<project>`);
  process.exit(1);
}

let pushes = [];
for await (const line of createInterface({ input: process.stdin })) {
  if (line === "capabilities") out("push\n\n");
  else if (line.startsWith("list")) out("\n");
  else if (line.startsWith("push ")) pushes.push(line.slice(5));
  else if (line === "") {
    if (!pushes.length) break;
    for (const spec of pushes) {
      const [src, dst] = spec.replace(/^\+/, "").split(":");
      if (!src) {
        out(`error ${dst} deleting a branch does not undeploy; use tidegate rollback\n`);
        continue;
      }
      try {
        const r = await deployCommit(src);
        out(["ready", "gating"].includes(r.status) ? `ok ${dst}\n` : `error ${dst} ${r.status === "blocked" ? "blocked by the gate" : "not published"}\n`);
      } catch (e) {
        say(`tidegate: ${e.message}`);
        out(`error ${dst} ${e.message.split("\n")[0]}\n`);
      }
    }
    out("\n");
    pushes = [];
  }
}
