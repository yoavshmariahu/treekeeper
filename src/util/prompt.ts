import { createInterface } from "node:readline/promises";

/** Ask a yes/no question. Returns `fallback` when stdin is not a TTY. */
export async function confirm(question: string, fallback = false): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return fallback;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}
