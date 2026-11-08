import { beforeAll, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import * as tls from "node:tls";
import { certificateErrorCode, providerTrust } from "./tls";
import { createTlsFixture, type TlsFixture } from "./tlsFixture";

function coded(code: string, message = "boom", cause?: unknown): Error {
  return Object.assign(new Error(message, { cause }), { code });
}

describe("certificateErrorCode", () => {
  const certificateCodes = [
    "CERT_HAS_EXPIRED",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "CERT_UNTRUSTED",
    "HOSTNAME_MISMATCH",
    "ERR_TLS_CERT_ALTNAME_INVALID",
  ];

  test.each(certificateCodes)("reads %s on the error itself (node:https, Bun)", (code) => {
    expect(certificateErrorCode(coded(code))).toBe(code);
  });

  test.each(certificateCodes)("reads %s on error.cause (Node fetch)", (code) => {
    expect(certificateErrorCode(new TypeError("fetch failed", { cause: coded(code) }))).toBe(code);
  });

  test.each(["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "UND_ERR_CONNECT_TIMEOUT"])(
    "leaves %s to the unreachable classification",
    (code) => {
      expect(certificateErrorCode(new TypeError("fetch failed", { cause: coded(code) }))).toBeUndefined();
    },
  );

  test("ignores values that are not errors, and errors without a code", () => {
    for (const value of [undefined, null, "CERT_HAS_EXPIRED", 42, new Error("plain"), { code: 7 }]) {
      expect(certificateErrorCode(value)).toBeUndefined();
    }
  });

  test("stops on a cause cycle and on a chain deeper than it follows", () => {
    const first = new Error("a");
    const second = new Error("b", { cause: first });
    (first as { cause?: unknown }).cause = second;
    expect(certificateErrorCode(first)).toBeUndefined();

    let deep: Error = coded("CERT_HAS_EXPIRED");
    for (let depth = 0; depth < 20; depth++) deep = new Error(`wrap ${depth}`, { cause: deep });
    expect(certificateErrorCode(deep)).toBeUndefined();
  });
});

describe("providerTrust", () => {
  let fixture: TlsFixture;
  beforeAll(() => {
    fixture = createTlsFixture();
  });

  test("leaves a provider without a CA file on the runtime default, so VS Code adds the OS store", async () => {
    expect(await providerTrust({ name: "P", baseUrl: "https://p/v1" })).toEqual({ ok: true, ca: undefined });
  });

  test("extends the default store and the OS store with the CA file, never replaces them", async () => {
    const trust = await providerTrust({ name: "P", baseUrl: "https://p/v1", caFile: fixture.selfSigned.certPath });
    if (!trust.ok || trust.ca === undefined) throw new Error(`expected a CA list, got ${JSON.stringify(trust)}`);
    const trusted = new Set(trust.ca.map((pem) => new X509Certificate(pem).fingerprint256));
    const expected = [...tls.getCACertificates("default"), ...tls.getCACertificates("system"), fixture.selfSigned.cert];
    expect(expected.filter((pem) => !trusted.has(new X509Certificate(pem).fingerprint256))).toEqual([]);
  });
});
