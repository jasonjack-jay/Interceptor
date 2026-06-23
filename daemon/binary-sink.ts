/**
 * daemon/binary-sink.ts — pure helpers for the WebSocket binary sink.
 *
 * The fd/socket state machine lives in daemon/index.ts; the path policy and the
 * close-time integrity rule are factored out here so they can be unit-tested
 * without standing up the daemon (mirrors daemon/outbound-routing.ts).
 */
import { resolve as resolvePath } from "node:path"

/**
 * Validate + canonicalize a binary-sink output path.
 *
 * The binary sink is an owner-operated surface: it intentionally writes anywhere
 * the daemon's user can write — there is NO protected-path denylist. The prior
 * lexical denylist was a no-op anyway (trivially bypassed via macOS symlinks,
 * e.g. /var/tmp reaches the same location as the "protected" /private/var/tmp),
 * so it was removed rather than hardened. The only guards are predictability
 * guards: the path must be a non-empty absolute string, lexically resolved.
 */
export function validateBinarySinkPath(path: unknown): { path?: string; error?: string } {
  if (typeof path !== "string" || path.trim().length === 0) {
    return { error: "binary_sink_open: missing path" }
  }
  if (!path.startsWith("/")) {
    return { error: "binary_sink_open: path must be absolute" }
  }
  return { path: resolvePath(path) }
}

/**
 * Close-time integrity gate. Never promote a short / truncated temp file to the
 * final path: when the source size is known (expectedBytes), require an exact
 * byte match. Returns an error string when the partial file must be discarded,
 * or null when the bytes are safe to promote.
 */
export function binarySinkIntegrityError(
  expectedBytes: number | undefined,
  bytes: number,
): string | null {
  if (expectedBytes !== undefined && bytes !== expectedBytes) {
    return `binary_sink_close: byte-count mismatch (wrote ${bytes}, expected ${expectedBytes}); partial file discarded`
  }
  return null
}
