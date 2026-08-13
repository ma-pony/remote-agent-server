# Agent Skills 实施计划

## 范围

在现有 Agent 管理中加入主机 Skill 目录扫描、每 Agent 启停、运行时投影和 Provider 配置隔离。

## 实施步骤

- [ ] 先写失败测试，覆盖目录扫描、同名去重、启用复制、停用删除、非法 Skill ID 和鉴权 API。
- [ ] 实现 `SkillManager`，只允许通过已扫描的 ID 选择目录。
- [ ] 将 Skills 路由接入现有 Agent API。
- [ ] 支持安全上传单 Skill ZIP，保留每 Agent 上传源并自动启用。
- [ ] 先写失败测试，再为 Codex、Claude Code、Hermes 设置独立 Provider Home，并复用 Codex 登录文件。
- [ ] 先写失败测试，再在 Agent 页面加入 Skills 展开区和复选框。
- [ ] 运行聚焦测试、全量测试、类型检查、构建和语法检查。
- [ ] 提交后重启本地 3100 服务，验证 Agent 页面入口与 Provider 运行检查。
