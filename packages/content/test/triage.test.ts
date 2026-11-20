import { describe, expect, it } from "vitest";
import topicsBundle from "../generated/topics.json";
import { runLocalTriage, findTopic, type TopicsBundle } from "../src";

const topics = topicsBundle as unknown as TopicsBundle;
const rules = topics.triage;

describe("runLocalTriage (L0)", () => {
  it("pauses on immediate-harm wording, including traditional characters and spacing tricks", () => {
    expect(runLocalTriage("我真的不想活了", rules).crisis).toBe(true);
    expect(runLocalTriage("最近一直想 自 殺", rules).crisis).toBe(true);
    const r = runLocalTriage("他家暴我，我该离开吗？", rules);
    expect(r.crisis).toBe(true);
    expect(r.notices.every((n) => n.action === "crisis")).toBe(true);
  });

  it("flags health, legal and investment questions as notices", () => {
    expect(runLocalTriage("我妈确诊了，手术能成功吗？", rules).notices.map((n) => n.id)).toContain("health");
    expect(runLocalTriage("这场官司能赢吗？", rules).notices.map((n) => n.id)).toContain("legal");
    expect(runLocalTriage("比特币下个月会涨吗", rules).notices.map((n) => n.id)).toContain("investment");
  });

  it("suggests a controllable rewrite for outcome questions", () => {
    const love = findTopic(topics, "love");
    const r = runLocalTriage("他会不会回来？", rules, love);
    const outcome = r.notices.find((n) => n.id === "outcome");
    expect(outcome?.suggestion?.to).toBe(love.reframeExample.to);
    expect(r.crisis).toBe(false);
  });

  it("asks to pick one question when several are asked", () => {
    expect(runLocalTriage("要不要辞职？要不要读研？", rules).notices.map((n) => n.id)).toContain("multi");
  });

  it("stays quiet for an ordinary question", () => {
    expect(runLocalTriage("有两个工作机会，我看重的是什么？", rules)).toEqual({ crisis: false, notices: [] });
  });
});
