# 问山

以《周易》为基础的解读网站：选一件正在关心的事，免费三币起卦、读懂本卦动爻与原文，再决定是否购买结合处境的报告。

- 产品需求：PRD V0.2（不在仓库内）
- 技术方案：[docs/technical-design.md](docs/technical-design.md)

## 当前进度

| 阶段 | 状态 |
|---|---|
| 免费闭环：写问题 → 三币起卦 → 卦象、原文、白话简读、反思问题 | 已实现，可本地运行 |
| 典籍：64 卦卦辞、384 爻辞、用九用六、彖传、象传 | 已从维基文库导入，**待人工对勘** |
| 白话注释 | 仅乾、坤、姤三卦有初稿（23/450），其余待撰写 |
| 主题配置、分流词表、求助资源 | 初稿，**待审校**；求助号码上线前须逐条核实 |
| 付费闭环：登录、分流、Stripe、报告生成、追问 | 未开始 |

## 目录

```
apps/web/              Next.js 网站（App Router）
packages/iching-core/  起卦、卦表、选文规则（纯函数，前后端共用）
packages/content/      典籍、白话注释、主题配置、分流词表、样例（YAML）+ 导入、校验与构建脚本
docs/                  技术方案
```

## 本地开发

需要 Node.js 20.9 以上。

```bash
npm install
npm run dev          # http://localhost:3000
```

```bash
npm test             # 单元测试（含 4,096 种爻值组合的遍历）
npm run typecheck
npm run build
```

## 内容工作流

内容以 YAML 存在 `packages/content/` 下，构建后生成 `packages/content/generated/*.json` 供网站使用（生成文件需提交）。

```bash
npm run content:build             # 校验并重新生成 generated/
npm run content:check             # CI 用：校验，并确认 generated/ 与源文件一致
npm run content:build -- --strict # 上线标准：原文、白话、主题、求助资源都须已审核
npm run content:import            # 重新从维基文库导入原文（会覆盖 corpus/*.yaml）
```

- `corpus/NN.yaml`：原文，导入后 `reviewStatus: imported`，人工对勘后改为 `reviewed`。
- `annotations/NN.yaml`：白话注释与观察角度，只能自写或获授权；审核后改为 `reviewed`。
- `topics/*.yaml`：五个主题的入口文案、背景字段、按观察角度的提示与反思问题、报告要求。
- `triage.yaml`、`help.yaml`：免费阶段的本地分流词表与求助资源。
