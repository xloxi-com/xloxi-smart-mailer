import { describe, expect, it } from "vitest";
import { sanitizeHttpUrl } from "./safe-url.server";

describe("sanitizeHttpUrl", () => {
  it("allows http and https URLs", () => {
    expect(sanitizeHttpUrl("https://seductiv.net/logo.png")).toContain(
      "https://seductiv.net/logo.png",
    );
    expect(sanitizeHttpUrl("http://example.com/a")).toContain("http://example.com/a");
  });

  it("rejects javascript and data schemes", () => {
    expect(sanitizeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizeHttpUrl("data:text/html,hi")).toBeNull();
    expect(sanitizeHttpUrl("vbscript:msgbox(1)")).toBeNull();
  });

  it("rejects malformed values", () => {
    expect(sanitizeHttpUrl("not a url")).toBeNull();
    expect(sanitizeHttpUrl("")).toBeNull();
    expect(sanitizeHttpUrl(null)).toBeNull();
  });
});
