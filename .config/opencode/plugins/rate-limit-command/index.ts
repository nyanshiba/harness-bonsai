import { Plugin } from "@opencode/plugin";

const EVENT_TYPE = "session.execution.failed";
const MARKER = "Rate limit exceeded";

export interface FixedCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRateLimitEvent(event: unknown): boolean {
  if (!isRecord(event)) return false;
  if (event["type"] !== EVENT_TYPE) return false;
  const data = event["data"];
  if (!isRecord(data)) return false;
  const sessionID = data["sessionID"];
  if (typeof sessionID !== "string" || sessionID.length === 0) return false;
  const error = data["error"];
  if (!isRecord(error)) return false;
  const message = error["message"];
  if (typeof message !== "string" || message.length === 0) return false;
  return message.includes(MARKER);
}

export function parseOptions(options: unknown): FixedCommand | null {
  if (!isRecord(options)) return null;
  const commandValue = options["command"];
  if (!isRecord(commandValue)) return null;
  const executable = commandValue["executable"];
  if (typeof executable !== "string" || executable.trim().length === 0) return null;
  const rawArgs = commandValue["args"];
  if (rawArgs === undefined) return { executable, args: [] };
  if (Array.isArray(rawArgs) && rawArgs.every((item) => typeof item === "string")) return { executable, args: [...rawArgs] };
  return null;
}

export default Plugin.define({
  id: "rate-limit-command",
  setup(ctx) {
    let command: FixedCommand | null = null;
    try {
      command = parseOptions(ctx.options);
    } catch {
      command = null;
    }
    if (!command) {
      console.warn("rate-limit-command: invalid configuration");
      let cleaned = false;
      return () => {
        cleaned = true;
      };
    }
    const active = command;
    const controller = new AbortController();
    let stopped = false;
    const consumer = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (stopped) break;
          try {
            if (!isRateLimitEvent(event)) continue;
            console.warn("rate-limit-command: triggered");
            Bun.spawnSync([active.executable, ...active.args], { stdout: "ignore", stderr: "ignore" });
          } catch {
            continue;
          }
        }
      } catch {
        if (!stopped) console.warn("rate-limit-command: event stream ended");
      }
    })();
    void consumer.catch(() => undefined);
    let cleaned = false;
    return async () => {
      if (cleaned) return;
      cleaned = true;
      stopped = true;
      controller.abort();
      await Promise.race([consumer, Promise.resolve()]);
    };
  },
});
