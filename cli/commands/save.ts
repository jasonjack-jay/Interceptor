/**
 * cli/commands/save.ts — page byte sink
 */

type Action = { type: string; [key: string]: unknown }

function flagVal(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

// Flags that take a value (flag + the token after it are both consumed).
const VALUE_FLAGS = new Set(["--out", "--chunk-size"])
// Boolean flags that may survive global filtering and must never be folded into
// the evaluated expression. (e.g. `save --out f "new Blob([])" --json` used to
// concatenate `--json` into the code and fail with a postfix-operator error.)
const BOOL_FLAGS = new Set(["--main", "--isolated", "--json", "--ws", "--no-ws", "--any-tab"])

export function parseSaveCommand(filtered: string[]): Action {
  const out = flagVal(filtered, "--out")
  if (!out || out.startsWith("--")) {
    console.error("error: interceptor save requires --out <path>")
    process.exit(1)
  }

  const chunkSizeRaw = flagVal(filtered, "--chunk-size")
  const chunkSize = chunkSizeRaw ? parseInt(chunkSizeRaw, 10) : undefined
  const world = filtered.includes("--isolated") ? "ISOLATED" : "MAIN"

  // Build the JS expression from everything that is NOT: index 0 (the `save`
  // verb), a value-flag or its value, or a boolean flag. This keeps trailing
  // flags out of the evaluated code regardless of their position.
  const skip = new Set<number>([0])
  filtered.forEach((arg, i) => {
    if (VALUE_FLAGS.has(arg)) {
      skip.add(i)
      skip.add(i + 1)
    }
  })

  const code = filtered
    .filter((arg, index) => !skip.has(index) && !BOOL_FLAGS.has(arg) && !VALUE_FLAGS.has(arg))
    .join(" ")

  if (!code.trim()) {
    console.error("error: interceptor save requires a JavaScript expression")
    process.exit(1)
  }

  return {
    type: "binary_sink_save",
    out,
    code,
    world,
    ...(chunkSize && chunkSize > 0 ? { chunkSize } : {})
  }
}
