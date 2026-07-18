import { describe, expect, it } from "vitest";
import {
  decodeCanonicalBase64,
  parseStrictJson,
} from "../../../src/system/domain/strict-json";

describe("strict JSON", () => {
  it.each([
    ["top-level duplicate", '{"value":1,"value":2}'],
    ["nested duplicate", '{"nested":{"value":1,"value":2}}'],
    ["escaped duplicate", '{"value":1,"\\u0076alue":2}'],
  ])("rejects %s object keys", (_name, source) => {
    expect(() => parseStrictJson(source)).toThrow(/duplicate/i);
  });

  it.each([
    ["unsafe positive integer", "9007199254740992"],
    ["unsafe negative integer", "-9007199254740992"],
    ["overflowing number", "1e400"],
    ["leading-zero integer", "01"],
    ["trailing content", "{} true"],
    ["unterminated object", '{"value":1'],
    ["unescaped control", '"line\nfeed"'],
  ])("rejects %s", (_name, source) => {
    expect(() => parseStrictJson(source)).toThrow();
  });

  it("rejects a UTF-8 BOM", () => {
    expect(() =>
      parseStrictJson(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d])),
    ).toThrow(/BOM/i);
  });

  it("rejects malformed UTF-8 with fatal decoding", () => {
    expect(() =>
      parseStrictJson(
        Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xc3, 0x28, 0x7d]),
      ),
    ).toThrow();
  });

  it("parses nested JSON without changing string escapes", () => {
    expect(
      parseStrictJson('{"text":"\\u20ac","values":[true,null,-1.5e2]}'),
    ).toEqual({
      text: "€",
      values: [true, null, -150],
    });
  });
});

describe("canonical Base64", () => {
  it.each(["e30", "e30===", "e3-_=", "e3 0=", "A===", "===="])(
    "rejects non-canonical form %s",
    (encoded) => {
      expect(() => decodeCanonicalBase64(encoded, "value")).toThrow(/Base64/i);
    },
  );

  it("accepts canonical padded RFC 4648 Base64", () => {
    expect(decodeCanonicalBase64("e30=", "value")).toEqual(Buffer.from("{}"));
  });

  it("rejects a form that Node's permissive decoder accepts", () => {
    expect(Buffer.from("e30", "base64")).toEqual(Buffer.from("{}"));
    expect(() => decodeCanonicalBase64("e30", "value")).toThrow();
  });
});
