# Workspace 沙箱调研与 POC 记录

日期：2026-11-09。状态：**暂缓，未进入正式实现。**

用户在调研和对照验证后明确决定：“先记录下来，沙箱这个功能可以先不做。”本文归档需求、候选方案和历史验证结论，供以后重新评估；沙箱功能不作为当前待推进事项。

当前实现仍以[产品与架构](../../design.md)为准。本文讨论的独立 Workspace 实体、Docker 执行环境及多 Session 共享目录均属于未来方案，尚未接入正式代码，也不改变现有 Session 所有权、APFS／Btrfs 工作区和清理规则。

## 已明确的目标

- 产品体验参考 Neutree Agent Platform：持久工作区、对话、文件和交互终端，后续按需增加浏览器和其他触发入口。
- 首版目标环境为 Linux 单机、Docker，使用者为本人或可信小团队。
- 避免 Kubernetes 的部署和运维复杂性。
- 调研中的目标模型是一个 Workspace 对应一个持久环境，包含多个独立上下文的 Session；共享文件时，需要统一的执行和写入规则。

Neutree 的 Workspace／Session 语义见[官方对象说明](https://github.com/neutree-ai/agent-platform/blob/9d1285b4e6d2251fe495b218216812a228292fc4/docs-site/src/content/docs/zh-cn/concepts/agent-and-workspace.md)。此处记录的是产品方向，不是已批准执行的迁移方案。

## 候选方案与调研判断

以下为 2026-11-09 的资料核查结果。后续恢复选型时需复核版本、许可证、维护状态和自托管条件。

| 候选 | 核查到的能力与边界 | 本轮判断 |
| --- | --- | --- |
| OpenSandbox Docker 后端 | 单机运行；公开的生命周期、命令、文件、PTY、named volume 实现 | 优先候选；尚未作最终采用决定 |
| AIO Sandbox／aiod | 文件、终端、浏览器、VNC 等工具能力贴近工作台，生命周期由外部平台管理 | 可作工具和体验对照；公开仓库中未找到完整服务端源码及基础镜像 Dockerfile，需核实自主维护条件 |
| BoxLite | 本地库、CLI、REST、PTY、持久磁盘，支持 OCI 镜像；Linux 需要 KVM | microVM 备选 |
| Microsandbox | OCI 镜像、命名实例、卷、长期运行、快照；Linux 需要 KVM，官方标为 beta | 跟踪候选 |
| E2B Embed | 已有单机 Docker Compose 自托管方案；内部运行 Firecracker，并需 KVM、宿主设置和多个服务 | 满足不用 Kubernetes，运行面仍较大 |
| Docker Sandboxes | 独立 sbx CLI；Linux 本地使用 microVM，需要 KVM 和 Docker 登录 | CLI 产品参考；专有许可及后台编排方式需另行评估 |
| OpenHands Agent Server | DockerWorkspace、远程工具和会话接口 | 与自身 Agent／Conversation 协议结合较深，复用范围需评估 |
| Daytona 原公开核心 | 官方声明 2026 年 6 月起核心开发移入私有代码，原公开仓库停止维护 | 不作为新开源依赖首选；该声明不代表全部 SDK 仓库闭源 |
| Kubernetes SIG Agent Sandbox | Kubernetes CRD／Controller | 不符合当前部署条件 |

一手资料：[OpenSandbox Docker 部署](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.0/server/docker-compose.example.yaml)、[named volume](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.0/docs/examples/docker-pvc-volume-mount.md)、[PTY 协议](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.0/components/execd/PTY.md)；[aiod 职责](https://sandbox.agent-infra.com/daemon/start/introduction)、[AIO 公开仓库](https://github.com/agent-infra/sandbox/tree/7f1afaf8d82bd30531a19caeb1a24dfebbc97d8c)；[BoxLite](https://github.com/boxlite-ai/boxlite/blob/3112c92c1b2bf49944e99e82b6f025de4a2cc457/README.md)；[Microsandbox](https://github.com/superradcompany/microsandbox/blob/7bad52a06da61d748f3db14e69cbe8429907abf6/README.md)；[E2B Embed](https://github.com/e2b-dev/runtime/blob/8e45d7f839c28fb91a0c222f3a4293eb203ec9df/embed/README.md)；[Docker Sandboxes 安装](https://docs.docker.com/ai/sandboxes/install/)、[发布仓库与许可](https://github.com/docker/sbx-releases)；[OpenHands SDK](https://github.com/OpenHands/software-agent-sdk)；[Daytona 官方声明](https://github.com/daytonaio/daytona/blob/main/README.md)；[Kubernetes Agent Sandbox](https://github.com/kubernetes-sigs/agent-sandbox)。

## 对照 POC 的实际范围

2026-11-09 使用独立测试环境比较了直接 Docker 和 OpenSandbox Docker 后端，没有修改 RAS 正式代码。

- 开发宿主为 macOS ARM64，执行环境为 Docker Desktop 的 Linux ARM64 引擎；不是原生 Linux 目标服务器验收。
- Docker Engine 29.7.2、Docker Desktop 4.89.0；OpenSandbox server 和 execd 均为发布镜像 `release-1.2.0`。
- 两侧使用同一 Node 22 Debian 镜像，以 UID 1000 运行，均限制为 1 CPU、512 MiB。此次不据此作容量或性能排名。
- 容器内 acpx 使用 RAS 当前带补丁的 0.16.0 构建。
- ACP 对端为确定性测试代理，未读取真实 Provider 凭据或调用模型。

最终干净运行记录为 **25 项观察：20 项通过、4 项底层清理限制、1 项可选隔离能力不可用**。限制项没有计入通过项。

| 验证项 | 结果 |
| --- | --- |
| 非 root 执行、共享工作目录和文件读取 | 两种后端均通过，OpenSandbox 文件 upload／download 与容器内读取一致 |
| 非 TTY ACP 双向通信、42,000 字节 Unicode 内容、独立 stderr | 两种后端均通过 |
| 交互终端、37×101 尺寸调整、Ctrl-C | 两种后端均通过 |
| 终端断线重连、回放并继续输入 | OpenSandbox 通过；直接 Docker CLI 仍需补连接和缓冲管理 |
| 删除容器并以原卷重建 | 两种后端均保留文件，并能加载测试会话进行第二轮 |
| OpenSandbox 控制面重启 | 原 sandbox 可查询，仍可执行命令 |
| pause 后释放内存 | 两种后端均未释放；pause 是冻结执行，不是落盘休眠 |
| 仅终止 docker exec 客户端 | 普通与 detached 场景都遗留容器内运行进程，共 2 项限制 |
| execd 普通命令取消与超时 | 普通进程树已停止，detached 后代仍存活，共 2 项限制 |
| 容器内现有 acpx 完成／取消后 shutdown | 两种后端均完整回收测试 Agent 与 detached 后代，进程已退出并被回收，无僵尸残留 |
| 可选 bubblewrap 会话隔离 | 当前非 root、安全配置下无法建立所需 namespace，未自动放宽宿主或容器权限 |

## 保留的设计判断

若以后恢复开发，本轮证据支持如下分工：RAS 管理产品对象与调度；OpenSandbox 提供执行环境、卷、文件和 Web 终端；工作区容器内的轻量执行进程复用现有 ACP／acpx 及进程树管理能力。

这仍是候选方案。完整 Agent CLI 及其 stdio MCP、工具子进程需要在工作区内执行；仅把沙箱工具通过 MCP 接给宿主 CLI，不能建立相同的执行范围。单纯杀掉 Docker 客户端或取消普通 execd 命令也不足以替代 Run 的进程所有权。

停止环境、重置 Provider 上下文、删除数据应分别定义。需要释放内存时，不能仅使用 Docker pause；卷持久化与真实 Provider 会话恢复也应分别验证。旧环境完全终止后，再把同一持久卷交给替代环境。

PTY 收尾曾观察到约 10 秒和重建后约 0.04 秒的差异，原因未定位；不据此概括平台性能。后续不应默认每个 Run 都需要新建和删除一个 Web PTY。

## 尚未完成的验证

- 原生 Linux 目标服务器与 amd64 平台。
- 真实 Codex／Claude 登录、模型调用和原生会话恢复。
- 真实 MCP、浏览器及更多工具进程场景。
- 执行进程被强制终止、宿主断电、磁盘满、长期并发等恢复与容量验证。
- 正式 Workspace 模型、迁移、管理 API、UI 和保留策略集成。

POC 中的测试会话恢复不等同于真实 Provider 已通过验收。

## 产物与状态

本次复现包名为 `ras-sandbox-poc-20261109.zip`，SHA-256 为 `e6c0aaa45030dd3a8c4d18fb8beb46a3b2c8215bc51774ed557086cf4427a149`。会话另行保存该包，仓库只记录归纳结论，不引入复现代码、依赖、凭据或运行载荷。

测试容器、数据卷和临时密钥已经清理。用户要求暂缓后，本次只归档记录；没有新增正式运行方式、实施排期、后台任务或持续验证任务。
