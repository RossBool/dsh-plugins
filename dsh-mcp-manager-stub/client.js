/** 占位客户端：无操作（真正页面由 dsh-mcp-manager-ui 提供）。 */
window.__ModuleLoader__.load({
  id: "dsh-mcp-manager",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    exports.apply = () => {};
    exports.inject = [];
    return module.exports;
  },
});
