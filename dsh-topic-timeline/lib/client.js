/**
 * dsh-topic-timeline — browser half.
 * 话题时间轴侧栏（Topic Tick Axis / Thread Ruler）:
 * a compact cluster of horizontal ticks centered vertically against the left
 * edge of the conversation column, one tick per topic (user turn). Ticks keep
 * a fixed 22px length; hovering lights one up and stretches it right. The
 * topic at the viewport center is a blue bar, and a topic that is still
 * generating shows a flowing gradient + breathing glow. Ticks keep a uniform
 * default length; only the viewed topic gets a longer 30px blue bar. Date
 * grouping (borrowed from ZCode's taskTimeline bucketing) no longer renders
 * separators — it only feeds the tooltip meta line (「今天 14:32 · N 步」).
 *
 * Structure — ONE factory, three layers (a bundle must register exactly its
 * own id: a second auxiliary factory would survive the HMR invalidate()
 * call and crash the next hot reload with a duplicate-registration error):
 *   - pure data layer between the __GROUPING_SOURCE__ markers: zero DOM,
 *     zero require. Extracted verbatim by test/grouping.test.mjs and run
 *     under Node — the tests exercise the exact code the browser executes.
 *   - styles / ui helpers.
 *   - React bindings + plugin wiring.
 *
 * Copy goes through the harness locale system: the plugin registers the
 * "topic-timeline" dictionary namespace (zh/en) on the `locale` service and
 * declares it on the slot entry, which puts the framework-synthesized `t`
 * seat on the component props. Active locale resolution is inherited from
 * the harness: settings.locale.preference -> browser primary subtag -> zh.
 */
