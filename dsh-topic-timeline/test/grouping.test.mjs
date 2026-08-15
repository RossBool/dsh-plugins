/**
 * Data-layer unit tests for dsh-topic-timeline.
 * The pure grouping factory is extracted from the served client bundle
 * (lib/client.js) via marker comments and executed under Node, so the tests
 * exercise the exact code the browser runs — no DOM, no copy.
 *
 *   node test/grouping.test.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const src = readFileSync(fileURLToPath(new URL("../lib/client.js", import.meta.url)), "utf8");
const start = src.indexOf("// __GROUPING_SOURCE_START__");
const end = src.indexOf("// __GROUPING_SOURCE_END__");
assert.notEqual(start, -1, "grouping source markers missing from lib/client.js");
assert.ok(end > start, "grouping source markers out of order");

const body = src.slice(start, end);
const factory = new Function("require", "var module={exports:{}}; var exports=module.exports; " + body + " return module.exports;");
const grouping = factory(() => {
  throw new Error("the data layer must not require anything");
});

/** Local-time timestamp builder (components in the machine's own zone). */
const at = (y, m, d, hh = 12, mm = 0) => new Date(y, m - 1, d, hh, mm).getTime();
const topic = (createdAt) => ({ turn: 1, key: "k", allKeys: [], title: "", steps: 1, createdAt, status: "closed" });
const ids = (list, now) => grouping.groupTopicsByDate(list, now).map((g) => g.id);

/* 2026-08-15 is a Saturday; its Monday-starting week begins 2026-08-10. */
const NOW = at(2026, 8, 15, 12, 0);

test("day buckets: today / yesterday / daysAgo 2-3", () => {
  assert.deepEqual(ids([
    topic(at(2026, 8, 15, 0, 5)),
    topic(at(2026, 8, 14, 23, 59)),
    topic(at(2026, 8, 13, 10, 0)),
    topic(at(2026, 8, 12, 10, 0))
  ], NOW), ["today", "yesterday", "daysAgo:2", "daysAgo:3"]);
});

test("future timestamps on the same day still land in today", () => {
  assert.deepEqual(ids([topic(at(2026, 8, 15, 23, 59))], NOW), ["today"]);
});

test("dayDiff 4+ skips daysAgo and falls into week buckets", () => {
  assert.deepEqual(ids([topic(at(2026, 8, 11))], NOW), ["thisWeek"]); // Tue, 4 days ago
  assert.deepEqual(ids([topic(at(2026, 8, 10, 0, 0))], NOW), ["thisWeek"]); // Monday boundary
  assert.deepEqual(ids([topic(at(2026, 8, 9))], NOW), ["lastWeek"]); // Sunday
  assert.deepEqual(ids([topic(at(2026, 8, 3, 0, 0))], NOW), ["lastWeek"]); // prev-week Monday boundary
  assert.deepEqual(ids([topic(at(2026, 8, 1))], NOW), ["thisMonth"]); // Sat of current month
});

test("month buckets: thisMonth / lastMonth / older", () => {
  assert.deepEqual(ids([topic(at(2026, 7, 31))], NOW), ["lastMonth"]);
  assert.deepEqual(ids([topic(at(2026, 7, 1))], NOW), ["lastMonth"]);
  assert.deepEqual(ids([topic(at(2026, 6, 30))], NOW), ["older"]);
});

test("cross-year boundaries (2026-01-10, Saturday)", () => {
  const now2 = at(2026, 1, 10, 12, 0);
  assert.deepEqual(ids([topic(at(2026, 1, 5, 0, 0))], now2), ["thisWeek"]);
  assert.deepEqual(ids([topic(at(2026, 1, 3))], now2), ["lastWeek"]);
  // Week buckets precede month buckets (ZCode order): Dec 31 falls inside
  // the last 7 days before Jan 5's week, so it is lastWeek, not lastMonth.
  assert.deepEqual(ids([topic(at(2025, 12, 31))], now2), ["lastWeek"]);
  assert.deepEqual(ids([topic(at(2025, 12, 20))], now2), ["lastMonth"]);
  assert.deepEqual(ids([topic(at(2025, 11, 30))], now2), ["older"]);
});

test("missing or invalid timestamps land in older", () => {
  assert.deepEqual(ids([topic(undefined), topic(null), topic(NaN), topic(0)], NOW), ["older"]);
  assert.equal(grouping.groupTopicsByDate([topic(undefined), topic(null), topic(NaN), topic(0)], NOW)[0].items.length, 4);
});

test("groups merge and keep first-seen group order + insertion order", () => {
  const a = topic(at(2026, 6, 1)); // older
  const b = topic(at(2026, 8, 15, 9, 0)); // today
  const c = topic(at(2026, 5, 1)); // older
  const groups = grouping.groupTopicsByDate([a, b, c], NOW);
  assert.deepEqual(groups.map((g) => g.id), ["older", "today"]);
  assert.equal(groups[0].items[0], a);
  assert.equal(groups[0].items[1], c);
  assert.equal(groups[1].items[0], b);
});

