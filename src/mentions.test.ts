import { describe, it, expect } from "bun:test";
import { checkMention } from "./mentions.js";
import vectors from "../test-fixtures/mention-vectors.json";

describe("mention detection (shared vectors)", () => {
  for (const v of vectors.vectors) {
    it(v.name, () => {
      const result = checkMention({
        tags: v.tags as string[][],
        text: v.text,
        botPubkey: vectors.botPubkey,
        botName: vectors.botName,
      });

      expect(result.mentioned).toBe(v.expect.mentioned);
      if (v.expect.pTag !== undefined) expect(result.pTag).toBe(v.expect.pTag);
      if (v.expect.textBech32 !== undefined) expect(result.textBech32).toBe(v.expect.textBech32);
      if (v.expect.textHex !== undefined) expect(result.textHex).toBe(v.expect.textHex);
      if (v.expect.name !== undefined) expect(result.name).toBe(v.expect.name);
      if (v.expect.broadcast !== undefined) expect(result.broadcast).toBe(v.expect.broadcast);
    });
  }
});
