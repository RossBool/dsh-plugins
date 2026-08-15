# prompt-enhancer-ui — 提示词增强 Web UI

在 DSH Web GUI 的输入框工具栏提供「增强提示词」按钮，配合 `prompt-enhancer`（Host）使用。

## 功能简介

- 输入框工具栏新增 Notion AI 风格 ✨ 图标按钮：点击调用 Host 的 `enhance_prompt` 工具，完成后增强文本直接填入草稿。
- 内置纯函数状态机（`enhance-machine`，`idle → enhancing → enhanced → idle`），保证内容不变量与生命周期不变量。

## 能力

| 能力 | 说明 |
| --- | --- |
| 一键增强 | 点击 ✨ → loading（可取消）→ 增强结果填入草稿 |
| 恢复原文 | 增强完成后按钮变「恢复」，一键回撤原文 |
| 内容不变量 | 增强期间你手动编辑草稿 → 结果自动丢弃，绝不覆盖你的编辑 |
| 会话隔离 | 切换会话自动取消进行中的增强 |
| 错误可视化 | 失败时图标变红，悬浮查看原因（按错误码本地化） |

## 使用方式

1. 与 `prompt-enhancer`（Host）一起挂载（见其 README）。
2. 在输入框工具栏点击 ✨ 按钮即可增强草稿；也可用 `/enhance <提示词>` 斜杠命令。
3. 客户端源码 `client.js` 修改后刷新浏览器页面即生效。

状态机逻辑零依赖、可单测（`node --test`）；客户端 bundle 由 `build.mjs` 从 `machine.js` 生成。
