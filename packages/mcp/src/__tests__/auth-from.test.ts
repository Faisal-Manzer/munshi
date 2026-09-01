import { describe, expect, it } from "vitest";
import { authFrom } from "../tools";

/**
 * The SDK moved `authInfo` from the handler's `extra` to `extra.http`. Nothing
 * failed loudly when it did: the token still verified, the request was still
 * accepted, and only the tool saw nothing — which reaches a user as "the server
 * has no key for this session" and sends them back through OAuth forever.
 * These pin both shapes so the next bump is a red test, not a silent outage.
 */
describe("authFrom", () => {
  const auth = { extra: { userId: "u1", ledgerId: "l1", sealedKey: "s" } };

  it("reads the current shape, where auth is nested under http", () => {
    expect(authFrom({ http: { authInfo: auth } })).toBe(auth);
  });

  it("still reads the older top-level shape", () => {
    expect(authFrom({ authInfo: auth })).toBe(auth);
  });

  it("prefers the top-level one when somehow both are present", () => {
    const other = { extra: { userId: "u2" } };
    expect(authFrom({ authInfo: auth, http: { authInfo: other } })).toBe(auth);
  });

  it("returns undefined when there is genuinely no auth, rather than throwing", () => {
    expect(authFrom(undefined)).toBeUndefined();
    expect(authFrom({})).toBeUndefined();
    expect(authFrom({ http: {} })).toBeUndefined();
  });
});
