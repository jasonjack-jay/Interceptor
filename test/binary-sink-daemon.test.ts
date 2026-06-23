import { describe, expect, test } from "bun:test"

import { validateBinarySinkPath, binarySinkIntegrityError } from "../daemon/binary-sink"

describe("validateBinarySinkPath", () => {
  test("accepts an absolute path and returns it resolved", () => {
    expect(validateBinarySinkPath("/tmp/out.bin")).toEqual({ path: "/tmp/out.bin" })
  })

  test("normalizes . and .. segments lexically", () => {
    expect(validateBinarySinkPath("/tmp/a/../out.bin")).toEqual({ path: "/tmp/out.bin" })
  })

  test("write-anywhere: formerly-denied prefixes are now allowed (denylist removed)", () => {
    // The old lexical denylist was a symlink-bypassable no-op; the sink is an
    // owner-operated, write-anywhere surface now. Paths are not rewritten.
    expect(validateBinarySinkPath("/var/tmp/x").path).toBe("/var/tmp/x")
    expect(validateBinarySinkPath("/etc/x").path).toBe("/etc/x")
    expect(validateBinarySinkPath("/private/var/tmp/x").path).toBe("/private/var/tmp/x")
    expect(validateBinarySinkPath("/usr/local/share/x").path).toBe("/usr/local/share/x")
  })

  test("rejects a relative path", () => {
    expect(validateBinarySinkPath("relative/x").error).toMatch(/absolute/)
    expect(validateBinarySinkPath("relative/x").path).toBeUndefined()
  })

  test("rejects empty / blank / non-string paths", () => {
    expect(validateBinarySinkPath("").error).toMatch(/missing path/)
    expect(validateBinarySinkPath("   ").error).toMatch(/missing path/)
    expect(validateBinarySinkPath(undefined).error).toMatch(/missing path/)
    expect(validateBinarySinkPath(123).error).toMatch(/missing path/)
  })
})

describe("binarySinkIntegrityError", () => {
  test("passes (null) when bytes match expectedBytes", () => {
    expect(binarySinkIntegrityError(1024, 1024)).toBeNull()
  })

  test("passes when expectedBytes is unknown (e.g. blob-url streamed source)", () => {
    expect(binarySinkIntegrityError(undefined, 999)).toBeNull()
  })

  test("fails (discard) on a short / truncated write", () => {
    const err = binarySinkIntegrityError(1024, 512)
    expect(err).toMatch(/byte-count mismatch/)
    expect(err).toMatch(/wrote 512/)
    expect(err).toMatch(/expected 1024/)
  })

  test("fails on an over-long write", () => {
    expect(binarySinkIntegrityError(1024, 2048)).toMatch(/byte-count mismatch/)
  })
})
