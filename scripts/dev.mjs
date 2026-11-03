// Runs the API (:4000) and the Vite dev server (:5173) together.
// Ctrl+C stops both.
import { spawn } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const apps = [
  { name: "server", color: "\x1b[36m" },
  { name: "client", color: "\x1b[35m" },
];

const children = apps.map(({ name, color }) => {
  const child = spawn(npm, ["run", "dev", "--prefix", name], { stdio: ["inherit", "pipe", "pipe"] });
  const prefix = `${color}[${name}]\x1b[0m `;
  const pipe = (stream, out) =>
    stream.on("data", (chunk) =>
      out.write(chunk.toString().replace(/^(?=.)/gm, prefix))
    );
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on("exit", (code) => {
    console.log(`${prefix}exited with code ${code}`);
    shutdown(code ?? 0);
  });
  return child;
});

let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
