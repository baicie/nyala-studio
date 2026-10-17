# Native-only vNext Release Track

状态：已定义，等待 A4 Checkpoint W 证据

Native-only 是 Zeus Z1/Z2 延期时的独立发布路径。它不把 Zeus 的 `NO-GO` 改成
`GO`，也不把整体 vNext DoD 标记为完成；它只允许产品先发布已经完成的 SQL Agent
和 native Result Grid 能力。

## 准入条件

- A4 Checkpoint W 在发布 revision 上为结构化 `GO`。
- macOS/Windows 原生 Workbench、键盘和屏幕阅读器走查均有受保护 attestation。
- native Result renderer 继续作为默认 renderer，并保留现有 SQL Result contract。
- `@zeus-web/data-grid` 不进入 production dependency。
- `test:sql-agent`、`test:sql-result` 和 Checkpoint W contract tests 纳入默认测试链。
- native-only verifier 输出 `GO`，并绑定同一个 source revision。

## Zeus 处理

Z1 的性能和双 WebView 证据继续作为诊断/历史记录保存。`phase-z1-gate.json` 保持
`NO-GO`，Z2 不开始。未来重新引入 Zeus 时，必须重新完成 Z1 Go、Z2 Preview contract、
双平台 QA 和独立 production decision。

## 验证命令

```bash
pnpm run test:sql-native-release
pnpm run verify:sql-native-release
```

在 Checkpoint W 尚未完成时，第二条命令应返回 exit 1，并写出结构化
`docs/sql-mvp-phases/phase-native-release-gate.json`。这表示发布条件未满足，不是绕过
A4 证据。
