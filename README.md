# 问山

以《周易》为基础的解读网站：选一件正在关心的事，免费三币起卦、读懂本卦动爻与原文，再决定是否购买结合处境的报告。

- 产品需求：PRD V0.2（不在仓库内）
- 技术方案：[docs/technical-design.md](docs/technical-design.md)

## 当前进度

| 阶段 | 状态 |
|---|---|
| 免费闭环：写问题 → 三币起卦 → 卦象、原文、白话简读、反思问题 | 已实现，可本地运行 |
| 典籍：64 卦卦辞、384 爻辞、用九用六、彖传、象传 | 已从维基文库导入，**待人工对勘** |
| 白话注释 | 450/450 条初稿，**待人工审校** |
| 主题配置、分流词表、求助资源 | 初稿，**待审校**；求助号码逐条标注审核状态，未核实的号码不在正式环境展示 |
| 付费闭环：邮箱验证码登录、付费前分流、订单与支付、报告生成与校验、三次追问、导出、删除、退款 | 已实现，本地用替身（模拟支付、模拟报告）可走通；**尚未接入真实的 Stripe、OpenAI、邮件服务验证** |
| 首发改造：题意冻结与订单快照、按订单撤回、交付与退款同一状态机、独立 worker、收款开关与审核门槛、工单、模型分工与成本、评测命令 | 已实现并通过本地验收（见技术方案附录 D）；**收款默认关闭**，内容审核未完成前真实收款会被拒绝 |
| 第二轮：下单确认绑定题意与报价、退款尝试记录与恢复、运营异常单、追问与删除的原子结算、任务认领令牌、模拟模式测试库隔离、按能力校验配置、发布验收、评测复用线上路径与追问盲测 | 已实现，替身与本机 PostgreSQL 并发测试通过（见技术方案附录 E）；**真实 Stripe、OpenAI、Resend 仍待验收** |
| 第四轮：免费页先给卦意（原文与卦图折叠）、付费报告改为简版（一句判断 → 下一步 → 为什么这样看，可复制的跟进消息），旧报告兼容，日期与概率的编造检查 | 已实现；面试案例改版前后与 Luna/Sol 的真实模型对比见 `docs/round4/`（技术方案附录 G），**人工评审待确认** |
| 第三轮：付款尝试持久化与幂等重放、报价绑定金额、按支付方资金流水结算退款与交付期限、退款身份与人工核实、通知认领与邮件幂等、删除后迟到写回的保护、发布验收三项结果、真实联调工具与证据记录 | 已实现，替身、契约测试与本机 PostgreSQL 并发及迁移兼容测试通过（见技术方案附录 F）；**真实 Stripe、OpenAI、Resend 联调工具已就绪，尚未运行** |

## 目录

```
apps/web/              Next.js 网站（App Router）
  server/              服务端：数据库、登录、分流、订单与支付、报告生成与校验、后台任务
  test/                服务端集成测试（内存数据库 + 替身服务）
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

收款默认关闭（`SALES_ENABLED=false`），仓库里的原文与注释也都还是待审状态，所以 `npm run dev` 只能走免费流程。要在本地走通付费流程，用独立的测试配置：

```bash
npm run dev:test     # 模拟模式：开放收款 + 允许未审核内容进入模拟支付；运营后台账号 ops@example.com
```

想用真实模型试一遍、但不经过真实支付：在 `apps/web/.env.local` 填 `OPENAI_API_KEY`，然后

```bash
npm run dev:test:llm # 模拟模式 + 真实 OpenAI 模型（会计费）；支付仍是模拟支付页，邮件仍打印在终端
```

改了报告生成、Prompt 或校验的代码后，要重启开发服务器：后台生成任务在启动时加载，不随热更新替换。

模拟模式（`RUN_MODE=simulation`）在连接数据库之前就锁定测试库：支付、模型、邮件一律用替身，`.env.local` 或环境变量里的真实密钥与 `DATABASE_URL` 都不会被使用，只连 `.data/pglite-test`（或库名含 test 的 `SIMULATION_DATABASE_URL`）。

不需要任何外部账号即可走通付费流程（配置见 `apps/web/.env.example`）：

- 数据库：内嵌 PGlite，数据在 `apps/web/.data/`，启动时自动迁移。
- 登录验证码：打印在运行 `npm run dev` 的终端里。
- 支付：跳到 `/dev/checkout/...` 模拟支付页，可模拟成功、取消、超时。
- 报告：生成标有「演示内容」的模拟报告，走同一套校验与交付流程。

接入真实服务时，在 `apps/web/.env.local` 里填入 Stripe、OpenAI、Resend 的密钥（填了就自动改用真实服务，留空继续用替身），然后运行 `npm run check:services -w @wenshan/web` 检查配置；Stripe 的 webhook 地址为 `/api/webhooks/payment`。

生产环境按能力校验：关闭收款时只需 `DATABASE_URL` 与 `DATA_ENCRYPTION_KEY` 就能提供免费体验与工单，没配的支付、模型、邮件在用到时返回 503（绝不退回替身）；开放收款时缺任何一项都拒绝启动。上线前先运行 `npm run db:migrate -w @wenshan/web`，再用 `npm run release:check` 看发布结论。

```bash
npm test             # 单元测试（含 4,096 种爻值组合的遍历）、服务端集成测试、独立 worker 进程测试
npm run typecheck
npm run build
```

一键本地验收（类型检查、内容一致性、替身测试与真实 PostgreSQL 并发测试、生产构建、替身评测）。没有设置 `TEST_POSTGRES_URL` 时，若本机装了 PostgreSQL（`initdb`/`pg_ctl`），会在临时目录起一个只监听 127.0.0.1 的集群，跑完删除：

```bash
npm run verify
```

也可以指定一个可以建库的 PostgreSQL（测试自己创建并删除临时库 `wenshan_test_*`，不会动连接串里的库）：

```bash
TEST_POSTGRES_URL=postgres://user@127.0.0.1:5432/postgres npx vitest run apps/web/test/postgres-concurrency.test.ts
```

其他命令：

```bash
npm run worker -w @wenshan/web          # 独立的后台任务进程（Web 设 WORKER_MODE=off 时使用；PGlite 不能与 dev 同时打开）
npm run worker:test -w @wenshan/web     # 模拟模式下的独立 worker（与 dev:test 用同一个测试库，不能同时打开）
npm run eval:models -w @wenshan/web     # 模型对照评测与人工评审表，默认走替身；加 -- --live --budget-usd 5 才调用真实 OpenAI；--reviewed-only 只评测可购买的已审用例
npm run eval:models -w @wenshan/web -- --blind-followups   # 追问盲测（同一份固定报告与历史，A/B 匿名）
npm run check:services -w @wenshan/web  # 检查配置；OpenAI 默认完整走一遍三条路由（约 US$0.1），加 -- --quick 只确认参数
npm run release:check                   # 发布验收：配置校验、内容审校、真实联调三项结果，及"免费体验 / 开放收款"能否发布（--target=free|sales，--smoke-url=部署地址）
npm run acceptance -w @wenshan/web -- --service=stripe --env-file=.env.local --yes   # 真实联调（stripe 测试模式 | openai 需 --budget-usd | resend 测试收件箱），结果记入 apps/web/acceptance/live-evidence.json
npm run content:strict                  # 发布标准的内容审核检查（当前初稿会全部报出，这是预期行为）
```

帮助与反馈在 `/support`（工单），人身安全求助在 `/help`，运营后台在 `/ops`（只对 `OPS_EMAILS` 里的登录邮箱开放）。

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
