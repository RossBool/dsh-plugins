// 旧版客户端入口：已被 prompt-enhancer-ui 取代，空操作占位（避免与新版按钮重复注册）。
window.__ModuleLoader__.load({
	id: "prompt-enhancer",
	factory: (require) => {
		var module = { exports: {} };
		module.exports.apply = function() {};
		module.exports.inject = [];
		return module.exports;
	},
});
