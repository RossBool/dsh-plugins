/**
 * dsh-mcp-manager — browser half.
 *
 * Settings → MCP 服务器：可视化增删改查 MCP 服务器（stdio / streamable-http），
 * 启用/停用开关，运行时状态（连接中 / 已连接 N 个工具 / 重连中 / 失败），
 * 全部通过 settings wire API 写入 host（settings.yaml 用户层，实时热生效），
 * 无需命令行/文件编辑。
 */
window.__ModuleLoader__.load({
  id: "dsh-mcp-manager-ui",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const h = react.createElement;
    const { createSnapshotStore } = require("@deepseek-ai/dsh-client-runtime/client");
    const { bindSnapshotSelector } = require("@deepseek-ai/dsh-client-web-react");

    /* ------------------------------------------------------------ */
    /* styles                                                        */
    /* ------------------------------------------------------------ */

    const CSS = [
      ".mcp-page{width:100%;max-width:760px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:16px;display:flex}",
      ".mcp-head{flex-direction:column;gap:4px;display:flex}",
      ".mcp-head h3{margin:0;font-size:16px;font-weight:600;line-height:24px}",
      ".mcp-head p{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}",
      ".mcp-toolbar{justify-content:flex-end;display:flex}",
      ".mcp-add{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;border-radius:8px;height:32px;align-items:center;gap:6px;padding:0 12px;font-size:13px;display:inline-flex}",
      ".mcp-add:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".mcp-add:disabled{opacity:.55;cursor:default}",
      ".mcp-error{border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent);color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);border-radius:8px;padding:8px 12px;font-size:13px;line-height:20px}",
      ".mcp-empty{border:1px dashed var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);border-radius:10px;justify-content:center;padding:26px 14px;font-size:13px;display:flex}",
      ".mcp-list{flex-direction:column;gap:10px;margin:0;padding:0;list-style:none;display:flex}",
      ".mcp-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;overflow:hidden}",
      ".mcp-card-main{justify-content:space-between;align-items:center;gap:12px;padding:12px 14px;display:flex}",
      ".mcp-card-left{align-items:center;gap:10px;min-width:0;display:flex}",
      ".mcp-dot{border-radius:999px;flex:none;width:8px;height:8px;background:var(--dsw-alias-label-tertiary)}",
      ".mcp-dot[data-state=connected]{background:var(--dsw-alias-state-success-primary)}",
      ".mcp-dot[data-state=connecting]{background:var(--dsw-alias-state-business-primary)}",
      ".mcp-dot[data-state=failed]{background:var(--dsw-alias-state-error-primary)}",
      ".mcp-name{font-size:14px;font-weight:600;line-height:20px}",
      ".mcp-tag{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);border-radius:5px;padding:1px 6px;font-size:11px;line-height:16px;white-space:nowrap}",
      ".mcp-tag[data-on=true]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);color:var(--dsw-alias-state-success-primary)}",
      ".mcp-tag[data-on=false]{opacity:.6}",
      ".mcp-state{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin-top:2px}",
      ".mcp-state[data-state=failed]{color:var(--dsw-alias-state-error-primary)}",
      ".mcp-card-actions{align-items:center;gap:6px;flex:none;display:flex}",
      ".mcp-btn{border:1px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;border-radius:6px;height:26px;padding:0 9px;font-size:12px}",
      ".mcp-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".mcp-btn.danger:hover{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent)}",
      ".mcp-switch{position:relative;width:32px;height:18px;flex:none;cursor:pointer}",
      ".mcp-switch input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer}",
      ".mcp-switch i{position:absolute;inset:0;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);transition:background .15s}",
      ".mcp-switch i:before{content:'';position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:transform .15s}",
      ".mcp-switch input:checked+i{background:var(--dsw-alias-state-success-primary)}",
      ".mcp-switch input:checked+i:before{transform:translateX(14px)}",
      ".mcp-tools{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;padding:0 14px 10px;overflow-wrap:anywhere}",
      ".mcp-form{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;padding:14px;flex-direction:column;gap:12px;display:flex}",
      ".mcp-field{flex-direction:column;gap:5px;display:flex}",
      ".mcp-field label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
      ".mcp-field input,.mcp-field select,.mcp-field textarea{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;border-radius:7px;outline:none;padding:6px 10px;font-size:13px;line-height:20px;width:100%;box-sizing:border-box}",
      ".mcp-field input:focus-visible,.mcp-field select:focus-visible,.mcp-field textarea:focus-visible{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 18%,transparent)}",
      ".mcp-field textarea{resize:vertical;min-height:52px;font-family:var(--ds-font-family-code);font-size:12px}",
      ".mcp-field-hint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}",
      ".mcp-form-actions{justify-content:flex-end;gap:8px;display:flex}",
      ".mcp-save{border:0;background:var(--dsw-alias-state-business-primary);color:#fff;font:inherit;cursor:pointer;border-radius:7px;height:30px;padding:0 14px;font-size:13px}",
      ".mcp-save:disabled{opacity:.55;cursor:default}",
      ".mcp-cancel{border:1px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;border-radius:7px;height:30px;padding:0 12px;font-size:13px}",
    ].join("");
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin=dsh-mcp-manager]") === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-mcp-manager";
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /* ------------------------------------------------------------ */
    /* dictionary                                                    */
    /* ------------------------------------------------------------ */

    const NS = "settings.mcp";
    const zh = {
      nav: "MCP 服务器",
      title: "MCP 服务器",
      subtitle: "配置 MCP 服务器后，其工具会以 mcp__<服务器名>__<工具名> 的形式注册给我使用；保存即实时生效。",
      add: "添加服务器",
      empty: "还没有配置任何 MCP 服务器。",
      enable: "启用",
      disable: "停用",
      edit: "编辑",
      delete: "删除",
      saving: "保存中…",
      save: "保存",
      cancel: "取消",
      deleting: "删除中…",
      stateConnected: (n) => "已连接 · " + n + " 个工具",
      stateConnecting: "连接中…",
      stateReconnecting: "未连接，自动重连中…",
      stateFailed: "失败",
      stateDisabled: "已停用",
      stateUnknown: "状态未知",
      noSession: "打开一个会话后显示运行状态",
      formTitleAdd: "添加 MCP 服务器",
      formTitleEdit: "编辑服务器",
      serverName: "服务器名（唯一命名空间）",
      serverNameHint: "1–32 位字母/数字/下划线/连字符，如 filesystem、github；工具名将形如 mcp__filesystem__read_file",
      transport: "连接方式",
      transportStdio: "本地进程（stdio）",
      transportHttp: "远程 HTTP（Streamable）",
      command: "启动命令",
      commandHint: "可执行文件绝对路径或 PATH 中的命令，如 npx",
      args: "参数（每行一个）",
      env: "环境变量（每行 KEY=VALUE）",
      cwd: "工作目录",
      url: "端点 URL",
      headers: "请求头（每行 KEY: VALUE）",
      timeout: "单次工具调用超时（毫秒）",
      enabled: "启用该服务器",
      toolsLabel: "工具",
      nameInvalid: "服务器名仅允许 1–32 位字母/数字/下划线/连字符",
      nameRequired: "请填写服务器名",
      commandRequired: "请填写启动命令",
      urlRequired: "请填写端点 URL",
      saveFailed: "保存失败",
      conflict: "配置已被其它页面修改，已重新加载，请重试。",
      loadFailed: "加载配置失败",
      retry: "重试",
      confirmDelete: "确定删除该服务器并卸载其全部工具？",
    };
    const en = {
      nav: "MCP Servers",
      title: "MCP Servers",
      subtitle: "Tools from configured MCP servers register as mcp__<name>__<tool>; changes apply live on save.",
      add: "Add server",
      empty: "No MCP servers configured yet.",
      enable: "Enable",
      disable: "Disable",
      edit: "Edit",
      delete: "Delete",
      saving: "Saving…",
      save: "Save",
      cancel: "Cancel",
      deleting: "Deleting…",
      stateConnected: (n) => "Connected · " + n + " tools",
      stateConnecting: "Connecting…",
      stateReconnecting: "Not connected, retrying…",
      stateFailed: "Failed",
      stateDisabled: "Disabled",
      stateUnknown: "Unknown",
      noSession: "Open a session to see runtime status",
      formTitleAdd: "Add MCP server",
      formTitleEdit: "Edit server",
      serverName: "Server name (unique namespace)",
      serverNameHint: "1-32 chars of A-Z a-z 0-9 _ -, e.g. filesystem; tools become mcp__filesystem__read_file",
      transport: "Transport",
      transportStdio: "Local process (stdio)",
      transportHttp: "Remote HTTP (streamable)",
      command: "Command",
      commandHint: "Absolute path or PATH command, e.g. npx",
      args: "Arguments (one per line)",
      env: "Environment (KEY=VALUE per line)",
      cwd: "Working directory",
      url: "Endpoint URL",
      headers: "Headers (KEY: VALUE per line)",
      timeout: "Tool-call timeout (ms)",
      enabled: "Enabled",
      toolsLabel: "Tools",
      nameInvalid: "Server name allows only 1-32 chars of A-Z a-z 0-9 _ -",
      nameRequired: "Server name is required",
      commandRequired: "Command is required",
      urlRequired: "Endpoint URL is required",
      saveFailed: "Save failed",
      conflict: "Config changed elsewhere; reloaded, please retry.",
      loadFailed: "Failed to load configuration",
      retry: "Retry",
      confirmDelete: "Delete this server and unregister all its tools?",
    };

    /* ------------------------------------------------------------ */
    /* controller                                                    */
    /* ------------------------------------------------------------ */

    /** Settings store controller: one snapshot joining the mcp-servers namespace. */
    class McpController {
      constructor(api, remote) {
        this.api = api;
        this.remote = remote;
        this.store = createSnapshotStore({
          status: "idle",
          servers: {},
          revision: undefined,
          error: null,
        });
      }
      getSnapshot() { return this.store.getSnapshot(); }
      async load() {
        try {
          const response = await this.api.settings.describe({});
          if (!response || !response.result || !response.result.ok) throw new Error("describe failed");
          const { namespaces } = response.result.value;
          const view = (namespaces || []).find((candidate) => candidate && candidate.ns === "mcp-servers");
          if (view === undefined) {
            this.store.update((draft) => { draft.status = "ready"; draft.servers = {}; draft.error = null; });
            return;
          }
          const servers = view.value && typeof view.value === "object" ? (view.value.servers || {}) : {};
          this.store.update((draft) => {
            draft.status = "ready";
            draft.servers = servers;
            draft.revision = view.revision;
            draft.error = null;
          });
        } catch (error) {
          this.store.update((draft) => {
            if (draft.status !== "ready") draft.status = "error";
            draft.error = error instanceof Error ? error.message : String(error);
          });
        }
      }
      /** One settings mutate; on conflict reload and rethrow with a friendly code. */
      async mutate(ops) {
        const snapshot = this.getSnapshot();
        const response = await this.api.settings.mutate({
          ns: "mcp-servers",
          ops,
          ...(snapshot.revision === undefined ? {} : { expectedRevision: snapshot.revision }),
        });
        if (!response || !response.result) throw new Error("no response");
        if (response.result.ok) {
          const view = response.result.value;
          this.store.update((draft) => {
            draft.status = "ready";
            draft.servers = view && view.value && typeof view.value === "object" ? (view.value.servers || {}) : {};
            draft.revision = view ? view.revision : draft.revision;
            draft.error = null;
          });
          return;
        }
        const error = response.result.error;
        const code = error && error.code;
        if (code === "SETTINGS_CONFLICT") {
          await this.load();
          throw Object.assign(new Error(code), { conflict: true });
        }
        throw new Error((error && error.message) || "mutate failed");
      }
      async saveServer(serverName, spec) {
        await this.mutate([{ op: "set", path: ["servers", serverName], value: spec }]);
      }
      async deleteServer(serverName) {
        await this.mutate([{ op: "unset", path: ["servers", serverName] }]);
      }
      /** Runtime status via /mcp-status command (host JSON). */
      async fetchStatus(sessionId) {
        const result = await this.remote.commands.execute(sessionId, "/mcp-status");
        if (!result || !result.ok) throw new Error("command execute failed");
        const execution = result.value;
        if (execution === undefined) throw new Error("unknown command");
        const commandResult = execution.result;
        if (commandResult.kind === "error") throw new Error(commandResult.text || "command error");
        return JSON.parse(commandResult.text || "{}");
      }
    }

    /* ------------------------------------------------------------ */
    /* components                                                    */
    /* ------------------------------------------------------------ */

    const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
    const POLL_INTERVAL_MS = 5000;

    function parseKeyValues(lines) {
      const out = {};
      for (const raw of (lines || "").split(/\n/)) {
        const line = raw.trim();
        if (!line) continue;
        const idx = line.indexOf("=");
        if (idx <= 0) continue;
        out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
      return out;
    }
    function parseHeaders(lines) {
      const out = {};
      for (const raw of (lines || "").split(/\n/)) {
        const line = raw.trim();
        if (!line) continue;
        const idx = line.indexOf(":");
        if (idx <= 0) continue;
        out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
      return out;
    }
    function toLines(record) {
      return Object.entries(record || {}).map(([k, v]) => k + "=" + v).join("\n");
    }
    function toHeaderLines(record) {
      return Object.entries(record || {}).map(([k, v]) => k + ": " + v).join("\n");
    }

    function Switch({ checked, onChange, label }) {
      return h("label", { className: "mcp-switch", title: label },
        h("input", { type: "checkbox", checked, onChange: (e) => onChange(e.target.checked) }),
        h("i", null));
    }

    function statusViewOf(runtime, name) {
      const entry = runtime && runtime.servers ? runtime.servers.find((s) => s.serverName === name) : undefined;
      return entry;
    }

    function ServerCard({ name, spec, runtimeEntry, t, onEdit, onDelete, onToggle }) {
      const enabled = spec && spec.enabled === true;
      const state = runtimeEntry ? runtimeEntry.state : null;
      const toolCount = runtimeEntry ? runtimeEntry.toolCount : 0;
      const tools = runtimeEntry && Array.isArray(runtimeEntry.tools) ? runtimeEntry.tools : [];
      // 没有 runtime 数据（未拉到 /mcp-status，例如当前无 live agent 会话上下文）时，
      // 不显示误导性的"状态未知"文字，保留卡片其他字段干净呈现。
      const noRuntime = !runtimeEntry;
      let stateText = null;
      let dotState = "idle";
      if (!enabled) { stateText = t("stateDisabled"); dotState = "disabled"; }
      else if (noRuntime) { stateText = null; dotState = "idle"; }
      else if (state === "connecting") { stateText = t("stateConnecting"); dotState = "connecting"; }
      else if (state === "ready" && toolCount > 0) { stateText = t("stateConnected")(toolCount); dotState = "connected"; }
      else if (state === "ready" && toolCount === 0) { stateText = t("stateReconnecting"); dotState = "connecting"; }
      else if (state === "failed") { stateText = t("stateFailed") + (runtimeEntry.error ? ": " + runtimeEntry.error : ""); dotState = "failed"; }
      return h("li", { className: "mcp-card" },
        h("div", { className: "mcp-card-main" },
          h("div", { className: "mcp-card-left" },
            h("span", { className: "mcp-dot", "data-state": dotState }),
            h("span", { className: "mcp-name" }, name),
            h("span", { className: "mcp-tag", "data-on": enabled ? "true" : "false" }, enabled ? (spec && spec.transport === "streamable-http" ? "HTTP" : "stdio") : t("stateDisabled")),
            stateText !== null ? h("div", null, h("div", { className: "mcp-state", "data-state": dotState }, stateText)) : null),
          h("div", { className: "mcp-card-actions" },
            h(Switch, { checked: enabled, label: enabled ? t("disable") : t("enable"), onChange: (next) => onToggle(next) }),
            h("button", { type: "button", className: "mcp-btn", onClick: onEdit }, t("edit")),
            h("button", { type: "button", className: "mcp-btn danger", onClick: onDelete }, t("delete")))),
        tools.length > 0 ? h("div", { className: "mcp-tools" }, t("toolsLabel") + ": " + tools.map((tool) => tool.slice(("mcp__" + name + "__").length)).join(", ")) : null);
    }

    function ServerForm({ initial, t, busy, error, onSave, onCancel }) {
      const isEdit = initial && initial.name !== null;
      const [name, setName] = react.useState(initial ? (initial.name ?? "") : "");
      const [transport, setTransport] = react.useState(initial && initial.spec ? initial.spec.transport : "stdio");
      const [command, setCommand] = react.useState(initial && initial.spec ? (initial.spec.command || "") : "");
      const [argsText, setArgsText] = react.useState(initial && initial.spec ? (initial.spec.args || []).join("\n") : "");
      const [envText, setEnvText] = react.useState(initial && initial.spec ? toLines(initial.spec.env) : "");
      const [cwd, setCwd] = react.useState(initial && initial.spec ? (initial.spec.cwd || "") : "");
      const [url, setUrl] = react.useState(initial && initial.spec ? (initial.spec.url || "") : "");
      const [headersText, setHeadersText] = react.useState(initial && initial.spec ? toHeaderLines(initial.spec.headers) : "");
      const [timeout, setTimeoutMs] = react.useState(initial && initial.spec && initial.spec.toolCallTimeoutMs !== undefined ? String(initial.spec.toolCallTimeoutMs) : "60000");
      const [enabled, setEnabled] = react.useState(initial && initial.spec ? initial.spec.enabled !== false : true);
      const [validation, setValidation] = react.useState(null);

      const submit = () => {
        const trimmed = name.trim();
        if (!NAME_RE.test(trimmed)) { setValidation(t("nameInvalid")); return; }
        const spec = { enabled, toolCallTimeoutMs: Number(timeout) || 60000 };
        if (transport === "stdio") {
          if (!command.trim()) { setValidation(t("commandRequired")); return; }
          spec.transport = "stdio";
          spec.command = command.trim();
          spec.args = argsText.split(/\n/).map((s) => s.trim()).filter(Boolean);
          spec.env = parseKeyValues(envText);
          spec.cwd = cwd.trim();
        } else {
          if (!url.trim()) { setValidation(t("urlRequired")); return; }
          spec.transport = "streamable-http";
          spec.url = url.trim();
          spec.headers = parseHeaders(headersText);
        }
        onSave(trimmed, spec);
      };

      const field = (label, hint, control) => h("div", { className: "mcp-field" },
        h("label", null, label),
        control,
        hint ? h("span", { className: "mcp-field-hint" }, hint) : null);

      return h("form", {
        className: "mcp-form",
        onSubmit: (e) => { e.preventDefault(); submit(); },
      },
        h("div", { className: "mcp-head" }, h("h3", null, isEdit ? t("formTitleEdit") : t("formTitleAdd"))),
        field(t("serverName"), t("serverNameHint"),
          h("input", { value: name, disabled: isEdit, placeholder: "filesystem", onChange: (e) => setName(e.target.value) })),
        field(t("transport"), null,
          h("select", { value: transport, onChange: (e) => setTransport(e.target.value) },
            h("option", { value: "stdio" }, t("transportStdio")),
            h("option", { value: "streamable-http" }, t("transportHttp")))),
        transport === "stdio" ? [
          field(t("command"), t("commandHint"), h("input", { value: command, placeholder: "npx", onChange: (e) => setCommand(e.target.value) })),
          field(t("args"), null, h("textarea", { value: argsText, placeholder: "-y\n@modelcontextprotocol/server-filesystem\n/workspace", onChange: (e) => setArgsText(e.target.value) })),
          field(t("env"), null, h("textarea", { value: envText, placeholder: "API_KEY=sk-…", onChange: (e) => setEnvText(e.target.value) })),
          field(t("cwd"), null, h("input", { value: cwd, placeholder: "/path/to/dir", onChange: (e) => setCwd(e.target.value) })),
        ] : [
          field(t("url"), null, h("input", { value: url, placeholder: "https://example.com/mcp", onChange: (e) => setUrl(e.target.value) })),
          field(t("headers"), null, h("textarea", { value: headersText, placeholder: "Authorization: Bearer <token>", onChange: (e) => setHeadersText(e.target.value) })),
        ],
        field(t("timeout"), null, h("input", { type: "number", min: 1000, value: timeout, onChange: (e) => setTimeoutMs(e.target.value) })),
        h("div", { className: "mcp-field" },
          h("label", { style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" } },
            h(Switch, { checked: enabled, label: t("enabled"), onChange: setEnabled }),
            h("span", null, t("enabled")))),
        validation ? h("div", { className: "mcp-error" }, validation) : null,
        error ? h("div", { className: "mcp-error" }, error) : null,
        h("div", { className: "mcp-form-actions" },
          h("button", { type: "button", className: "mcp-cancel", onClick: onCancel }, t("cancel")),
          h("button", { type: "submit", className: "mcp-save", disabled: busy }, busy ? t("saving") : t("save"))));
    }

    function McpSection(props) {
      const { controller, useSnapshot, t, useSessionsList, remote } = props;
      const snapshot = useSnapshot((s) => s);
      const sessions = typeof useSessionsList === "function" ? useSessionsList((s) => s) : undefined;
      const sessionId = (sessions && (sessions.current ?? (Array.isArray(sessions.ids) && sessions.ids.length > 0 ? sessions.ids[0] : undefined))) || undefined;

      const [editing, setEditing] = react.useState(null); // null | { name: string|null, spec?: object }
      const [busy, setBusy] = react.useState(false);
      const [formError, setFormError] = react.useState(null);
      const [runtime, setRuntime] = react.useState(null); // parsed /mcp-status payload
      const [statusError, setStatusError] = react.useState(false);

      react.useEffect(() => { controller.load(); }, [controller]);

      /* runtime status polling while the page is mounted */
      react.useEffect(() => {
        if (!sessionId) { setRuntime(null); return; }
        let alive = true;
        let timer = 0;
        const tick = async () => {
          if (!alive) return;
          try {
            const payload = await controller.fetchStatus(sessionId);
            if (alive) { setRuntime(payload); setStatusError(false); }
          } catch (error) {
            if (alive) setStatusError(true);
          }
          if (alive) timer = window.setTimeout(tick, POLL_INTERVAL_MS);
        };
        tick();
        return () => { alive = false; window.clearTimeout(timer); };
      }, [controller, sessionId]);

      const servers = snapshot.servers || {};
      const names = Object.keys(servers).sort();

      const onToggle = async (name) => {
        const spec = servers[name];
        if (!spec) return;
        setFormError(null);
        try {
          await controller.saveServer(name, { ...spec, enabled: spec.enabled !== true });
        } catch (error) {
          setFormError(error && error.conflict ? t("conflict") : (t("saveFailed") + ": " + (error && error.message ? error.message : error)));
        }
      };
      const onDelete = async (name) => {
        if (!window.confirm(t("confirmDelete") + "\n" + name)) return;
        setFormError(null);
        try {
          await controller.deleteServer(name);
        } catch (error) {
          setFormError(error && error.conflict ? t("conflict") : (t("saveFailed") + ": " + (error && error.message ? error.message : error)));
        }
      };
      const onSave = async (name, spec) => {
        setBusy(true);
        setFormError(null);
        try {
          await controller.saveServer(name, spec);
          setEditing(null);
        } catch (error) {
          setFormError(error && error.conflict ? t("conflict") : (t("saveFailed") + ": " + (error && error.message ? error.message : error)));
        } finally {
          setBusy(false);
        }
      };

      return h("div", { className: "mcp-page" },
        h("div", { className: "mcp-head" },
          h("h3", null, t("title")),
          h("p", null, t("subtitle"))),
        h("div", { className: "mcp-toolbar" },
          h("button", { type: "button", className: "mcp-add", disabled: editing !== null, onClick: () => { setFormError(null); setEditing({ name: null }); } }, "+ " + t("add"))),
        snapshot.status === "error" ? h("div", { className: "mcp-error" },
          t("loadFailed") + ": " + (snapshot.error || ""),
          h("button", { type: "button", className: "mcp-btn", style: { marginLeft: 8 }, onClick: () => controller.load() }, t("retry"))) : null,
        formError ? h("div", { className: "mcp-error" }, formError) : null,
        statusError && names.length > 0 ? h("div", { className: "mcp-error" }, t("stateUnknown")) : null,
        names.length === 0 && editing === null ? h("div", { className: "mcp-empty" }, t("empty")) : null,
        names.length > 0 ? h("ul", { className: "mcp-list" },
          names.map((name) => h(ServerCard, {
            key: name,
            name,
            spec: servers[name],
            runtimeEntry: statusViewOf(runtime, name),
            t,
            onEdit: () => { setFormError(null); setEditing({ name, spec: servers[name] }); },
            onDelete: () => onDelete(name),
            onToggle: (next) => onToggle(name),
          }))) : null,
        editing !== null ? h(ServerForm, {
          initial: editing,
          t,
          busy,
          error: formError,
          onSave,
          onCancel: () => setEditing(null),
        }) : null);
    }

    /* ------------------------------------------------------------ */
    /* plugin entry                                                  */
    /* ------------------------------------------------------------ */

    const inject = ["slots", "locale", "connection", "remote"];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-mcp-manager: copy dictionaries");
      const connection = ctx.get("connection");
      const controller = new McpController(connection.api, ctx.get("remote"));
      const useSnapshot = bindSnapshotSelector(controller.store);
      const sessionsService = ctx.get("sessions");
      const useSessionsList = sessionsService && sessionsService.list
        ? bindSnapshotSelector(sessionsService.list)
        : () => undefined;
      const t = ctx.locale.bind(NS);
      const injected = () => ({ controller, useSnapshot, api: connection.api, t, remote: ctx.get("remote"), useSessionsList });

      ctx.effect(() => {
        const refresh = () => { controller.load(); };
        const disposers = [
          ctx.get("remote").$on("settings/document-updated", (ns) => {
            if (ns === "mcp-servers") refresh();
          }),
          ctx.on("connection/reset", refresh),
        ];
        return () => { for (const dispose of disposers) dispose(); };
      }, "dsh-mcp-manager: pushed invalidations");

      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "mcp-servers",
        order: 20,
        label: () => t("nav"),
        inject: injected,
      }, McpSection));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});