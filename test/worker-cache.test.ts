import { describe, expect, it } from "vitest";
import { isWorkerCacheEligible, workerCacheKey } from "../src/storage/worker-cache";

describe("Worker Cache API helpers", () => {
  it("uses a credential-free pathname key without a cache generation", () => {
    const request = new Request("https://cache.test/nar/example.nar?download=1", {
      headers: { Authorization: "Bearer should-not-be-in-key" },
    });
    const key = new URL(workerCacheKey(request).url);
    expect(key.pathname).toBe("/nar/example.nar");
    expect(key.search).toBe("");
    expect(key.username).toBe("");
    expect(key.password).toBe("");
  });

  it("changes the cache key when the generated cache-info configuration changes", () => {
    const request = new Request("https://cache.test/nix-cache-info");
    const first = new URL(workerCacheKey(request, "/nix/store\u000040\u00001").url);
    const second = new URL(workerCacheKey(request, "/gnu/store\u000040\u00001").url);
    expect(first.search).not.toBe(second.search);
    expect(first.pathname).toBe(second.pathname);
  });

  it("bypasses the Worker cache for range and conditional requests", () => {
    expect(isWorkerCacheEligible(new Request("https://cache.test/a.nar"))).toBe(true);
    expect(isWorkerCacheEligible(new Request("https://cache.test/a.nar", { method: "HEAD" }))).toBe(true);
    expect(isWorkerCacheEligible(new Request("https://cache.test/a.nar", { headers: { Range: "bytes=0-1" } }))).toBe(false);
    expect(isWorkerCacheEligible(new Request("https://cache.test/a.nar", { headers: { "If-None-Match": "etag" } }))).toBe(false);
  });
});
