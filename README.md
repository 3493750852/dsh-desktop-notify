# dsh-desktop-notify

给 DSH 加一条 Windows 系统通知：**需要你确认**、**你已经回答**、**任务结束**的时候各弹一条，切到别的窗口也不会漏。

只装宿主端（Host-only），没有前端界面，不联网，不带依赖。仅支持 Windows。

## 安装

1. 把仓库放到本机任意目录：

   ```powershell
   git clone https://github.com/3493750852/dsh-desktop-notify.git
   ```

2. 把这个目录装进 DSH 的 profile：在 DSH 会话里让 agent 用 `plugin_manager` 的 `install_bundle` 安装它，`target` 填这个目录的绝对路径。装好即生效，配置行会写进 profile 的 `cordis.patch.yml`。

3. 验证：随便发一条消息，本轮结束时应该收到「任务完成」通知；点它应该回到 DSH 窗口。

## 三个触发点分别是什么

| 你看到的通知 | 触发时机 | 事件来源 |
| --- | --- | --- |
| 需要你确认 | 有工具在申请授权，真的开始等你点 | `approval/request` |
| 需要你回答 | 模型问了 `ask_user_question`，等你选 | `user-questions/request` |
| 你已回答 | 你点了允许/拒绝，或选完了选项 | 上面两个请求返回时 |
| 任务完成 / 任务出错 | 本轮结束，且这一轮超过 `taskEndMinSeconds` | `session/event` 的 `turn/end` + `agent/error` |

几条避免打扰的规则：

- **自动应答不提醒**：请求在 `interactionDelayMs`（默认 1.2 秒）内就被宿主自动处理（比如策略是 `never` 直接拒绝），说明根本没人被问到，不弹通知。
- **秒回不提醒**：一轮任务短于 `taskEndMinSeconds`（默认 8 秒）就不提示任务结束。
- **子智能体不提醒**：子会话自己的回合不弹，避免一次任务刷出一串通知。
- **等待回答时不当作任务结束**：有请求挂着的时候，即使这一轮结束了也不弹「任务完成」。
- **装插件时正在进行的那一轮**：结束时照样提示，只是没有「用时」（插件没看到这一轮的开始）。

## 通知长什么样

Windows 10/11 上它是一条标准通知（托盘气泡，系统会渲染进通知中心），带 **DSH 自己的图标**、标题、正文和系统提示音：

- 需要你确认：`需要你确认` / `Bash：执行命令 npm install`
- 需要你回答：`需要你回答` / `你希望用哪种方案？`
- 你已回答：`你已回答` / `Bash → 允许`
- 任务完成：`任务完成` / `帮我做一个 dsh 插件 · 用时 2 分 13 秒`
- 任务出错：`任务出错` / `... · <错误信息>`

图标不是内置的通用图标，而是**从正在运行的 DSH 应用上取的**（`DeepSeek Harness.exe` 自己带的图标），所以跟任务栏里那个是同一个。

## 点一下通知

点通知会把 **DSH 窗口叫到前台**（最小化了也会还原）。

实现上不是硬抢焦点：桌面壳持有单实例锁，再启动一次应用就会走到它自己的「聚焦或重建主窗口」那条路，所以用的是应用认可的入口，不会被 Windows 的前台锁拦掉。

- 通知在屏幕上（以及进通知中心后的约 8 秒内）点它有效 —— 之后负责接点击的进程已经退出，点了不会有反应。
- 如果你用的是浏览器里的 Web GUI 而没有桌面应用，会退化成用浏览器打开那个 GUI 地址。
- 想换成「一律用浏览器打开」或「点了只关掉」，改 `clickAction` 为 `url` / `none`。

> DSH 的 Web UI 没有「会话级 URL」（前端不读地址栏），所以点击只能把窗口叫到前台，不能直接跳到某个后台会话；通知正文里带了会话标题，方便你对上号。

## 开关

全部开关都在 `cordis.patch.yml` 里那一行的 `config` 下（也可以在 DSH 的配置文件里改同样的键），改完重启 DSH 生效：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `confirm` | `true` | 需要你确认 / 回答时提示 |
| `answered` | `true` | 你回答之后提示 |
| `taskEnd` | `true` | 任务结束时提示 |
| `taskError` | `true` | 报错结束时也提示（文案变「任务出错」） |
| `sound` | `true` | 播放系统提示音 |
| `language` | `zh` | 通知文案语言，`zh` 或 `en` |
| `showSessionTitle` | `true` | 任务结束通知里带会话标题 |
| `taskEndMinSeconds` | `8` | 短于这个秒数的任务不提示结束 |
| `interactionDelayMs` | `1200` | 请求挂起超过这个毫秒数才算「真的在等你」 |
| `hideWhenSubagent` | `true` | 子智能体结束不提示 |
| `powershellPath` | `powershell.exe` | 想用 PowerShell 7 可以填 `pwsh.exe` |
| `maxConcurrent` | `3` | 同时最多几条通知进程 |
| `coalesceMs` | `700` | 同类通知的去重窗口 |
| `clickAction` | `focus` | 点通知时：`focus` 叫回 DSH 窗口 / `url` 用浏览器打开 / `none` 只关掉 |
| `appProcessName` | `DeepSeek Harness` | 桌面进程名，用来取它自己的图标、点击时叫回窗口 |
| `dwellSeconds` | `8` | 通知可点击（托盘图标存在）的秒数 |

## 收不到通知时

1. **Windows 通知总开关**：设置 → 系统 → 通知，确认「通知」是开的。
2. **专注助手 / 勿扰**：开着的时候通知会进通知中心但不弹横幅，不会响。
3. **通知中心里有没有**：按 `Win + N` 看历史。有记录但没弹出来，基本就是专注助手。
4. **手动测一次**（在插件目录里，会立刻弹一条测试通知；点它应该把 DSH 叫到前台）：

   ```powershell
   $json = '{"title":"测试通知","body":"点我应该会回到 DSH 窗口","kind":"done","sound":true,"onClick":"focus","appProcessName":"DeepSeek Harness","dwellMs":20000}'
   $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
   powershell -NoProfile -ExecutionPolicy Bypass -File .\notify.ps1 -PayloadBase64 $b64
   ```

   退出码 `0` 表示通知已正常走完；`2` 是载荷解析失败；`3` 是系统拒绝创建通知。

## 实现说明

- 通知走一个独立的、隐藏窗口的 PowerShell 进程（`notify.ps1`）：显示托盘气泡、跑一个短消息循环接点击，最多 `dwellSeconds` 秒后自行退出；宿主进程不阻塞、不等待。
- 文案以 **base64 编码的 UTF-8 JSON** 传给 PowerShell，不经过命令行转义，中文不会被代码页破坏。
- 图标和点击目标都在脚本里从**运行中的应用**解析（`Get-Process 'DeepSeek Harness'` → 它的路径与图标），不写死安装路径。
- 三个观察点都是普通 waterfall 事件监听：只 `await next()` 并把结果原样返回，不改变任何决策。
