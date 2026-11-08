import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ChatOutcome, listModels, type ProviderAccess, streamChat } from "./client";
import type { ProviderError } from "./providerError";
import type { Provider } from "./providers";
import { createTlsFixture, type KeyPair, type TlsFixture } from "./tlsFixture";

let fixture: TlsFixture;
const servers: ReturnType<typeof Bun.serve>[] = [];

/** HTTPS server presenting `pair`, answering a model list and a one-word streamed reply. */
function serve(pair: KeyPair): string {
  const server = Bun.serve({
    port: 0,
    tls: { cert: pair.cert, key: pair.key },
    fetch(request) {
      if (new URL(request.url).pathname.endsWith("/models")) return Response.json({ data: [{ id: "m" }] });
      const chunk = { choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: "stop" }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  servers.push(server);
  return `https://localhost:${server.port}/v1`;
}

let selfSignedUrl: string;
let expiredUrl: string;
let mismatchUrl: string;
let validUrl: string;
/** PEM bundle: an unrelated certificate, then the test CA, with the comment lines real bundles carry. */
let bundlePath: string;

beforeAll(() => {
  fixture = createTlsFixture();
  selfSignedUrl = serve(fixture.selfSigned);
  expiredUrl = serve(fixture.expired);
  mismatchUrl = serve(fixture.mismatch);
  validUrl = serve(fixture.valid);
  bundlePath = join(fixture.dir, "bundle.pem");
  writeFileSync(bundlePath, `# Unrelated\n${fixture.selfSigned.cert}\n# broke-code test CA\n${fixture.ca.cert}`);
});

afterAll(() => {
  for (const server of servers) server.stop(true);
});

function access(name: string, baseUrl: string, caFile?: string): ProviderAccess {
  const provider: Provider = caFile === undefined ? { name, baseUrl } : { name, baseUrl, caFile };
  return { provider, apiKey: undefined };
}

async function chat(target: ProviderAccess): Promise<{ outcome: ChatOutcome; text: string }> {
  let text = "";
  const outcome = await streamChat(target, {
    model: "m",
    messages: [{ role: "user", content: "Hi" }],
    signal: new AbortController().signal,
    onContent: (piece) => (text += piece),
    onReasoning: () => {},
  });
  return { outcome, text };
}

describe("provider certificates", () => {
  test("reports a self-signed certificate as a certificate error naming the provider, for listing and chat", async () => {
    const target = access("Corp", selfSignedUrl);
    const expected: ProviderError = {
      kind: "certificate",
      provider: "Corp",
      baseUrl: selfSignedUrl,
      code: "DEPTH_ZERO_SELF_SIGNED_CERT",
    };
    expect(await listModels(target)).toEqual({ ok: false, error: expected });
    expect((await chat(target)).outcome).toEqual({ status: "failed", error: expected });
  });

  test("trusts the provider's CA file, for listing and chat", async () => {
    const target = access("Corp", selfSignedUrl, fixture.selfSigned.certPath);
    expect(await listModels(target)).toEqual({ ok: true, models: ["m"] });
    expect(await chat(target)).toEqual({ outcome: { status: "done" }, text: "Hi" });
  });

  test("reads every certificate of a CA file bundle", async () => {
    expect(await listModels(access("Corp", validUrl, bundlePath))).toEqual({ ok: true, models: ["m"] });
    expect(await listModels(access("Self", selfSignedUrl, bundlePath))).toEqual({ ok: true, models: ["m"] });
  });

  test("keeps the CA file to its own provider: a second provider without one still fails on the same server", async () => {
    // [!]: Trusted request first, so a pooled connection or a shared agent would let the second one through.
    expect(await listModels(access("Trusting", selfSignedUrl, fixture.selfSigned.certPath))).toMatchObject({
      ok: true,
    });
    expect(await listModels(access("Plain", selfSignedUrl))).toMatchObject({
      ok: false,
      error: { kind: "certificate", provider: "Plain" },
    });
    expect((await chat(access("Plain", selfSignedUrl))).outcome).toMatchObject({
      status: "failed",
      error: { kind: "certificate" },
    });
  });

  test("reports an expired certificate as a certificate error, even with its CA trusted", async () => {
    expect(await listModels(access("Old", expiredUrl, bundlePath))).toEqual({
      ok: false,
      error: { kind: "certificate", provider: "Old", baseUrl: expiredUrl, code: "CERT_HAS_EXPIRED" },
    });
  });

  test("reports a hostname mismatch as a certificate error, even with its CA trusted", async () => {
    const result = await listModels(access("Elsewhere", mismatchUrl, bundlePath));
    if (result.ok || result.error.kind !== "certificate")
      throw new Error(`expected certificate, got ${JSON.stringify(result)}`);
    expect(result.error.provider).toBe("Elsewhere");
    expect(["ERR_TLS_CERT_ALTNAME_INVALID", "HOSTNAME_MISMATCH"]).toContain(result.error.code);
  });

  test("reports a CA file that does not exist, naming the path, for listing and chat", async () => {
    const path = join(fixture.dir, "missing.pem");
    const listing = await listModels(access("Corp", selfSignedUrl, path));
    if (listing.ok || listing.error.kind !== "caFileInvalid")
      throw new Error(`expected caFileInvalid, got ${JSON.stringify(listing)}`);
    expect(listing.error).toMatchObject({ provider: "Corp", path, reason: "unreadable" });
    expect(listing.error.cause).toContain("ENOENT");
    expect((await chat(access("Corp", selfSignedUrl, path))).outcome).toMatchObject({
      status: "failed",
      error: { kind: "caFileInvalid", provider: "Corp", path, reason: "unreadable" },
    });
  });

  test("reports a CA file without a PEM certificate, or with a broken one, naming the path", async () => {
    const notPem = join(fixture.dir, "not.pem");
    writeFileSync(notPem, "just some text\n");
    const keyOnly = fixture.selfSigned.certPath.replace(/\.pem$/, ".key");
    const broken = join(fixture.dir, "broken.pem");
    writeFileSync(broken, `${fixture.ca.cert}-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n`);
    for (const path of [notPem, keyOnly, broken]) {
      expect(await listModels(access("Corp", selfSignedUrl, path))).toMatchObject({
        ok: false,
        error: { kind: "caFileInvalid", provider: "Corp", path, reason: "notPem" },
      });
    }
  });

  test("reports a relative CA file path as invalid when the provider is used", async () => {
    expect(await listModels(access("Corp", selfSignedUrl, "certs/corp.pem"))).toEqual({
      ok: false,
      error: { kind: "caFileInvalid", provider: "Corp", path: "certs/corp.pem", reason: "relative" },
    });
  });

  test("still reports connection refused as unreachable, with or without a CA file", async () => {
    for (const caFile of [undefined, fixture.selfSigned.certPath]) {
      expect(await listModels(access("Down", "https://127.0.0.1:1/v1", caFile))).toMatchObject({
        ok: false,
        error: { kind: "unreachable", provider: "Down", baseUrl: "https://127.0.0.1:1/v1" },
      });
    }
  });
});
