# RTK 托管工具

[English](rtk.en.md)

RTK 在命令执行阶段压缩交给模型的终端输出。服务使用 Apache-2.0 的
`rtk-oss` 二进制，不安装 RTK Proxy，不修改模型 API 路由。压缩率属于命令输出
指标；实际模型 Token 用量继续使用现有用量统计。

## 安装与操作

`pnpm run init` 默认安装推荐版本（当前为 `1.1.0`），并默认开启自动压缩。
已有安装保持所选版本和启停状态。失败不阻止基础环境初始化，终端会报告原因；
Run 使用原始命令输出。`pnpm run doctor` 只检查本地安装状态，不下载或升级。
重新执行初始化会自检当前版本，并在二进制缺失、不可执行或损坏时重新安装该版本。

进入 **系统设置 → 运行与并发 → RTK 命令输出压缩**，可以启停、检查更新、
安装、更新以及确认回退。关闭自动压缩保留二进制，仍可手动调用 `rtk`。
启停、更新和回退均作用于后来开始执行的 Run；已经排队的 Run 在启动时解析最新配置。
正在运行的任务不会被中断，刷新 Runtime Handle 时继续恢复同一个 Provider Session。

服务启动后异步检查官方最新稳定版本，之后每 24 小时检测；启动检测失败后按小时
重试。成功结果持久化，失败保留上次成功检测时间和版本，并显示错误。只检查新版，
由管理员手动更新。关闭自动压缩不关闭版本检测。初始化之外的 Run 启动不下载工具。

Claude Code 和 Codex 使用托管 `PreToolUse` Hook，Hermes 使用托管
`pre_tool_call` 插件，DeepSeek Harness 当前不自动接入。该能力仅覆盖执行器
允许改写的终端命令，内建 Read/Grep 等工具并不因此自动压缩。实际部署应单独验证
所安装 CLI/ACP 版本确实触发 Hook；投影文件存在不等于实际接管成功。

投影时由托管入口接管已选择的独立原生 `rtk hook`，Hermes 则替换已启用的
`rtk-rewrite` 插件，避免重复改写和绕过系统开关。宿主配置、保存的扩展选择及其他
Hook 保持原样；包含其他命令的自定义 Hook 仍由其自身配置负责。

## 版本发布与恢复

状态保存在 `DATA_DIR/tools/rtk/state.json`，权限为 `0600`，包含启停、激活版本、
上一版本以及检测结果。它与二进制由同一管理模块负责，使用临时文件加原子 rename
发布状态，不在 SQLite 复制另一份激活指针。Run 的配置快照单独持久化到 SQLite，
不包含本机二进制绝对路径。

二进制位于 `DATA_DIR/tools/rtk/versions/<version>/rtk`。更新只接受已检测的
稳定版本，首次安装接受推荐版本；请求明确绑定版本。服务从官方 GitHub Release
获取当前平台的 OSS 工件及 SHA-256，限制下载和解压大小，校验后只提取常规 `rtk`
文件，并执行版本及 rewrite 自检。候选版本先完整准备，再原子发布目录和切换指针。
健康的同版本二进制直接复用；不可用的二进制只在候选校验、自检通过后原子替换。
修复同版本保持启停和上一版本记录，失败保留原文件。回退先自检已保留的版本，再切换指针。

后台操作和初始化通过进程锁排他执行，服务关闭时取消下载、自检并等待资源释放。
失败及进程中断保留原激活版本；启动调度 Run 之前清理中断的 staging。
已发布但尚未激活的目录可在恢复时清理。运行期间保留已安装版本，以保护活动 Run
及空闲 Runtime Handle 的引用；下次服务启动时只保留当前版和上一版。

Hook 入口保持稳定，从当前 Runtime 的环境读取配置快照。改写后的命令使用该快照
绑定的二进制绝对路径；托管入口不会跟随变化中的全局链接。缺少工具、无匹配规则
或 Hook 预处理失败时执行原命令，不自动重跑已经执行的业务命令。权限拒绝仍保留。
绑定识别环境变量前缀、`cd`、复合命令和常见进程包装器中的可执行位置，保留参数、
引号与注释。无法安全解析的 shell 控制语法保持原命令。

RTK tracking、recall 和 tee 路径位于对应 Session 的 `runtime/rtk/`，随
Session 大文件清理；它们不进入公共集成事件。遥测和 Hook 审计被禁用。Provider 的
完整 HOME 保持原值，以保留 Git 和其他工具的凭据行为；RTK 仍可能读取服务用户已有
的只读过滤配置。

## 管理 API

全部使用管理 API Token。更新操作返回 `202`，轮询状态获取进度。

| 方法和路径 | 输入 | 行为 |
| --- | --- | --- |
| `GET /api/system-settings/rtk` | 无 | 设置、版本、成功检测时间、错误及后台操作状态 |
| `PUT /api/system-settings/rtk` | `{"enabled":true}` | 保存自动压缩开关 |
| `POST /api/system-settings/rtk/check` | `{}` | 检查最新稳定版，重复检测合并 |
| `POST /api/system-settings/rtk/update` | `{"version":"1.1.0"}` | 安装明确指定的候选版本 |
| `POST /api/system-settings/rtk/rollback` | `{"version":"1.0.0"}` | 回退到当前记录的上一版本 |

版本字段只接受三段稳定版本号。非法请求返回 `400 invalid_request`，操作冲突返回
`409 rtk_busy` 或 `409 rtk_version_conflict`。后台阶段包括 checking、downloading、
verifying、testing、activating、succeeded 和 failed；错误只返回受控代码。

备份完整 `DATA_DIR/tools/rtk/`，并按项目既有规则备份 SQLite 与 Session 目录。
不要在服务运行时手动删除版本目录。RTK 回退仅切换工具版本；服务代码及数据库的
升级回退仍遵循部署手册。