window.__ModuleLoader__.load({
  id: "dsh-topic-timeline",
  factory: (require) => {
    "use strict";
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // __GROUPING_SOURCE_START__
    /* ============================================================ */
    /* data layer: pure, zero DOM, zero require                     */
    /* ============================================================ */

    var DAY_MS = 86400000;

    /** Midnight of the local day containing ts. */
    function startOfDay(ts) {
      var d = new Date(ts);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    }

    /** Midnight of the local Monday-starting week containing ts. */
    function startOfWeek(ts) {
      var d = new Date(ts);
      d.setHours(0, 0, 0, 0);
      var weekday = (d.getDay() + 6) % 7; // Mon = 0 ... Sun = 6
      d.setDate(d.getDate() - weekday);
      return d.getTime();
    }

    /** Midnight of the first day of the local month containing ts. */
    function startOfMonth(ts) {
      var d = new Date(ts);
      d.setHours(0, 0, 0, 0);
      d.setDate(1);
      return d.getTime();
    }

    /**
     * ZCode-style bucket id for one timestamp.
     * dayDiff <= 0 -> today; 1 -> yesterday; 2..3 -> daysAgo:N;
     * then the Monday-week buckets, then natural-month buckets, else older.
     * Note dayDiff 4+ never produces daysAgo — it falls into a week bucket.
     */
    function groupIdOf(ts, now) {
      if (typeof ts !== "number" || !isFinite(ts)) return "older";
      var dayDiff = Math.round((startOfDay(now) - startOfDay(ts)) / DAY_MS);
      if (dayDiff <= 0) return "today";
      if (dayDiff === 1) return "yesterday";
      if (dayDiff <= 3) return "daysAgo:" + dayDiff;
      var thisWeekStart = startOfWeek(now);
      if (startOfWeek(ts) >= thisWeekStart) return "thisWeek";
      if (startOfWeek(ts) >= thisWeekStart - 7 * DAY_MS) return "lastWeek";
      if (startOfMonth(ts) >= startOfMonth(now)) return "thisMonth";
      var d = new Date(now);
      var prevMonthStart = startOfMonth(new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime());
      if (startOfMonth(ts) >= prevMonthStart) return "lastMonth";
      return "older";
    }

    /**
     * Group topics by date bucket, preserving input order inside each
     * group and first-seen order across groups (Map-backed dedupe).
     * @param topics - [{ createdAt?: number }]
     * @param now - epoch ms reference; defaults to Date.now().
     * @returns [{ id: string, items: object[] }]
     */
    function groupTopicsByDate(topics, now) {
      if (typeof now !== "number" || !isFinite(now)) now = Date.now();
      var order = [];
      var byId = new Map();
      if (!Array.isArray(topics)) return order;
      for (var i = 0; i < topics.length; i++) {
        var topic = topics[i];
        var id = groupIdOf(topic && typeof topic === "object" ? topic.createdAt : undefined, now);
        var group = byId.get(id);
        if (group === undefined) {
          group = { id: id, items: [] };
          byId.set(id, group);
          order.push(group);
        }
        group.items.push(topic);
      }
      return order;
    }

    /**
     * Map a bucket id to its i18n dictionary entry.
     * @returns { key: string, params?: { n: number } }
     */
    function groupI18n(id) {
      if (id === "today") return { key: "group.today" };
      if (id === "yesterday") return { key: "group.yesterday" };
      if (id === "thisWeek") return { key: "group.thisWeek" };
      if (id === "lastWeek") return { key: "group.lastWeek" };
      if (id === "thisMonth") return { key: "group.thisMonth" };
      if (id === "lastMonth") return { key: "group.lastMonth" };
      if (id === "older") return { key: "group.older" };
      if (typeof id === "string" && id.indexOf("daysAgo:") === 0) {
        var n = Number(id.slice(8));
        if (isFinite(n)) return { key: "group.daysAgo", params: { n: n } };
      }
      return { key: "group.older" };
    }

    /**
     * Wall-clock time of day: zh -> 24h ("14:32"), en -> 12h ("02:32 PM").
     * Empty string for missing timestamps (the meta line then drops the time).
     */
    function formatTimeOfDay(ts, localeId) {
      if (typeof ts !== "number" || !isFinite(ts)) return "";
      var zh = localeId !== "en";
      try {
        return new Intl.DateTimeFormat(zh ? "zh-CN" : "en-US", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: !zh
        }).format(new Date(ts));
      } catch (e) {
        return "";
      }
    }

    /** Join the text blocks of a user content array into one line. */
    function contentText(content) {
      if (!Array.isArray(content)) return "";
      var out = "";
      for (var i = 0; i < content.length; i++) {
        var block = content[i];
        if (block && block.type === "text" && typeof block.text === "string") {
          var t = block.text.replace(/\s+/g, " ").trim();
          if (t) out += (out ? " " : "") + t;
        }
      }
      return out;
    }

    /**
     * One topic per turn, titled by its user message.
     * Note: both title and createdAt are windowed — the client snapshot only
     * carries the loaded history window, so older turns may appear without a
     * title (rendered as "#<turn>") until their pages load.
     */
    function buildTopics(conv) {
      if (!conv || !conv.chat) return [];
      var chat = conv.chat;
      var timeline = chat.timeline;
      if (!timeline || !Array.isArray(timeline.turnOrder)) return [];
      var userByTurn = new Map();
      var lastAssistantByTurn = new Map();
      var nodes = chat.nodes && chat.nodes.values ? chat.nodes.values() : [];
      for (var ni = 0; ni < nodes.length; ni++) {
        var node = nodes[ni];
        if (!node || !node.location) continue;
        var loc = node.location;
        var turn = loc && (loc.kind === "turn" || loc.kind === "step") && loc.turn ? loc.turn.turn : undefined;
        if (turn === undefined) continue;
        if (node.kind === "user" && !userByTurn.has(turn)) {
          var text = contentText(node.data && node.data.content);
          userByTurn.set(turn, { key: node.key, title: text || "" });
        } else if (node.kind === "assistant-step" || node.kind === "assistant") {
          /* one node per agent step; the last one of the turn is the final
             answer. last one wins. */
          lastAssistantByTurn.set(turn, node);
        }
      }
      var topics = [];
      for (var ti = 0; ti < timeline.turnOrder.length; ti++) {
        var turnN = timeline.turnOrder[ti];
        var keys = [];
        try {
          keys = chat.locations && chat.locations.getTurn ? chat.locations.getTurn(turnN) || [] : [];
        } catch (e) {
          keys = [];
        }
        var u = userByTurn.get(turnN);
        var turnLoc = timeline.turns ? timeline.turns.get(turnN) : undefined;
        var steps = turnLoc && turnLoc.steps ? turnLoc.steps.length : 1;
        var createdAt;
        if (turnLoc && turnLoc.start && typeof turnLoc.start.time === "number") {
          createdAt = turnLoc.start.time;
        } else if (turnLoc && Array.isArray(turnLoc.steps) && turnLoc.steps.length > 0) {
          var first = turnLoc.steps[0];
          if (first && first.start && typeof first.start.time === "number") createdAt = first.start.time;
        }
        topics.push({
          turn: turnN,
          key: u ? u.key : (keys[0] || null),
          allKeys: keys,
          title: u ? u.title : "",
          steps: Math.max(1, steps),
          createdAt: createdAt,
          status: turnLoc && turnLoc.status ? turnLoc.status : "unknown",
          snippet: snippetOf(lastAssistantByTurn.get(turnN))
        });
      }
      return topics;
    }

    /** Join an assistant view node's text blocks (kind === "text"). */
    function assistantText(node) {
      var content = node && node.data ? node.data.blocks : null;
      if (!Array.isArray(content)) return "";
      var out = "";
      for (var i = 0; i < content.length; i++) {
        var block = content[i];
        if (block && block.kind === "text" && typeof block.text === "string") {
          var t = block.text.replace(/\s+/g, " ").trim();
          if (t) out += (out ? " " : "") + t;
        }
      }
      return out;
    }

    /** Join an assistant view node's reasoning blocks (kind === "reasoning"). */
    function assistantReasoning(node) {
      var content = node && node.data ? node.data.blocks : null;
      if (!Array.isArray(content)) return "";
      var out = "";
      for (var i = 0; i < content.length; i++) {
        var block = content[i];
        if (block && block.kind === "reasoning" && typeof block.text === "string") {
          var t = block.text.replace(/\s+/g, " ").trim();
          if (t) out += (out ? " " : "") + t;
        }
      }
      return out;
    }

    /**
     * Leading snippet of the assistant answer for the hover card: the final
     * reply text first (best recall value), the reasoning chain as a fallback
     * when the answer has no text blocks, hard-truncated with an ellipsis.
     */
    function snippetOf(node, maxLen) {
      if (typeof maxLen !== "number" || !isFinite(maxLen)) maxLen = 120;
      var text = assistantText(node) || assistantReasoning(node);
      if (!text) return "";
      return text.length > maxLen ? text.slice(0, maxLen).replace(/\s+$/, "") + "…" : text;
    }

    exports.startOfDay = startOfDay;
    exports.startOfWeek = startOfWeek;
    exports.startOfMonth = startOfMonth;
    exports.groupIdOf = groupIdOf;
    exports.groupTopicsByDate = groupTopicsByDate;
    exports.groupI18n = groupI18n;
    exports.formatTimeOfDay = formatTimeOfDay;
    exports.buildTopics = buildTopics;
    exports.snippetOf = snippetOf;
    // __GROUPING_SOURCE_END__

    /* ------------------------------------------------------------ */
    /* ui layer: react + styles + plugin wiring                     */
    /* ------------------------------------------------------------ */

    const react = require("react");
    const h = react.createElement;

    /* dictionary copy (harness locale namespace "topic-timeline") */
    const NAMESPACE = "topic-timeline";
    const DICTS = {
      zh: {
        "group.today": "今天",
        "group.yesterday": "昨天",
        "group.daysAgo": "{n} 天前",
        "group.thisWeek": "本周",
        "group.lastWeek": "上周",
        "group.thisMonth": "本月",
        "group.lastMonth": "上月",
        "group.older": "更早",
        "meta.steps": "{n} 步",
        "meta.generating": "正在生成…",
        "aria.rail": "话题时间轴",
        "aria.current": "（当前话题）"
      },
      en: {
        "group.today": "Today",
        "group.yesterday": "Yesterday",
        "group.daysAgo": "{n} days ago",
        "group.thisWeek": "This week",
        "group.lastWeek": "Last week",
        "group.thisMonth": "This month",
        "group.lastMonth": "Last month",
        "group.older": "Older",
        "meta.steps": "{n} steps",
        "meta.generating": "Generating…",
        "aria.rail": "Topic timeline",
        "aria.current": " (current topic)"
      }
    };

    /** zh-only fallback when no locale face is installed (standalone runs). */
    function fallbackT(key, params) {
      const dict = DICTS.zh || {};
      let s = dict[key] !== undefined ? dict[key] : key;
      if (params) s = s.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
      return s;
    }

    /* ------------------------------------------------------------ */
    /* styles                                                        */
    /* ------------------------------------------------------------ */

    const tagId = "dsh-topic-timeline/topic-timeline.css";
    if (typeof document !== "undefined") {
      /* Force-replace: HMR can leave stale tags behind, and a guard that
         skips injection on any surviving tag would then strand the page
         without styles. Always remove ours and re-inject one fresh copy. */
      for (const stale of document.querySelectorAll("style[data-plugin-css=" + JSON.stringify(tagId) + "]")) stale.remove();
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-topic-timeline";
      tag.dataset.pluginCss = tagId;
      tag.textContent = [
        /* v0.1 visual: a compact cluster centered in the conversation column.
           The tick itself stays a fixed 22px bar; only :hover lights it up and
           stretches it right to 37px. The ::after box widens the hit area so a
           human mouse can actually land on the 4px-tall bar (it is layout-free:
           absolutely positioned, so the flex column keeps its tight packing). */
        ".tt-rail{position:fixed;z-index:40;width:22px;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;pointer-events:none}",
        ".tt-tick{pointer-events:auto;border:0;padding:0;margin:0;cursor:pointer;border-radius:999px;background:rgba(255,255,255,.35);transition:background-color .15s ease,box-shadow .18s ease,width .22s cubic-bezier(.2,.7,.3,1);position:relative;flex:none;width:22px;height:2px}",
        ".tt-tick::after{content:'';position:absolute;left:-3px;top:-7px;right:-8px;bottom:-7px}",
        ".tt-tick:hover{background:#fff;width:37px !important}",
        ".tt-tick:focus-visible{background:#fff;width:37px !important;outline:2px solid rgba(255,255,255,.6);outline-offset:2px}",
        ".tt-tick.tt-active{background:#2f6bff;box-shadow:0 0 4px rgba(47,107,255,.55),0 0 10px rgba(47,107,255,.35),0 0 16px rgba(47,107,255,.2);animation:tt-glow 2.2s ease-in-out infinite}",
        ".tt-tick.tt-active:hover,.tt-tick.tt-active:focus-visible{background:#fff}",
        /* generating: ZCode animated-gradient-text geometry (0/34/50/66/100%
           stops, 300% canvas) adapted to a solid bar — the soft band is an
           opaque lightened blue so chat text never shows through. Flow:
           1.2s sweep + 1.2s rest (2.4s cycle, ZCode's 4s halved for 22px). */
        ".tt-tick.tt-generating{background:linear-gradient(90deg,#2f6bff 0%,#2f6bff 34%,#97b5ff 50%,#2f6bff 66%,#2f6bff 100%);background-size:300% 100%;animation:tt-flow 2.4s linear infinite,tt-pulse 1.6s ease-in-out infinite}",
        ".tt-tick.tt-generating:hover,.tt-tick.tt-generating:focus-visible{background:linear-gradient(90deg,#2f6bff 0%,#2f6bff 34%,#97b5ff 50%,#2f6bff 66%,#2f6bff 100%);background-size:300% 100%}",
        "@keyframes tt-flow{0%{background-position:100% 0}50%{background-position:0 0}100%{background-position:0 0}}",
        "@keyframes tt-pulse{0%,100%{box-shadow:0 0 8px rgba(47,107,255,.55)}50%{box-shadow:0 0 14px rgba(47,107,255,.85)}}",
        "@keyframes tt-glow{0%,100%{box-shadow:0 0 4px rgba(47,107,255,.55),0 0 10px rgba(47,107,255,.35),0 0 16px rgba(47,107,255,.2)}50%{box-shadow:0 0 6px rgba(47,107,255,.7),0 0 13px rgba(47,107,255,.45),0 0 20px rgba(47,107,255,.3)}}",
        ".tt-tip{position:absolute;left:calc(100% + 9px);top:50%;transform:translateY(-50%);pointer-events:none;opacity:0;transition:opacity .12s ease-out}",
        ".tt-tip-inner{background:rgba(15,23,42,.92);color:#dbeafe;border-radius:8px;padding:6px 10px;box-shadow:0 2px 10px rgba(0,0,0,.25);display:flex;flex-direction:column;gap:2px;max-width:280px;transform:translateY(2px) scale(.97);transition:transform .15s ease-out}",
        ".tt-tip-title{font-size:12px;font-weight:600;color:#e2e8f0;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
        ".tt-tip-meta{font-size:11px;line-height:14px;color:rgba(219,234,254,.65);white-space:nowrap}",
        ".tt-tip-snippet{font-size:11px;line-height:16px;color:rgba(219,234,254,.8);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:normal;word-break:break-word;max-width:280px}",
        ".tt-tick:hover .tt-tip,.tt-tick:focus-visible .tt-tip{opacity:1;transition-delay:90ms}",
        ".tt-tick:hover .tt-tip-inner,.tt-tick:focus-visible .tt-tip-inner{transform:translateY(0) scale(1)}",
        "@media (prefers-reduced-motion: reduce){.tt-tick{transition:background-color .15s ease,box-shadow .18s ease}.tt-tick:hover,.tt-tick:focus-visible{width:22px}.tt-tick.tt-generating{animation:none;background:#2f6bff;background-size:100% 100%;box-shadow:0 0 8px rgba(47,107,255,.55)}.tt-tick.tt-active{animation:none}.tt-tip,.tt-tip-inner{transition:none}}"
      ].join("");
      document.head.appendChild(tag);
    }

    /* ------------------------------------------------------------ */
    /* ui helpers                                                   */
    /* ------------------------------------------------------------ */

    /** Mini-card meta line: "<组标签> <时间> · <n> 步", or 正在生成…. */
    function metaText(topic, groupId, t, localeId) {
      const parts = [];
      if (topic.status === "open") {
        parts.push(t("meta.generating"));
      } else {
        const entry = groupI18n(groupId);
        const label = t(entry.key, entry.params);
        const time = formatTimeOfDay(topic.createdAt, localeId);
        parts.push(time ? label + " " + time : label);
      }
      parts.push(t("meta.steps", { n: topic.steps }));
      return parts.join(" · ");
    }

    function findRow(key) {
      if (!key || typeof document === "undefined") return null;
      const rows = document.querySelectorAll("[data-chat-anchor-key]");
      for (const row of rows) {
        if (row.dataset.chatAnchorKey === key) return row;
      }
      return null;
    }

    function jumpTo(key) {
      const row = findRow(key);
      if (row && typeof row.scrollIntoView === "function") {
        row.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      // The target topic is outside the loaded history window:
      // scroll to the top to trigger the app's pagination, then retry.
      const scroller = document.querySelector("[data-conversation-scroll]");
      if (!scroller) return;
      scroller.scrollTo({ top: 0, behavior: "smooth" });
      let tries = 0;
      const timer = setInterval(() => {
        tries++;
        const r = findRow(key);
        if (r && typeof r.scrollIntoView === "function") {
          clearInterval(timer);
          r.scrollIntoView({ behavior: "smooth", block: "center" });
        } else if (tries > 10) {
          clearInterval(timer);
        }
      }, 600);
    }

    /**
     * Rail model: one tick per topic, in topic order. Date grouping no longer
     * renders a separator — its only remaining job is the tooltip meta line
     * (「今天 14:32 · N 步」), so each tick just carries its group id.
     */
    function buildRailModel(topics, now) {
      const groups = groupTopicsByDate(topics, now);
      const groupByTurn = new Map();
      for (const group of groups) {
        for (const topic of group.items) groupByTurn.set(topic.turn, group.id);
      }
      return topics.map((topic) => ({ kind: "tick", topic: topic, groupId: groupByTurn.get(topic.turn) }));
    }

    /**
     * v0.1 packing: a compact, vertically centered cluster. The gap only
     * shrinks to fit the rail (2..12px); when even the minimum gap overflows,
     * the oldest topics are dropped.
     */
    function fitItems(items, height) {
      if (!items || items.length === 0 || !height) return { list: [], gap: 8, tickH: 2 };
      const n = items.length;
      const totalH = n * 2;
      let gap = n > 1 ? Math.max(2, Math.min(12, Math.floor((height - totalH) / Math.max(1, n - 1)))) : 12;
      if (totalH + (n - 1) * gap <= height) return { list: items, gap: gap, tickH: 2 };
      gap = 2;
      if (totalH + (n - 1) * gap <= height) return { list: items, gap: gap, tickH: 2 };
      const count = Math.max(1, Math.floor((height + gap) / (2 + gap)));
      const list = items.slice(n - count);
      if (list.length === 0) list.push(items[n - 1]);
      return { list: list, gap: gap, tickH: 2 };
    }

    /* ------------------------------------------------------------ */
    /* react bindings                                                */
    /* ------------------------------------------------------------ */

    /** Fixed rail geometry, pinned to the conversation scroll column. */
    function useRailGeometry() {
      const [geom, setGeom] = react.useState(null);
      react.useLayoutEffect(() => {
        let el = null;
        let ro = null;
        let raf = 0;
        const measure = () => {
          raf = 0;
          const found = document.querySelector("[data-conversation-scroll]");
          if (found !== el) {
            if (ro) { ro.disconnect(); ro = null; }
            el = found;
            if (el && typeof ResizeObserver !== "undefined") {
              ro = new ResizeObserver(schedule);
              ro.observe(el);
            }
          }
          if (!el) { setGeom(null); return; }
          const r = el.getBoundingClientRect();
          setGeom((prev) => prev && prev.left === r.left && prev.top === r.top && prev.width === r.width && prev.height === r.height ? prev : { left: r.left, top: r.top, width: r.width, height: r.height });
        };
        const schedule = () => { if (!raf) raf = requestAnimationFrame(measure); };
        measure();
        window.addEventListener("resize", schedule);
        window.addEventListener("scroll", schedule, true);
        return () => {
          cancelAnimationFrame(raf);
          window.removeEventListener("resize", schedule);
          window.removeEventListener("scroll", schedule, true);
          if (ro) ro.disconnect();
        };
      }, []);
      return geom;
    }

    function Tip(props) {
      return h("span", { className: "tt-tip" },
        h("span", { className: "tt-tip-inner" },
          h("span", { className: "tt-tip-title" }, props.label),
          props.snippet ? h("span", { className: "tt-tip-snippet" }, props.snippet) : null,
          props.meta ? h("span", { className: "tt-tip-meta" }, props.meta) : null));
    }

    function Tick(props) {
      const topic = props.topic;
      const active = topic.turn === props.activeTurn;
      const generating = topic.status === "open";
      const label = topic.title || "#" + topic.turn;
      const meta = metaText(topic, props.groupId, props.t, props.localeId);
      /* The answer snippet is only shown for finished turns — a streaming
         half-snippet would jump around on every update. */
      const snippet = topic.status === "open" ? "" : (topic.snippet || "");
      /* Uniform default length; the viewed tick is 30px. The hovered tick
         wins via the !important CSS rules (37px + white + tip); the JS-side
         ripple width covers the neighbours only. */
      return h("button", {
        key: "t" + topic.turn,
        type: "button",
        className: "tt-tick" + (active ? " tt-active" : "") + (generating ? " tt-generating" : ""),
        style: { height: props.tickH + "px", width: props.w + "px" },
        "aria-label": label + (active ? " " + props.t("aria.current") : ""),
        "aria-current": active ? "true" : undefined,
        onClick: () => jumpTo(topic.key),
        onMouseEnter: props.onEnter,
        onMouseLeave: props.onLeave
      }, h(Tip, { label: label, meta: meta, snippet: snippet }));
    }

    function TopicTimelineRail(props) {
      const conv = props.useSession((s) => s);
      const t = typeof props.t === "function" ? props.t : fallbackT;
      const localeId = props.localeId || "zh";
      const topics = react.useMemo(() => buildTopics(conv), [conv]);
      /* Minute-granular clock: group labels follow day/month boundaries
         without re-bucketing on every render. */
      const minute = Math.floor(Date.now() / 60000);
      const items = react.useMemo(() => buildRailModel(topics, Date.now()), [topics, minute]);
      const keyToTurn = react.useMemo(() => {
        const map = new Map();
        for (const item of items) {
          for (const k of item.topic.allKeys) if (k) map.set(k, item.topic.turn);
        }
        return map;
      }, [items]);
      const [activeTurn, setActiveTurn] = react.useState(-1);
      const [hoveredIndex, setHoveredIndex] = react.useState(-1);
      const geom = useRailGeometry();

      /* Hover ripple: the hovered tick is the longest (37px, CSS handles the
         white + tip); neighbours lengthen with distance 30 -> 26 -> 22 and
         slide back when the hover leaves. Colours never follow the ripple —
         only the hovered element gets the :hover white. */
      const rippleW = (i) => {
        const d = Math.abs(i - hoveredIndex);
        if (d === 0) return 37;
        return Math.max(16, 30 - (d - 1) * 4);
      };

      /* Scroll-spy: the topic at the viewport center is active. While the
         user follows the latest (near the bottom), the newest topic takes
         the highlight; a brand-new user input also takes it immediately —
         the previous tick then falls back to its resting style. */
      const prevNewestRef = react.useRef(-1);
      react.useEffect(() => {
        if (topics.length === 0) { setActiveTurn(-1); prevNewestRef.current = -1; return; }
        const el = document.querySelector("[data-conversation-scroll]");
        const newest = topics[topics.length - 1].turn;
        const isNewInput = prevNewestRef.current !== -1 && prevNewestRef.current !== newest;
        prevNewestRef.current = newest;
        if (!el) { setActiveTurn(newest); return; }
        let raf = 0;
        const update = () => {
          raf = 0;
          /* Following the latest: yield the highlight to the newest topic. */
          if (el.scrollHeight - (el.scrollTop + el.clientHeight) < 120) {
            setActiveTurn((prev) => (prev === newest ? prev : newest));
            return;
          }
          const rect = el.getBoundingClientRect();
          const center = rect.top + el.clientHeight / 2;
          const rows = [...el.querySelectorAll("[data-chat-anchor-key]")];
          let chosen = null;
          for (const row of rows) {
            const r = row.getBoundingClientRect();
            if (r.top <= center && r.bottom >= center) { chosen = row; break; }
          }
          if (chosen === null && rows.length > 0) {
            let bestRow = rows[0];
            let bestD = Infinity;
            for (const row of rows) {
              const r = row.getBoundingClientRect();
              const d = Math.min(Math.abs(r.top - center), Math.abs(r.bottom - center));
              if (d < bestD) { bestD = d; bestRow = row; }
            }
            chosen = bestRow;
          }
          let found = -1;
          if (chosen !== null) {
            found = keyToTurn.get(chosen.dataset.chatAnchorKey) ?? -1;
            if (found === -1) {
              const i = rows.indexOf(chosen);
              for (let j = i - 1; j >= 0; j--) { const tn = keyToTurn.get(rows[j].dataset.chatAnchorKey); if (tn !== undefined) { found = tn; break; } }
              if (found === -1) for (let j = i + 1; j < rows.length; j++) { const tn = keyToTurn.get(rows[j].dataset.chatAnchorKey); if (tn !== undefined) { found = tn; break; } }
            }
          }
          if (found === -1) found = newest;
          setActiveTurn((prev) => (prev === found ? prev : found));
        };
        const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
        el.addEventListener("scroll", onScroll, { passive: true });
        window.addEventListener("resize", onScroll);
        update();
        /* A new user input takes the highlight immediately, before its
           content grows enough to cover the viewport center. */
        if (isNewInput) setActiveTurn(newest);
        return () => {
          cancelAnimationFrame(raf);
          el.removeEventListener("scroll", onScroll);
          window.removeEventListener("resize", onScroll);
        };
      }, [topics, keyToTurn]);

      if (topics.length === 0 || geom === null) return null;

      const fitted = fitItems(items, geom.height);
      // The rail sits inset from the conversation column's left edge so the
      // ticks keep a little breathing room from the boundary; every tick
      // extends into the content gutter and hover stretches it further right.
      const TICK_INSET = 8;
      const left = Math.max(0, geom.left) + TICK_INSET;
      return h("div", {
        className: "tt-rail",
        role: "navigation",
        "aria-label": t("aria.rail"),
        style: { left: left + "px", top: geom.top + "px", height: geom.height + "px", gap: fitted.gap + "px" }
      }, fitted.list.map((item, i) => {
        const active = item.topic.turn === activeTurn;
        const base = active ? 30 : 16;
        const w = hoveredIndex === i ? 37 : (hoveredIndex >= 0 ? Math.max(base, rippleW(i)) : base);
        return h(Tick, {
          topic: item.topic,
          groupId: item.groupId,
          activeTurn: activeTurn,
          tickH: fitted.tickH,
          t: t,
          localeId: localeId,
          w: w,
          onEnter: () => setHoveredIndex(i),
          onLeave: () => setHoveredIndex((prev) => (prev === i ? -1 : prev))
        });
      }));
    }

    /* ------------------------------------------------------------ */
    /* plugin entry                                                  */
    /* ------------------------------------------------------------ */

    const inject = ["slots"];
    function apply(ctx) {
      const locale = ctx.get("locale");
      let disposeDict = null;
      if (locale && typeof locale.register === "function") {
        try {
          disposeDict = locale.register(NAMESPACE, DICTS);
        } catch (error) {
          /* Hot reload racing an undisposed fiber: the surviving dictionary
             carries identical copy — reuse it instead of failing the apply. */
          disposeDict = null;
        }
      }
      if (disposeDict !== null) ctx.effect(() => disposeDict, "dsh-topic-timeline: locale dictionary");
      const localeActive = () => locale && typeof locale.getLocale === "function" ? locale.getLocale().active : "zh";
      ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
        name: "conversation.input.dock",
        id: "topic-timeline",
        order: 50,
        registrant: "dsh-topic-timeline",
        ...(locale ? { locale: NAMESPACE } : {})
      }, function TopicTimelineDockEntry(props) {
        return h(TopicTimelineRail, { useSession: props.useSession, t: props.t, localeId: localeActive() });
      }));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
