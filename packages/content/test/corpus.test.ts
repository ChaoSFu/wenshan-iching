import { describe, expect, it, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  bitsOfHexagram,
  castFromTosses,
  hexagramByTrigrams,
  tossesFromLines,
  type LineValue,
  type TrigramId,
} from "@wenshan/iching-core";
import { CONTENT_ROOT, buildBundles, loadSources, requiredEntryIds, validateSources, type ContentSources } from "../src/node";
import { TOPIC_IDS, composeFreeReading, type CorpusBundle, type TopicsBundle } from "../src";

let src: ContentSources;
let corpus: CorpusBundle;
let topics: TopicsBundle;

beforeAll(async () => {
  src = await loadSources();
  ({ corpus, topics } = buildBundles(src));
});

describe("content sources", () => {
  it("validate without errors", () => {
    const report = validateSources(src);
    expect(report.errors).toEqual([]);
    expect(report.coverage.originalsPresent).toBe(450);
  });

  it("agree with iching-core's King Wen table (independent source: Wikisource X下Y上)", () => {
    expect(src.corpus).toHaveLength(64);
    for (const h of src.corpus) {
      expect(hexagramByTrigrams(h.upper as TrigramId, h.lower as TrigramId)).toBe(h.number);
    }
  });

  it("label every line 九/六 consistently with the hexagram's yin/yang", () => {
    for (const h of src.corpus) {
      const bits = bitsOfHexagram(h.number);
      for (const e of h.entries.filter((x) => x.kind === "yao")) {
        expect(e.label!.includes("九"), `${e.id} ${e.label}`).toBe(bits[e.line! - 1] === 1);
      }
    }
  });

  it("contains the PRD §5 example passages", () => {
    expect(corpus.entries["ZY.01.L1"]?.text).toBe("潜龙勿用。");
    expect(corpus.hexagrams["44"]?.name).toBe("姤");
  });

  it("keeps 乾 as 乾 where it names the trigram", () => {
    expect(corpus.entries["ZY.10.TUAN"]?.text).toContain("应乎乾");
    expect(corpus.entries["ZY.01.G"]?.text.startsWith("元亨")).toBe(true);
  });

  it("has generated bundles that match the sources (run npm run content:build)", async () => {
    for (const [name, data] of Object.entries(buildBundles(src))) {
      const file = await readFile(path.join(CONTENT_ROOT, "generated", `${name}.json`), "utf8");
      expect(JSON.parse(file).version, `generated/${name}.json is stale`).toBe(data.version);
    }
  });

  it("lists 450 required entries", () => {
    expect(requiredEntryIds()).toHaveLength(450);
  });
});

describe("composeFreeReading", () => {
  const VALUES: LineValue[] = [6, 7, 8, 9];

  it("reproduces the PRD §5 free reading for 乾初九", () => {
    const cast = castFromTosses(tossesFromLines([9, 7, 7, 7, 7, 7]));
    const r = composeFreeReading({ cast, topicId: "career", readingId: "sample" }, corpus, topics);
    expect(r.primary.name).toBe("乾");
    expect(r.changed?.name).toBe("姤");
    expect(r.passages.map((p) => p.entryId)).toEqual(["ZY.01.G", "ZY.01.L1", "ZY.44.G"]);
    expect(r.focusAngle).toBe("prepare");
    expect(r.topicHint).toContain("已经具备什么");
    expect(r.missingEntries).toEqual([]);
  });

  it("is deterministic for the same reading id", () => {
    const cast = castFromTosses(tossesFromLines([7, 8, 9, 6, 7, 8]));
    const a = composeFreeReading({ cast, topicId: "love", readingId: "abc" }, corpus, topics);
    const b = composeFreeReading({ cast, topicId: "love", readingId: "abc" }, corpus, topics);
    expect(a).toEqual(b);
  });

  it("composes for all 4,096 casts × 5 topics without missing originals", () => {
    for (let i = 0; i < 4 ** 6; i++) {
      const lines = Array.from({ length: 6 }, (_, pos) => VALUES[Math.floor(i / 4 ** pos) % 4]!);
      const cast = castFromTosses(tossesFromLines(lines));
      for (const topicId of TOPIC_IDS) {
        const r = composeFreeReading({ cast, topicId, readingId: String(i) }, corpus, topics);
        expect(r.missingEntries).toEqual([]);
        expect(r.topicHint.length).toBeGreaterThan(0);
        expect(r.reflectionQuestion.length).toBeGreaterThan(0);
      }
    }
  });
});
