# Agent Skills 管理设计

## 目标

每个 Agent 只加载明确启用的 Skills，避免继承主机上的全部 Skills 和插件配置。第一版复用主机已安装内容，不提供在线安装、上传或文本编辑。

## Skill 来源与存储

- 扫描 `~/.codex/skills`、`~/.agents/skills`、`~/.claude/skills`。
- 扫描 `~/.codex/plugins/cache` 内插件提供的 `SKILL.md`。
- 读取 `SKILL.md` 头部的 `name` 和 `description`，同名 Skill 按上述顺序保留第一个。
- API 只接收服务端生成的 Skill ID，不接收文件路径。
- 启用后把完整 Skill 目录复制到 `data/agents/<agent-id>/skills/<skill-id>`；停用时删除运行副本。
- 上传接受不超过 10 MB 的单 Skill ZIP。服务端限制解压文件数和总大小，拒绝绝对路径、路径穿越、无 `SKILL.md` 或多个 Skill；上传源保存在 `data/agents/<agent-id>/skill-library`，因此停用后仍可重新启用。
- 下一次 Run 由 `SkillProjector` 把每个已启用 Skill 直接投影到 Provider 的 skills 根目录；使用 `_remote-agent-managed-` 前缀区分托管项，不修改项目环境自带 Skills，也不修改正在执行的 Run。

## Provider 隔离

- Codex 使用 `data/agents/<id>/provider-home/codex` 作为 `CODEX_HOME`。
- Claude Code 使用 `data/agents/<id>/provider-home/claude` 作为 `CLAUDE_CONFIG_DIR`。
- Hermes 沿用 `data/agents/<id>/provider-home/hermes` 作为 `HERMES_HOME`。
- Codex、Claude Code 和 Hermes 统一从运行服务的系统用户 Provider Home 复制静态内容，包括配置、认证、模型、插件和 Skills。
- 复制时排除 Session 历史、缓存、日志、锁文件、临时目录和运行状态数据库。
- Codex 复制完成后仅覆盖 Remote Agent Server 管理的 `developer_instructions` 和 Skills 配置，保留其他 Provider 与模型配置。
- 已有 Provider Session 的下一次 Run 会先关闭进程 Handle，再以原 `provider_session_id` 恢复 ACP Session；这样重新扫描 Skills，同时保留多轮对话上下文。

## API 与界面

- `GET /api/agents/:id/skills`：返回可选 Skills 及当前启用状态。
- `PUT /api/agents/:id/skills/:skillId`：请求体 `{ "enabled": true|false }`。
- Agent 卡片增加“Skills”入口，展开后按复选框启停。
- Skills 面板支持上传 ZIP，上传成功后立即为当前 Agent 启用。
- 插件第一版只管理其贡献的 Skills，不管理 MCP、App 或其他插件能力。

## 不做的内容

- 不新增数据库表或 `config_json`。
- 不在线安装、编辑或升级 Skill。
- 不处理同名 Skill 的多版本切换。
- 不动态改变正在运行的 Agent Turn。