test("groupI18n maps bucket ids to dictionary entries", () => {
  assert.deepEqual(grouping.groupI18n("today"), { key: "group.today" });
  assert.deepEqual(grouping.groupI18n("yesterday"), { key: "group.yesterday" });
  assert.deepEqual(grouping.groupI18n("daysAgo:3"), { key: "group.daysAgo", params: { n: 3 } });
  assert.deepEqual(grouping.groupI18n("thisWeek"), { key: "group.thisWeek" });
  assert.deepEqual(grouping.groupI18n("older"), { key: "group.older" });
  assert.deepEqual(grouping.groupI18n("bogus"), { key: "group.older" });
});

test("formatTimeOfDay: zh is 24h, en is 12h, missing is empty", () => {
  const ts = at(2026, 8, 15, 14, 32);
  assert.equal(grouping.formatTimeOfDay(ts, "zh"), "14:32");
  assert.equal(grouping.formatTimeOfDay(ts, "en"), "02:32 PM");
  assert.equal(grouping.formatTimeOfDay(undefined, "zh"), "");
});

test("snippetOf: answer text first, reasoning fallback, truncated", () => {
  const mk = (blocks) => ({ data: { blocks: blocks } });
  const textNode = mk([{ kind: "tool-call", name: "bash" }, { kind: "text", text: "第一行答案。\n第二行 答案" }]);
  assert.equal(grouping.snippetOf(textNode), "第一行答案。 第二行 答案");
  const reasoningOnly = mk([{ kind: "reasoning", text: "我先想想……" }]);
  assert.equal(grouping.snippetOf(reasoningOnly), "我先想想……");
  const long = mk([{ kind: "text", text: "A".repeat(200) }]);
  assert.equal(grouping.snippetOf(long).length, 121); // 120 chars + ellipsis
  assert.ok(grouping.snippetOf(long).endsWith("…"));
  assert.equal(grouping.snippetOf(mk([{ kind: "tool-call", name: "x" }])), "");
  assert.equal(grouping.snippetOf(null), "");
});

test("buildTopics: snippet comes from the LAST assistant node of the turn", () => {
  const conv = {
    chat: {
      timeline: {
        turnOrder: [1],
        turns: new Map([[1, { start: undefined, end: undefined, status: "closed", steps: [{}] }]])
      },
      nodes: {
        values: () => [
          { kind: "user", key: "u1", location: { kind: "turn", turn: { turn: 1 } }, data: { content: [{ type: "text", text: "问" }] } },
          { kind: "assistant-step", key: "a1", location: { kind: "step", turn: { turn: 1 } }, data: { blocks: [{ kind: "text", text: "中间结果" }] } },
          { kind: "assistant-step", key: "a2", location: { kind: "step", turn: { turn: 1 } }, data: { blocks: [{ kind: "text", text: "最终答案" }] } }
        ]
      },
      locations: { getTurn: () => [] }
    }
  };
  const topics = grouping.buildTopics(conv);
  assert.equal(topics[0].snippet, "最终答案");
});

test("startOfWeek anchors on Monday", () => {
  const monday = at(2026, 8, 10, 0, 0);
  assert.equal(grouping.startOfWeek(monday), monday);
  assert.equal(grouping.startOfWeek(at(2026, 8, 16, 23, 59)), monday); // Sunday rolls back
});

test("buildTopics: createdAt from turn start with first-step fallback, status, title", () => {
  const conv = {
    chat: {
      timeline: {
        turnOrder: [1, 2],
        turns: new Map([
          [1, { start: { time: at(2026, 8, 15, 8, 0) }, end: undefined, status: "closed", steps: [{}, {}] }],
          [2, { start: undefined, end: undefined, status: "open", steps: [{ start: { time: at(2026, 8, 15, 9, 0) } }] }]
        ])
      },
      nodes: {
        values: () => [{ kind: "user", key: "u1", location: { kind: "turn", turn: { turn: 1 } }, data: { content: [{ type: "text", text: "hello  world" }] } }]
      },
      locations: { getTurn: (t) => (t === 1 ? ["k1"] : []) }
    }
  };
  const topics = grouping.buildTopics(conv);
  assert.equal(topics.length, 2);
  assert.equal(topics[0].turn, 1);
  assert.equal(topics[0].key, "u1");
  assert.equal(topics[0].title, "hello world");
  assert.equal(topics[0].createdAt, at(2026, 8, 15, 8, 0));
  assert.equal(topics[0].status, "closed");
  assert.equal(topics[0].steps, 2);
  assert.equal(topics[1].turn, 2);
  assert.equal(topics[1].createdAt, at(2026, 8, 15, 9, 0)); // first-step fallback
  assert.equal(topics[1].status, "open");
  assert.equal(topics[1].steps, 1);
});

test("buildTopics tolerates a missing timeline", () => {
  assert.deepEqual(grouping.buildTopics(null), []);
  assert.deepEqual(grouping.buildTopics({ chat: {} }), []);
});
