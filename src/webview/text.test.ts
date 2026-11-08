import { describe, expect, test } from "bun:test";
import { describeProviderError } from "./text";

describe("describeProviderError", () => {
  test("names the model list, not a reply, when the list download is cut off", () => {
    const text = describeProviderError({
      kind: "cutOff",
      provider: "Ollama",
      reason: "listDropped",
      cause: "socket closed",
    });
    expect(text).toEqual({
      message: "The model list from Ollama was cut off: the connection dropped.",
      detail: "socket closed",
    });
  });

  test("says a rejected request's body could not be read, with the cause", () => {
    const text = describeProviderError({
      kind: "rejected",
      provider: "Ollama",
      status: 500,
      detail: "",
      bodyReadError: "socket closed",
    });
    expect(text).toEqual({
      message: "Ollama rejected the request (HTTP 500).",
      detail: "The response body could not be read: socket closed",
    });
  });

  test("shows a rejected request's body detail when it was read", () => {
    const text = describeProviderError({
      kind: "rejected",
      provider: "Ollama",
      status: 404,
      detail: "model 'nope' not found",
    });
    expect(text).toEqual({ message: "Ollama rejected the request (HTTP 404).", detail: "model 'nope' not found" });
  });

  test("names the provider and the failure of an untrusted certificate, and points to the CA file setting", () => {
    const text = describeProviderError({
      kind: "certificate",
      provider: "Corp",
      baseUrl: "https://llm.corp/v1",
      code: "DEPTH_ZERO_SELF_SIGNED_CERT",
    });
    expect(text).toEqual({
      message:
        "Corp presented a certificate that is not trusted (DEPTH_ZERO_SELF_SIGNED_CERT). If it uses a corporate or self-signed certificate, set its CA file in the provider settings.",
      detail: "https://llm.corp/v1",
    });
  });

  test("names the path of an unusable CA file, with the reason in the detail", () => {
    expect(
      describeProviderError({
        kind: "caFileInvalid",
        provider: "Corp",
        path: "/x.pem",
        reason: "unreadable",
        cause: "ENOENT",
      }),
    ).toEqual({
      message: "The CA file of Corp could not be read: /x.pem",
      detail: "ENOENT",
    });
    expect(
      describeProviderError({
        kind: "caFileInvalid",
        provider: "Corp",
        path: "/x.pem",
        reason: "notPem",
        cause: "no block",
      }),
    ).toEqual({
      message: "The CA file of Corp is not a PEM certificate: /x.pem",
      detail: "no block",
    });
    expect(
      describeProviderError({ kind: "caFileInvalid", provider: "Corp", path: "x.pem", reason: "relative" }),
    ).toEqual({
      message: "The CA file of Corp must be an absolute path or start with ~/: x.pem",
    });
  });

  test("names an unsupported compression instead of a wrong base URL, in listing and chat alike", () => {
    expect(describeProviderError({ kind: "invalidResponse", provider: "Corp", detail: "", encoding: "zstd" })).toEqual({
      message: "Corp answered with a compression that broke-code cannot read (Content-Encoding: zstd).",
    });
  });
});
