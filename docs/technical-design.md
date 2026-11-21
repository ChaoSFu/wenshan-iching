# 问山 技术方案 v0.2

| 项 | 内容 |
|---|---|
| 依据 | 《问山产品设计文档 V0.2（多主题评审稿，2026-11-19）》，下文简称 PRD，`§n` 指 PRD 第 n 节 |
| 状态 | 草案，待产品与工程评审 |
| 日期 | 2026-11-20 |
| 修订 | v0.2：大模型服务改用 OpenAI API（Responses API）；同步调整模型选型、隐私、成本和风险 |

---

## 0. 一页摘要

**产品闭环**：选主题或直接写问题 → 三币起卦 → 免费看本卦/动爻/变卦、原文、白话简读和反思问题 → 登录并支付 US$0.99（2026-11-21 由 US$9.90 下调，见附录 F.10）→ 大模型生成个性化报告，附三次同题追问 → 跨设备回看、导出、删除。

**四个核心架构判断**

1. **免费链路完全在浏览器里跑。** 起卦、查卦、选文、白话简读都在前端完成，问题文本不离开浏览器，服务端只收匿名埋点。这样可以同时满足"数据最小化"（§8）、"起卦结果 2 秒内可用"（§9），免费阶段也没有模型成本。
2. **付费链路围绕订单状态机。** Stripe Webhook 做幂等处理；订单状态变更和后台任务入队放在同一个数据库事务里；超时后自动退款。目标是"付一次款、只发一次货、失败可退"。
3. **大模型只承担一件事。** 每份报告只做一次结构化（JSON）生成，引用只能写原文编号，页面渲染时再按编号回填原文；生成结果先过确定性校验才展示。PRD §7 的五个 "Skill" 是代码里的流水线阶段，不需要 Agent。
4. **内容按代码管理。** 典籍原文、白话注释、主题配置、分流词表、提示词都是带版本号的文件，经 Git 评审后发布。每份报告记录全部版本号，旧报告能查到当时依据的版本（§6）。

**推荐技术栈**：TypeScript 全栈（Next.js + PostgreSQL + Drizzle + pg-boss），Stripe Checkout，OpenAI API（Responses API + 结构化输出；报告用 `gpt-6.2-sol`，分流用 `gpt-6.1-terra`，另加免费的内容审核接口），邮箱验证码登录，部署在新加坡区域。

**最大的三个风险**：① 支付服务商对占卜类业务的准入；② 约 450 条白话注释及主题文案的人工审校量，这是关键路径；③ 报告生成 P90 ≤ 30 秒的时延目标。

---

## 1. 需求理解

### 1.1 需求要点与技术含义

| 维度 | PRD 要点 | 技术含义 |
|---|---|---|
| 用户 | 海外中文成年人，手机为主（§首版、§4） | 移动优先；部署在新加坡区域；首版用简体（繁体待定，见 §2-2） |
| 主题 | 姻缘、事业、学业、收支，外加「其他一事」（§2） | 主题是**配置数据**，不是代码分支。新增主题只加配置、样例和用例，演算不动（§3） |
| 免费 | 免账号；写问题、三币起卦、本卦/动爻/变卦、原文、白话简读、反思问题、样例（§4、§5） | 前端独立完成，不依赖后端和模型 |
| 付费 | 一事一份报告，加三次同题追问；可回看、导出、删除；US$0.99（PRD 首版为 US$9.90，2026-11-21 下调，见附录 F.10） | 需要订单、登录、支付、生成、权限、保留期 |
| 演算 | 三枚钱币，正面记 3、反面记 2，六轮自下而上；逐轮显示和一次完成用同一批抽样；刷新可恢复；付费前服务端复算并锁定版本（§4、§6） | 纯函数库前后端共用；预先抽好 18 枚钱币结果；本地持久化；服务端只信原始值 |
| 选文 | 按 0 动、1 动、2–6 动、乾坤全变分别处理（§6） | 带版本号的选文函数 |
| 典籍 | 64 条卦辞、384 条爻辞、用九、用六、传文；每条带编号、出处、底本版本、审核状态；白话单独存放；规则改动保留版本（§6） | 内容仓库加不可变版本快照 |
| 报告 | 问题摘要、观察角度、原文编号、待核实信息、七天行动（做什么、何时前做、凭什么反馈判断）、回看条件；引用按编号取原文（§7） | 结构化输出 schema 加渲染器 |
| 复核 | 检查字段、引用、版本和禁用断言；失败后台重试一次，仍失败转订单异常（§7） | 确定性校验器，可选再加一次模型审查 |
| 分流 | 健康、求子、官司、投资、即时人身安全；明显高风险的问题退出付费（§2、§7） | 三层：前端词表、付费前模型分流、生成后校验 |
| 订单 | 待支付、已支付、已交付、生成异常、已退款；防回调重放和重复发货；24 小时未交付即退款（§8） | 状态机、幂等、对账任务、定时退款 |
| 隐私 | 免费文本只留在浏览器；发给模型前先告知；报告保留 90 天；邮箱与问题分开管理；日志最小化（§8） | 同意页、字段级加密、定时清理、日志规范 |
| 性能 | 起卦结果 ≤ 2 秒；九成订单在收款后 30 秒内可看完整报告（§9） | 演算本地完成；控制生成长度和模型参数 |
| 指标 | 分主题漏斗、7 天内付费、行动反馈、订单贡献；按原选入口、最终主题、流量来源核对（§10） | 第一方埋点表；问题文本不进埋点 |

### 1.2 PRD §7 的 "Skills" 在本方案中的落地

| PRD Skill | 本方案模块 | 实现方式 | 模型调用 |
|---|---|---|---|
| 澄清与分流 | `triage` | 免费阶段用前端词表；付费前调用一次模型做分类 | 付费前 1 次 |
| 起卦演算 | `iching-core` | 固定代码，前后端共用 | 无 |
| 选取典籍 | `selection` + `corpus` | 按卦号和爻位查表 | 无 |
| 解读与行动 | `report-gen` | 一次结构化生成 | 1 次（失败才重试） |
| 复核与呈现 | `validator` + `renderer` | 确定性校验；可选低成本模型审查 | 可选 |

编排逻辑都写在代码里，每次模型调用是一次独立请求，所以成本、时延和失败处理都可预测，也容易测试。

### 1.3 首版不做

综合流年、合婚排盘、择日、订阅；纳甲六爻、梅花易数、生辰八字；健康与求子的收费主题；中国大陆市场（§8 要求单独评估）；原生 App。

---

## 2. 需要产品确认的问题（会影响实现）

| # | 问题 | 现状或冲突 | 建议 |
|---|---|---|---|
| 1 | 免费反思问题要不要个性化 | §5 样例里的反思问题用到了用户原话（"产品工作"）；但 §7 说免费简读用"已审核白话 + 主题提问"，§8 说免费文本只留在浏览器。个性化就得把问题发给模型 | 首版用模板：按"观察角度 × 主题"预写并审核（见 5.5）。把 §5 的样例改成模板能产出的写法 |
| 2 | 简体还是繁体 | 调研数据来自台湾，竞品多用繁体；目标用户写的是新加坡等地 | 首版用简体。界面文案走 i18n key；原文保留繁体底本，以后可用 OpenCC 转换再人工校对 |
| 3 | 背景字段数量 | §2 说"最多追问一个关键背景"，§3 说"最多三个可选背景字段和一句澄清提示" | 理解为：表单最多 3 个可跳过的字段，其中 1 个作为"关键背景"突出显示。请确认 |
| 4 | 登录方式 | §8 只写了"电子邮件登录" | 用 **6 位邮箱验证码**，不用魔法链接。手机上从邮件 App 点开链接常常会跳到另一个浏览器，只存在当前标签页里的免费结果会丢 |
| 5 | 同题追问的边界 | 用户追问时换成了另一件事怎么办 | 模型判定为"另一件事"时不扣次数，引导用户重新起一卦 |
| 6 | 人工抽检和隐私 | §7 要求抽检自动校验已通过的报告，等于工作人员会读用户的问题和报告 | 在隐私政策和付费前同意页写明；或者只抽检勾选"同意用于改进服务"的样本 |
| 7 | 到期、退款、拒付后的内容处理 | §8 写了 90 天保留期和"回收权限"，没写内容本身怎么处理 | 退款或拒付时立即撤销访问，内容走删除流程；到期前 7 天发一封导出提醒邮件 |
| 8 | 收款主体和首发地区 | 决定 Stripe 账户所在国、税务（GST/VAT）和适用的隐私法规 | 已核查 Stripe 受限业务页：「Psychic services and fortune tellers」只在**泰国、日本、墨西哥**的辖区列表里被禁止，全球列表没有。建议避开这三地开户，开户前向 Stripe 书面确认业务描述（如"AI 辅助的《周易》文化解读报告"），并准备一个备选收款方案 |
| 9 | 价格是否含税 | §8 要求"显示最终金额" | 按含税价 US$0.99 展示（Stripe Tax 用 inclusive 模式），否则各地用户看到的最终金额会不同 |
| 10 | 同一件事反复起卦 | PRD 只规定"同一件事只保留一组爻值"，用户仍可以改换问法反复起卦，直到得到满意的卦 | 首版不限制，埋点记录同一匿名访客的重起次数，看数据再定 |
| 11 | 导出格式 | 只写了"可导出" | 首版：打印友好页（浏览器"存为 PDF"）和长图；服务端生成 PDF 放到后面 |
| 12 | 要不要向 OpenAI 申请零数据保留或数据驻留 | 默认情况下，OpenAI 会把 API 请求的滥用监控日志保留最多 30 天；零数据保留（ZDR）和修改版滥用监控都要经 OpenAI 审批。新加坡区域只提供数据**存储**，不提供**处理**，所以用户文本实际在境外处理 | 首测期不申请，在隐私政策里写明数据跨境和保留期；有量之后再联系 OpenAI 销售评估 ZDR（见 8.2） |

---

## 3. 总体架构

```mermaid
flowchart LR
  subgraph B["浏览器（手机为主）"]
    UI["页面（Next.js）"]
    CORE["iching-core<br/>起卦 · 查卦 · 选文"]
    BUNDLE[("内容包<br/>原文 · 白话 · 主题配置 · 分流词表")]
    SS[("sessionStorage<br/>问题草稿 · 钱币结果")]
  end
  subgraph S["应用服务（新加坡区域）"]
    API["Web/API 进程"]
    WK["Worker 进程（pg-boss）"]
    DB[("PostgreSQL<br/>业务数据 + 任务队列")]
  end
  STRIPE["Stripe Checkout / Webhook"]
  LLM["OpenAI API<br/>Responses · Moderation"]
  MAIL["邮件服务"]

  UI --> CORE --> BUNDLE
  UI <--> SS
  UI -- "匿名埋点" --> API
  UI -- "登录 · 下单 · 读报告" --> API
  API <--> DB
  WK <--> DB
  API -- "付费前分流" --> LLM
  WK -- "报告/追问生成" --> LLM
  API -- "创建结账" --> STRIPE
  STRIPE -- "Webhook" --> API
  WK -- "超时退款" --> STRIPE
  API -- "验证码 · 交付通知" --> MAIL
```

### 3.1 免费链路（无需登录，无需后端）

1. 首页或主题落地页 → 写问题页。主题可通过 URL 参数预选（§4，从视频或搜索进入）。
2. 前端分流词表实时检查（见 5.6），命中"即时人身安全"时暂停流程并显示求助指引。
3. 点击「开始起卦」时一次性抽好 18 枚钱币结果，写入 sessionStorage，再逐轮动画揭示（或一次完成）。
4. `iching-core` 算出本卦、变卦、动爻 → 选文规则 → 从内容包取原文与白话 → 渲染免费结果。
5. 完整内容包约 50 KB（gzip 后），在起卦动画期间加载。不按卦分片加载，免得服务端从请求里看出用户得了哪一卦。

### 3.2 付费链路

```mermaid
sequenceDiagram
  participant U as 用户浏览器
  participant A as Web/API
  participant S as Stripe
  participant W as Worker
  participant M as OpenAI API
  U->>A: 邮箱验证码登录
  U->>A: 上传本次起卦（原始钱币值 + 问题 + 背景 + 主题），勾选同意发送给模型
  A->>A: 按原始值复算卦象，锁定各项版本
  A->>M: 付费前分流（确认主题、问题摘要、缺失信息、风险）
  A-->>U: 题意确认 + 订单确认（金额、币种、交付项、退款说明）
  U->>A: 去支付
  A->>S: 创建或复用 Checkout Session（metadata.order_id）
  U->>S: 完成支付
  S->>A: webhook checkout.session.completed
  A->>A: 验签 → 事件去重 → 核对金额与币种 → 订单置"已支付"，同一事务内入队
  W->>M: 一次结构化生成报告
  W->>W: 校验字段、引用、版本、禁用断言
  W->>A: 写入报告，订单置"已交付"
  U->>A: 轮询订单状态 → 打开报告
```

---

## 4. 技术选型

| 层 | 选择 | 理由 | 备选 |
|---|---|---|---|
| 语言 | TypeScript 全栈 | 演算库必须前后端共用同一份代码，复算才保证一致；小团队只维护一种语言 | — |
| Web 框架 | Next.js（App Router） | 首页、主题落地页、样例页、规则页可以静态生成，利于搜索和视频引流；交互页在客户端渲染；自带 API 路由 | Remix；Astro + 独立 API |
| 样式 | Tailwind CSS + 设计 token | 移动优先；青绿、纸色等主题色统一成 token | CSS Modules |
| 数据库 | PostgreSQL（新加坡区域托管） | 订单需要事务；报告可存 JSONB；还能兼作任务队列 | — |
| ORM / 迁移 | Drizzle | 类型安全，SQL 透明，迁移文件可评审 | Prisma |
| 后台任务 | 自建 `jobs` 表（Postgres，`FOR UPDATE SKIP LOCKED` 认领）+ 定时维护（实现时由 pg-boss 改为自建，见附录 C） | **订单状态变更和任务入队在同一事务里**，任务不会丢；定时退款和清理也用它 | pg-boss；Inngest / Trigger.dev（托管服务，适合部署在 Vercel 上） |
| 部署 | 单区域容器平台（Fly.io / Render / Railway，或 AWS ap-southeast-1），web 和 worker 两个进程 | 生成任务可能要 30–60 秒，常驻 worker 不受函数超时限制 | Vercel + Neon + Inngest |
| 支付 | Stripe Checkout（托管支付页）+ Webhook；视税务登记情况开 Stripe Tax | PRD 已参考 Stripe 文档；托管页不进 PCI 范围；支持 Apple Pay / Google Pay | Paddle、Lemon Squeezy 这类代收方（MoR），需先确认是否接受占卜类业务 |
| 登录 | 邮箱 6 位验证码（Better Auth 的 Email OTP 插件，或自写最小实现） | 原因见 §2-4 | 魔法链接 |
| 邮件 | Postmark / Resend / AWS SES 选一 | 验证码送达率 | — |
| 大模型 | OpenAI API：Responses API（`POST /v1/responses`，官方 `openai` Node SDK）+ 结构化输出；内容审核用 `omni-moderation-latest`（免费） | 按产品决定选用；官方推荐新项目用 Responses API；`strict` 模式的 JSON Schema 可以保证输出结构；有免费的内容审核接口 | 同家族其他档位，按评测结果再换（见 5.7） |
| 埋点 | 第一方 `events` 表，用 SQL / Metabase 出报表 | 样本量小；问题文本不交给第三方 | PostHog（需关闭自动采集和录屏） |
| 错误监控 | Sentry（关闭请求体采集，开 PII 清洗） | — | — |
| 测试 | Vitest、Playwright、Stripe CLI | — | — |

---

## 5. 模块设计

### 5.1 起卦演算 `packages/iching-core`

纯函数、零依赖，浏览器和服务端共用。

```ts
type Coin = 2 | 3;                         // 反 = 2，正 = 3
type Toss = [Coin, Coin, Coin];
type LineValue = 6 | 7 | 8 | 9;            // 老阴 / 少阳 / 少阴 / 老阳

interface Cast {
  ruleVersion: "three-coin@1";
  tableVersion: "kingwen@1";
  tosses: Toss[];          // 长度 6，下标 0 = 初爻
  lines: LineValue[];      // 由 tosses 推导
  primary: number;         // 本卦，文王序 1–64
  changed: number | null;  // 变卦；无动爻时为 null
  movingLines: number[];   // 动爻位置 1–6，升序
}

function sampleTosses(rng = cryptoRng): Toss[]   // 一次抽 18 枚
function castFromTosses(tosses: Toss[]): Cast    // 唯一的推导入口，前后端都调它
```

- **随机源**：`crypto.getRandomValues(new Uint8Array(18))`，每个字节取最低位，1 记正面 3，0 记反面 2。256 是偶数，所以没有偏差。
- **推导**：每爻值 = 三枚之和。7、9 为阳，6、8 为阴，6 和 9 是动爻。六爻从下到上编成 6 位二进制，按"下卦 × 上卦"8×8 表查文王序。变卦把 6 改为阳、9 改为阴后再查一次。
- **同一批抽样**（§6）：用户点「开始起卦」时先抽齐 18 枚并写入 sessionStorage，再逐轮揭示；「一次完成」只是把已揭示轮数直接设为 6。
- **刷新与回退恢复**（§4）：sessionStorage 里存 `{readingId, tosses, revealed}`，刷新后从第 `revealed` 轮继续。
- **服务端复算**（§6）：上传时只接收 `tosses`，先校验形状（6×3，每个值只能是 2 或 3），再由服务端调用 `castFromTosses` 推导，客户端传来的推导字段一律丢弃。写库后不可修改。
- **关于篡改**：用户确实可以伪造自己的钱币结果，但这只影响他自己那一卦，不影响别人，也不影响订单的正确性，所以接受。如果产品要求"由服务端掷币"，可以改成服务端生成钱币值（不需要问题文本），代价是免费链路要依赖后端。
- **测试**（§9 免费闭环的通过条件）：
  - 遍历 6、7、8、9 四个值在六个爻位上的全部 4,096 种组合，本卦、变卦、动爻结果要和**另一份独立录入的 64 卦对照表**（编号、卦名、六爻二进制，来源不同于 8×8 表）完全一致；
  - 已知卦例：`9,7,7,7,7,7` → 乾（1），初九动，变姤（44）；
  - 抽样 10⁶ 次做卡方检验，6/7/8/9 的出现频率应接近 1/8、3/8、3/8、1/8。

### 5.2 典籍与内容库 `packages/content`

**编号规则**（沿用 PRD 的 `ZY.01.L1` 写法）

| 编号 | 含义 | 例 |
|---|---|---|
| `ZY.{卦号两位}.G` | 卦辞 | `ZY.01.G` |
| `ZY.{卦号}.L{1–6}` | 爻辞，初到上 | `ZY.01.L1`（潜龙勿用） |
| `ZY.01.Y9` / `ZY.02.Y6` | 用九 / 用六 | — |
| `ZY.{卦号}.TUAN` | 彖传 | `ZY.44.TUAN`（§5 用到的「遇」） |
| `ZY.{卦号}.XIANG` / `ZY.{卦号}.L{n}.XIANG` | 大象 / 小象 | — |
| `ZY.01.WY.{段}` / `ZY.02.WY.{段}` | 文言 | — |

**原文记录**（§6）：`entry_id`、`kind`、`hexagram`、`line`、`text`、`chapter`、`source_url`、`source_revision`（维基文库页面的修订号，作为快照版本）、`edition`（底本）、`review_status`、`reviewed_by`、`reviewed_at`。

**注释记录**（与原文分开存，§6）：`annotation_id`、`entry_id`、`kind`（白话 `vernacular`、应用示例 `application_example`）、`text`、`angle_tags`（观察角度，见 5.5）、`authorship`（自写或已获授权）、`license_note`、`review_status`。

**存储与版本**

- 源文件：每卦一个 YAML，如 `content/corpus/01-qian.yaml`，原文、传文、注释按编号组织，评审走 Git PR。
- 发布：构建脚本先校验，再生成 `corpus@2026.12.0` 这样的不可变版本。产出物有两份：① 前端内容包（原文、白话、主题界面配置、分流词表）；② 写入数据库 `corpus_entries` 表、以 `(corpus_version, entry_id)` 为主键的完整快照，约 500 行一个版本，可以全部保留。
- 每份报告记录 `corpus_version`，另外把被引用的原文快照存进报告，双重保证旧报告可追溯。

**入库流程**

1. 用 MediaWiki API 抓取维基文库《周易》64 卦页面，记录每页修订号 → 解析出卦辞、爻辞、用九用六、彖、象、文言 → 生成 YAML 初稿。
2. 人工和另一份公有领域底本逐条对勘，状态改为 `reviewed`。
3. 白话注释由大模型起草，再由人工改写审核（§6：现代译注只用自写或获授权的内容，**不得**照搬已出版的译注本）。同时标注观察角度。
4. CI 检查：schema、编号唯一、**覆盖率**（卦辞 64、爻辞 384、用九用六 2，全部需有 `reviewed` 状态的原文和白话；缺一条构建就失败）、白话文本过一遍禁用词表。
5. 版权：《周易》原文属公有领域；维基文库页面本身以 CC BY-SA 授权，在规则页注明来源和修订号。

**缺项处理**（§7）：按理覆盖率检查会拦住缺项。万一运行时选文命中缺项，免费页显示"此条待补"，这次起卦禁止进入付费。

### 5.3 选文规则 `selection@1`（§6）

```ts
function selectPassages(c: Cast): Passage[] {
  const m = c.movingLines;
  if (m.length === 0) return [P(c.primary, "G", "primary")];            // 页面注明"本次无动爻"
  if (m.length === 1) return [
    P(c.primary, "G", "background"),
    P(c.primary, `L${m[0]}`, "primary"),                                 // 突出显示
    P(c.changed!, "G", "expandable"),                                    // 可展开
  ];
  const out = [
    ...m.map(i => P(c.primary, `L${i}`, "primary")),                     // 从下到上
    P(c.primary, "G", "background"),
    P(c.changed!, "G", "background"),
  ];
  if (m.length === 6 && c.primary === 1) out.push(P(1, "Y9", "supplement"));
  if (m.length === 6 && c.primary === 2) out.push(P(2, "Y6", "supplement"));
  return out;
}
```

- 规则带版本号，任何改动都升版本，旧报告按旧版本渲染。
- 这套规则和朱熹《易学启蒙》等传统读法不同（比如多爻动时并列所有动爻爻辞）。按 §6 的要求，`/rules` 页写明适用范围，并说明存在其他读法。
- 测试：4,096 种组合全部跑一遍，对代表组合做快照测试。

### 5.4 主题配置 `content/topics/*.yaml`（§3）

一个主题一个文件，带版本号。示例：

```yaml
id: career
version: 1
name: 事业工作
tagline: 求职、转岗、升职、接项目
intents: [求职, 转岗, 升职, 接项目]
examples:                       # 三条例题
  - 有两个机会，我看重的是什么？
  - 我该不该现在转岗？
  - 接这个项目值不值？
clarify_hint: 你最想先弄清楚的是哪一个选择？
context_fields:                 # 最多 3 个，全部可跳过
  - { key: options,  label: 现在有哪些备选, primary: true }   # 突出显示的"关键背景"
  - { key: deadline, label: 需要在什么时候前决定 }
  - { key: tradeoff, label: 你最在意的取舍 }
free:
  angle_hints:                  # 观察角度 → 主题提示（已审核）
    prepare: 可以先想一想自己已经具备什么、还有什么需要在现实里验证。
  reflection_questions:
    prepare: [你最想验证的是自己喜欢这份工作，还是已经具备申请的能力？]
report:
  must_verify: [目标岗位或选项的实际要求, 时间与资源约束]
  deliverables: [选项的实际比较标准, 一个能核实要求的小尝试, 判断用的反馈]
  action_style: 低成本、可撤回、七天内可完成
boundary_examples:
  - { q: 我买这只股票能赚多少, route: investment }
sample_report: samples/career-qian-l1.yaml
test_cases: tests/career.yaml   # 至少 6 个，其中至少 2 个是边界或误分流用例（§9）
```

「其他一事」也是一个主题配置（`id: other`）。跨主题的问题（例如"为读研要不要辞职"）在写问题页让用户自己选主主题（§2）；纠正主题时只更新 `topic_id`，爻值不变（§4）。

### 5.5 免费简读的组装（不调用模型）

免费结果 = 选中的原文 + 每条原文对应的已审白话 + **一条主题提示** + **一个反思问题**。

为了让主题提示贴合卦象，又不至于写出 384 × 5 条文案，这里引入"**观察角度**"作为中间层：

- 内容团队定义约 12 个观察角度，例如：准备蓄势、试探接触、坚守、节制收敛、等待时机、主动推进、求助合作、调整方向、防范风险、反省自身、适可而止、新的开始。
- 每条卦辞和爻辞标 1–2 个角度（随白话一起审核）。
- 主题配置为每个角度写一条主题提示和 1–2 个反思问题。5 个主题 × 12 个角度，约 120–180 句需要审核。
- 取"焦点原文"的角度：1 动取该爻，0 动取卦辞，多动取最下面的动爻。具体用哪一句由 `readingId` 作随机种子决定，保证刷新后文字不变。

这套角度体系也会作为生成报告时的"共同观察角度"输入（§3「同一卦在不同主题里的交付」）。

### 5.6 澄清与分流 `triage`（§2、§7）

分三层：

| 层 | 时机 | 实现 | 作用 |
|---|---|---|---|
| L0 | 写问题时，免费阶段 | 前端词表和正则 `triage-rules@N`，随内容包发布 | 文本不离开浏览器；即时提示；命中"即时人身安全"时暂停解读 |
| L1 | 付费前，用户同意发送之后 | 先调内容审核接口（免费），再调一次模型，输出结构化结果 | 确认主题、生成问题摘要、指出缺失信息、给出改写建议、判定风险；高风险时不进入付费 |
| L2 | 报告和追问生成之后 | 校验器，再对输出调一次内容审核接口（见 5.7） | 拦截禁用断言、越界建议 |

**分类和处理**

| 类别 | 例子 | 免费阶段（L0） | 付费前（L1） |
|---|---|---|---|
| 即时人身安全（自伤、他伤、家暴） | — | 暂停解读，显示当地紧急服务和可信赖的人等求助指引 | 阻断 |
| 疾病诊断、用药 | 这个病能治好吗 | 提示寻求医疗意见；原文可以继续看 | 阻断付费（首版健康不收费） |
| 求子 | — | 同上 | 阻断付费 |
| 法律结果 | 官司能不能赢 | 提示咨询专业人士；建议改问"我能做哪些准备" | 改写后可以付费，不改写则阻断 |
| 投资收益 | 这只股票会涨吗 | 说明不做收益预测；建议改为收支或风险核查类问题 | 改写后可以付费 |
| 断言他人或结果 | 他会不会回来 | 提示改为可控的选择；用户可以保留原问法（§4） | 允许付费，但报告不断言他人动机 |
| 一次问多件事 | — | 提示先选一件 | 要求选一件 |
| 主题不明或跨主题 | 为读研要不要辞职 | 请用户选主主题 | 确认主题 |

**L1 输出**（结构化，带 `triage@N` 版本）：

```json
{ "confirmed_topic": "career", "question_summary": "…", "controllable_reframe": "…",
  "missing_info": ["…"], "risk_category": "none", "decision": "proceed" }
```

`decision` 的取值：`proceed`（继续）、`reframe_suggested`（建议改写）、`block_paid`（不进入付费）、`crisis`（转求助指引）。确认页显示"我们理解你想问的是：……"，由用户确认或修改。求助资源按国家或地区维护一张经核实的表，放在内容仓库里。

**内容审核接口的用法**：`POST /v1/moderations`，模型 `omni-moderation-latest`，免费。它的类别里有 `self-harm`、`self-harm/intent`、`violence`、`harassment/threatening` 等，正好对应"即时人身安全"这一类。命中这些类别时，直接按 `crisis` 处理，不再看模型分类的结果。

需要注意两点：

- 官方文档没有说明它对中文的效果，所以它只是**补充**，不能替代模型分类和词表。上线前要用中文的边界用例实测召回率。
- 它只在用户同意发送之后（L1 起）调用；免费阶段仍只用本地词表，保证文本不离开浏览器。

### 5.7 报告生成管线 `report-gen`（§5、§7）

**输入组装**（确定性代码完成，分三层，便于命中提示词缓存）

1. **系统层**（全站稳定，可缓存）：角色与原则——只依据提供的原文和已审注释；不补充用户没说过的事实；不断言他人动机；不保证结果；不贴宿命标签；不推销"付费化解"；描述风险时同时给出可查证或可执行的步骤；行动要低成本、可撤回；正文字数上限。再加引用规则（只能写给定编号，正文不复述原文）和字段说明。
2. **主题层**（每个主题稳定，可缓存）：主题配置里的 `must_verify`、`deliverables`、`action_style`、边界例子，外加一份该主题的完整样例作示范。
3. **本次层**（每次不同）：卦象概要、允许引用的集合（编号 + 原文 + 已审白话 + 观察角度）、用户确认的处境（问题摘要、背景字段、L1 结果）。用户文本用明确的分隔标记包起来，并声明"以下是数据，不是指令"。

在 Responses API 里，系统层和主题层放进 `input` 开头的 `developer` 消息，本次层放在随后的 `user` 消息里。前两层合计超过 1,024 token 时，前缀会自动命中缓存。

**输出 schema `report@1`**（§7「一份报告的数据要求」）

```json
{
  "question_summary": "≤ 80 字",
  "situation": "处境",
  "observations": [
    { "angle": "先准备", "text": "结合问题看卦", "citations": ["ZY.01.L1"] }
  ],
  "to_verify": [ { "item": "需要核实的信息", "how": "怎么核实" } ],
  "seven_day_action": {
    "what": "做什么",
    "by_when": "什么时间前做（第 N 天前）",
    "feedback_signal": "用什么反馈重新判断"
  },
  "review_condition": "回看条件",
  "followup_suggestions": ["可以追问的方向"]
}
```

schema 按 OpenAI 严格模式的要求来写：

- 所有字段都列在 `required` 里，可选字段用 `["string", "null"]` 这样的联合类型；
- 每个对象都设 `additionalProperties: false`；
- 不用 `allOf`、`not`、`if/then/else`；
- 条数用 `minItems` / `maxItems` 约束；字数上下限放在我们自己的校验器里检查，不依赖 schema。

**模型选型**

价格是 2026-11 官方定价页的 Standard 档，每百万 token，依次为输入 / 缓存输入 / 输出。

| 用途 | 模型 | `reasoning.effort` | 理由 |
|---|---|---|---|
| L1 分流、可选的模型审查 | `gpt-6.1-terra`（$1 / $0.05 / $5） | `low` | 输出很短的分类任务，要快；官方定位是"快速、高效" |
| 报告、追问 | `gpt-6.2-sol`（$2 / $0.10 / $10） | 先从 `low` 调起 | 官方定位是兼顾智能与成本的日常主力；单价只有旗舰的四分之一，更容易压进 30 秒 |
| 评测对照 | `gpt-6.2-astra`（$8 / $0.40 / $40） | `medium` | 旗舰模型，只在评测里和 Sol 对比；如果质量明显更好、时延也达标，再切换 |

模型名和 `reasoning.effort` 都写在配置里。业务代码通过一个内部接口 `llm.generateStructured(route, input, schema)` 调用，以后换模型或换服务商，只需要改配置和这一层适配代码。

**调用参数**

- **接口**：Responses API `POST /v1/responses`，用官方 `openai` Node SDK。
- **结构化输出**：`text.format = { type: "json_schema", name: "report_v1", schema, strict: true }`。新 schema 第一次调用会稍慢，每次发布后先预热一次。
- **`store: false`**：Responses API 默认会在 OpenAI 那边保存响应状态（30 天）。上下文由我们自己保存，追问时也是自己重发，不需要 OpenAI 代存，所以一律关闭（另见 8.2）。
- **提示词缓存**：自动生效，不用顶层的 `instructions` 字段。官方文档说明，`instructions` 即使命中缓存也按未缓存的价格计费，所以稳定内容一律放在 `developer` 消息里。
- **`max_output_tokens`**：设一个上限，防止输出失控。
- **`safety_identifier`**：传用户 ID 的哈希（官方建议对用户名或邮箱做哈希），不传邮箱原文。
- **失败与拒答**：结构化输出只约束正常完成、没有拒答的结果，其余情况要分开处理：
  - 模型拒答（输出是拒答内容，不是 JSON）→ 按"分流升级"处理，转求助指引并自动退款；
  - `status: "incomplete"`（例如碰到 `max_output_tokens`）→ 重试；
  - API 错误（429、5xx、超时）→ 指数退避重试，不占用下面"校验失败重试一次"的名额。
- **超时与输出方式**：单次请求超时设为 60 秒。生成在 worker 里进行，报告要先过校验才能展示，所以不需要流式输出。

**校验器**（确定性，按顺序执行，带版本 `validator@N`）

1. JSON 符合 schema，各字段非空，长度在上下限之内。
2. 所有 `citations` 都在本次允许的集合里；每条 `observations` 至少有一个引用。
3. 正文里用「」引号括起的古文必须是允许原文的子串，防止模型错引或编造原文。
4. 禁用断言词表（版本化）：宿命类（注定、命中注定……）、保证类（一定会、必然成功……）、化解推销类（化解、转运、破财消灾……）、断言他人动机的句式。
5. 越界内容：用药或剂量、收益率预测、诉讼结果断言。
6. 对输出调用一次内容审核接口（免费），兜底拦截自伤、暴力等内容。
7. 可选：用 `gpt-6.1-terra` 再做一次模型审查，检查"用户没说过的事实"和"引用是否支撑解释"。建议首测期 100% 开启，成本很低，同时积累数据。

**失败处理**（§7）：首次校验失败时，把失败原因附在请求里重试一次；仍然失败 → 订单转为 `generation_failed`，触发告警并进入人工队列；超过 24 小时仍未交付则自动退款（见 5.9）。

**版本记录**：每份报告都存 `versions = {topic, cast, selection, corpus, triage, prompt, schema, model, reasoning_effort, validator}`（§7「报告与追问关联……版本」）。

**时延预算**（§9：收款后 30 秒内，P90）

| 环节 | 目标 |
|---|---|
| Webhook 到达 → 任务被取走 | < 1 秒 |
| 模型生成 | P90 ≤ 25 秒 |
| 校验和入库 | < 1 秒 |
| 前端轮询间隔 | 2 秒 |

可调的手段有：

- 正文控制在约 1,200 字以内，`max_output_tokens` 相应收紧；
- 下调 `reasoning.effort`；
- 换成更快的 `gpt-6.1-terra`（要先过评测）；
- P90 仍不达标时，对报告这一路开 fast 模式（原名 priority processing，单价是 Standard 的 2 倍；具体参数名以 API 参考为准）。

生成期间，页面提示"可以关闭页面，生成好后会邮件通知你"。

### 5.8 同题追问（§4、§8）

- 每个订单 `followups_total = 3`。提交时先用条件更新预占一次：`UPDATE … SET followups_used = followups_used + 1 WHERE followups_used < 3`；生成失败则退还这次。
- 请求必须带 `Idempotency-Key`，防止连点导致扣两次。
- 输入：原报告 JSON、允许引用的集合、已有的追问记录、新问题。同一订单内这部分前缀稳定，可以缓存。因为设了 `store: false`，不用 `previous_response_id` 续接对话，每次都由我们自己拼好完整上下文重发。
- 输出 `followup@1`：`{ is_same_matter, answer, adjusted_action?, citations[] }`。如果 `is_same_matter = false`，不扣次数，引导用户重新起卦（§2-5）。
- 走和报告相同的校验器；同样作为后台任务执行，前端轮询结果。

### 5.9 订单与支付（§8）

**状态机**

```mermaid
stateDiagram-v2
  [*] --> pending_payment: 创建订单 + Checkout Session（锁定价格与币种）
  pending_payment --> expired: session 过期或取消
  expired --> pending_payment: 用户重新结账（新建 session）
  pending_payment --> paid: webhook 验证通过（同一事务内入队生成任务）
  paid --> generating: worker 取走任务
  generating --> delivered: 校验通过
  generating --> generation_failed: 重试一次仍失败
  generation_failed --> generating: 人工或自动重试
  generation_failed --> refund_pending: 超过 24 小时或人工退款
  paid --> refund_pending: 支付了两次（重复支付）
  delivered --> refund_pending: 人工退款
  refund_pending --> refunded: 支付平台确认退款
  delivered --> disputed: 发生拒付
```

**Stripe 结账要点**

- `POST /api/orders` 前置条件：已登录，且 L1 分流结果为 `proceed`。
- 先查这次起卦是否已有订单：已支付或已交付 → 直接跳到交付页；`pending_payment` 且 session 仍是 open → 复用原支付链接；session 已过期 → 新建。这样满足"避免重复付款"（§4）。
- Checkout Session 参数：`mode: payment`，金额 99（`PRICE_AMOUNT_MINOR`），币种 `usd`，`metadata.order_id` 和 `client_reference_id` 都填订单号，`customer_email`，`expires_at` 设为 30 分钟（Stripe 允许的最小值），`success_url` 指向交付页，`cancel_url` 指回本次免费结果（§4「结账失败可返回本次结果」）。调用时带 Stripe 幂等键 `checkout:{orderId}:{n}`。
- 首版只开银行卡和钱包类支付（Apple Pay / Google Pay），不开异步支付方式，这样"已支付"是即时确定的。

**Webhook 处理**（§8「防止回调重放与重复发货」）

1. 用原始请求体校验 `Stripe-Signature`（签名里的时间戳容差本身可以防重放）。
2. `INSERT INTO stripe_events(event_id) ON CONFLICT DO NOTHING`；如果是重复事件，直接返回 200。
3. 处理 `checkout.session.completed`：核对 `payment_status = paid`，并核对 `amount_total` 和 `currency` 与订单锁定的值一致。
4. 用条件更新推进状态：`UPDATE orders SET status='paid' WHERE id=? AND status='pending_payment'`，在同一事务里入队生成任务。
5. 另外订阅：`checkout.session.expired`、`charge.refunded`（或 `refund.updated`）、`charge.dispute.created` / `closed`。
6. 支付成功页也调用同一个幂等的履约函数，去 Stripe 主动核对一次（Stripe 履约文档推荐 webhook 和落地页双路履约）。
7. **对账任务**：每 10 分钟检查一次超过 5 分钟仍是 `pending_payment` 的订单，主动查询 Stripe，补上漏收的 webhook。

**重复支付**：在 `orders(reading_id)` 上建部分唯一索引，覆盖 `paid`、`generating`、`delivered`、`generation_failed` 四种状态。如果用户开两个标签页付了两次，后到的那笔标记为重复，并自动退款。

**退款**（§8：首测以 24 小时为限）：定时任务找出已支付超过 24 小时仍未交付的订单，调用 `refunds.create`（幂等键 `refund:{orderId}`）→ 状态 `refund_pending` → 收到 webhook 后改为 `refunded` → 撤销报告和剩余追问的权限。免费卦象仍然可看。

**拒付**：收到 `charge.dispute.created` 时，状态改为 `disputed` 并撤销访问；后台留存交付证据（交付时间、访问记录）。

### 5.10 账号与访问控制

- **匿名访客**：一个第一方 cookie 存 `anon_id`（随机值），只用于埋点和 7 天内的付费归因（§10），不关联问题文本。
- **登录**：邮箱 + 6 位验证码。验证码哈希存储，10 分钟过期，最多尝试 5 次；按邮箱和 IP 双重限流。会话 cookie 设为 `HttpOnly`、`Secure`、`SameSite=Lax`，有效期 30 天。
- **绑定**：登录发生在结账页内（§4「登录后确认……」），不离开当前标签页，sessionStorage 里的起卦不会丢。上传起卦时绑定 `user_id`。
- **权限**：报告、追问、导出、删除都校验 `session.user_id == order.user_id`。非本人访问一律返回 404，不暴露资源是否存在。
- **跨设备**：在另一台设备用同一邮箱登录 →「我的报告」页列出全部订单（§4）。
- **运营后台**：独立的白名单加二次验证（或放在 Cloudflare Access 之后），所有查看报告内容的操作都写审计日志。

### 5.11 前端页面与状态恢复（§4）

| 路由 | 页面 | 渲染方式 |
|---|---|---|
| `/` | 首页：四个主题卡片加「其他一事」；手机端首屏先露出提问入口，并提供「开始起卦」和「查看样例」 | 静态生成 |
| `/t/[topic]` | 主题落地页，承接视频和搜索流量，带 `utm` 参数 | 静态生成 |
| `/ask?topic=` | 写问题：文本框、主题选择、≤3 个可跳过字段、澄清提示、隐私提示、L0 分流 | 客户端 |
| `/cast/[readingId]` | 起卦：逐轮掷币、「一次完成」、规则说明、可跳过动效 | 客户端 |
| `/r/[readingId]` | 免费结果：卦画、原文（可展开出处）、白话、主题提示、反思问题、样例入口、购买按钮（旁边标明金额和交付项） | 客户端 |
| `/unlock/[readingId]` | 登录 → 同意发送 → 题意确认 → 订单确认 → 跳转 Stripe | 客户端 + API |
| `/orders/[orderId]` | 交付和状态页：生成中、已交付、生成异常、退款进度 | 服务端 + 轮询 |
| `/reports/[reportId]` | 报告：可点开的原文引用、追问框（显示剩余次数）、导出、删除 | 服务端（需登录） |
| `/me` | 我的报告 | 服务端 |
| `/samples/[topic]` | 每个主题的完整样例 | 静态生成 |
| `/rules` | 起卦和选文规则、适用范围、典籍来源 | 静态生成 |
| `/help` | 求助指引（按地区） | 静态生成 |
| `/privacy`、`/terms`、`/refund` | 政策页 | 静态生成 |

**异常与恢复**

| 场景 | 处理 |
|---|---|
| 起卦中途刷新或回退 | sessionStorage 恢复同一批钱币和已揭示轮数 |
| 起卦后只改主题 | 复用这组爻值（§4） |
| 起卦后改问题文本 | 弹窗询问："只是改措辞（保留卦象）"还是"换一件事（重新起卦）" |
| 在 Stripe 页取消或关闭 | 回到免费结果；订单页能查到状态；再次结账时复用未完成的订单 |
| 支付后关闭页面或断网 | 生成在后台继续；交付后发邮件通知；从「我的报告」进入 |
| 换设备 | 登录后在「我的报告」查看 |

**体验要求**（§4、§9）

- 卦画用实线、断线加「动」字标注，不只靠颜色区分。
- 遵循 `prefers-reduced-motion`；起卦动效可以跳过。
- 底部按钮留出 `env(safe-area-inset-bottom)` 的间距。
- 表单只在出错的位置提示修正。
- 首页参考图原件 1942×809、约 3 MB 的 PNG，要转成多尺寸 AVIF/WebP，手机端单独裁一版，首屏图片控制在 200 KB 以内。
- 字体：正文用系统字体；标题和古文用按需子集化的思源宋体。古文字符集是有限的，可以按全部原文预先生成子集。

### 5.12 导出、删除、保留期（§8）

- **导出**：打印友好版（附原文全文和出处），再加一个长图分享；服务端 PDF 放到后面做。
- **删除**：用户主动删除时，删掉问题、背景、报告、追问内容（真删除，不可恢复，删除前二次确认），订单的财务字段保留。剩余追问次数一并作废。
- **保留期**：交付后第 83 天发提醒邮件；第 90 天每日清理任务删除内容。
- **其他数据**：`events` 表不含内容，保留 13 个月；交易记录按账务要求保留；数据库备份保留 ≤ 30 天，使删除能在有限时间内传递到备份。这一点要在隐私政策里写明。

### 5.13 埋点与指标（§10）

**事件**（名称 + 关键属性；任何事件都**不带问题文本**）

| 事件 | 关键属性 |
|---|---|
| `entry_impression` / `entry_click` | `topic`、`position`（卡片位置轮换实验） |
| `ask_submitted` | `topic`、填了几个字段、L0 分流结果 |
| `cast_started` / `cast_completed` | `mode`（逐轮或一次完成）、`recast_count` |
| `result_viewed` / `sample_viewed` | `topic` |
| `unlock_clicked` / `login_completed` / `triage_result` | `decision`、`risk_category` |
| `checkout_opened` / `payment_succeeded` / `payment_failed` | `order_id` |
| `report_delivered` / `report_viewed` / `followup_used` / `export` / `delete` / `refund` | `latency_ms`、`reason` |

公共属性：`anon_id`、`user_id?`、`session_id`、`topic_original`、`topic_final`、`source`（utm、来源域名、落地主题）、`ts`。

**指标口径**

| PRD 指标 | 计算方式 |
|---|---|
| 主题与起卦 | `entry_click / entry_impression`；`result_viewed / cast_started`；按 `session_id` 去重，按主题分组 |
| 免费到支付 | 7 天内 `payment_succeeded` 的 `anon_id` 数 ÷ 同一批 `result_viewed` 的 `anon_id` 数；同时看 `checkout_opened` |
| 订单贡献 | 实收 − 代收税额 − 退款 − 支付手续费 − `generation_attempts` 的 token 成本 − 售后工时折算 |
| 行动反馈 | 访谈记录（不在系统里自动采集） |

**卡片位置轮换**：按 `anon_id` 的哈希决定主题卡片顺序，位置记在曝光事件里。

**盲评工具**（§10，P2）：内部脚本。对每个主题的一道虚构问题，分别生成问山报告和"同一模型直接给建议"两份，随机标成 A、B，由评审者打分。

### 5.14 运营后台（最小版）

- 订单查询（按订单号或邮箱）、状态、Stripe 链接、手动重试生成、手动退款。
- 生成记录：token 用量、时延、响应状态（`status`、是否拒答）、校验失败原因（不含正文）。
- 抽检队列：按比例随机抽已交付的报告，按清单评审——引文是否支撑解释、有没有补进用户没说过的事实、行动能否执行、风险表述是否得当（§7）。评审结果回流到评测集。查看正文前须填写理由并记审计日志。
- 内容管理首版走 Git，后台只展示当前生效的各个版本。

---

## 6. 数据模型（PostgreSQL）

标 🔒 的列在应用层用 AES-GCM 加密，密钥放在 KMS 或密钥管理服务里，密文旁边存 `key_id` 以便轮换。这样"邮箱与问题内容分开管理"（§8）在存储层也是隔离的。

| 表 | 关键列 |
|---|---|
| `users` | `id`, `email`（唯一）, `created_at`, `last_login_at` |
| `auth_otps` | `id`, `email_hash`, `code_hash`, `expires_at`, `attempts`, `consumed_at` |
| `sessions` | `id`, `user_id`, `expires_at` |
| `readings` | `id`, `user_id`, `anon_id`, `topic_id`, `topic_original`, `question`🔒, `context`🔒, `tosses`, `lines`, `primary_hex`, `changed_hex`, `moving_lines`, `cast_version`, `selection_version`, `corpus_version`, `topic_config_version`, `model_consent_at`, `created_at`, `deleted_at` |
| `triage_results` | `id`, `reading_id`, `output`🔒, `decision`, `risk_category`, `triage_version`, `created_at` |
| `orders` | `id`, `user_id`, `reading_id`, `status`, `amount_minor`, `currency`, `price_version`, `stripe_session_id`, `stripe_payment_intent`, `paid_at`, `delivered_at`, `refund_due_at`, `refunded_at`, `refund_reason`, `followups_total`, `followups_used` |
| `stripe_events` | `event_id`（主键）, `type`, `order_id`, `received_at`, `processed_at` |
| `reports` | `id`, `order_id`（唯一）, `content`🔒, `citations_snapshot`🔒, `versions`, `attempts`, `latency_ms`, `expires_at`, `deleted_at` |
| `followups` | `id`, `order_id`, `seq`, `idempotency_key`, `question`🔒, `answer`🔒, `status`, `versions` |
| `generation_attempts` | `id`, `order_id`, `kind`, `model`, `input_tokens`, `cached_tokens`, `output_tokens`, `reasoning_tokens`, `latency_ms`, `status`, `refused`, `validator_errors`（不含正文） |
| `corpus_entries` | `(corpus_version, entry_id)` 主键, `kind`, `hexagram`, `line`, `text`, `chapter`, `source_url`, `source_revision`, `edition`, `review_status` |
| `annotations` | `(corpus_version, annotation_id)` 主键, `entry_id`, `kind`, `text`, `angle_tags`, `review_status` |
| `content_releases` | `kind`, `version`, `hash`, `published_at` |
| `events` | `id`, `name`, `anon_id`, `user_id`, `session_id`, `topic_original`, `topic_final`, `source`, `props`, `ts` |
| `review_samples` | `id`, `report_id`, `reviewer`, `checklist`, `verdict`, `notes` |
| `admin_audit_log` | `id`, `admin`, `action`, `target`, `reason`, `ts` |

`readings` 的卦象字段写入后不可修改，只有删除路径，没有更新路径。

---

## 7. 接口清单

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/events` | 匿名 | 批量写埋点 |
| POST | `/api/auth/otp/request` | 匿名 | 发送验证码（限流） |
| POST | `/api/auth/otp/verify` | 匿名 | 验证并建立会话 |
| POST | `/api/readings` | 登录 | 上传原始钱币值、问题、背景、主题和同意标记；服务端复算并锁定版本 |
| PATCH | `/api/readings/:id/topic` | 本人 | 纠正主题，复用爻值 |
| POST | `/api/readings/:id/triage` | 本人 | L1 分流，返回题意确认 |
| POST | `/api/orders` | 本人 | 创建或复用订单和 Checkout Session |
| GET | `/api/orders/:id` | 本人 | 订单状态（供轮询） |
| POST | `/api/orders/:id/confirm` | 本人 | 支付成功页调用，主动核对 Stripe（复用 webhook 的履约函数） |
| POST | `/api/webhooks/stripe` | Stripe 签名 | 支付事件 |
| GET | `/api/me/orders` | 登录 | 我的报告 |
| GET | `/api/reports/:id` | 本人 | 报告 JSON 和引用原文 |
| POST | `/api/reports/:id/followups` | 本人 | 提交追问，需带 `Idempotency-Key` |
| GET | `/api/followups/:id` | 本人 | 追问结果 |
| DELETE | `/api/reports/:id` | 本人 | 删除内容 |
| — | `/admin/*` | 后台鉴权 | 订单、重试、退款、抽检 |

---

## 8. 隐私、合规与安全

### 8.1 数据清单

| 数据 | 产生时机 | 存放位置 | 是否发给模型 | 保留期 |
|---|---|---|---|---|
| 免费阶段的问题和草稿 | 写问题 | 浏览器 sessionStorage | 否 | 关闭标签页即清除 |
| 匿名 ID 和埋点 | 浏览 | `events` 表 | 否 | 13 个月 |
| 邮箱 | 登录 | `users` 表 | 否 | 账户存续期间 |
| 问题、背景、分流结果 | 同意后上传 | 加密列 | 是（仅必要内容） | 随报告 |
| 报告、追问 | 生成 | 加密列 | 追问时把报告作为上下文 | 交付后 90 天，或用户随时删除 |
| 交易记录 | 支付 | `orders` 表、Stripe | 否 | 按账务要求 |
| 应用日志 | 全程 | 日志平台 | 否 | 只记会话 ID、订单 ID、耗时等 |

### 8.2 关键做法

- **付费前同意页**（§8）：写明哪些内容会发给模型服务方（OpenAI）——问题、背景、所选主题、卦象；用于什么；OpenAI 的数据政策链接；以及人工抽检的安排（§2-6）。
- **OpenAI 侧的数据处理**（据官方 "Your data" 和 "Data residency" 文档，2026-11 核查）：
  - API 数据默认不用于训练模型。
  - 滥用监控日志默认保留最多 30 天。零数据保留（ZDR）和修改版滥用监控都需要 OpenAI 审批（见 §2-12）。
  - 所有请求都设 `store: false`，不让 Responses API 在 OpenAI 侧保存响应状态。
  - 新加坡区域（`sg.api.openai.com`）只提供数据存储，不提供数据处理；亚太地区的区域处理只有日本、印度、澳大利亚，而且只支持 `gpt-6-luna`。所以按本方案的选型，用户文本会在境外处理，隐私政策里要按 PDPA 的跨境传输要求写明。
  - 用数据驻留端点，单价要加 10%。
- **输入提示**：提醒用户省略真实姓名、生日、地址和他人身份信息；前端识别邮箱、电话号码格式并提示。
- **日志与监控**：日志统一用结构化格式，禁止输出请求体和提示词；Sentry 关闭请求体采集；不使用会话录屏类工具。
- **新加坡 PDPA**：涉及同意、目的限制、告知、查阅与更正、保护、保留限制、**跨境传输**（模型服务方在境外）、数据泄露通报。在隐私政策里逐项落实。如有欧盟访客，还要评估 cookie 同意。
- **中国大陆**：首版不面向、不投放。如有计划，按 §8 单独评估《生成式人工智能服务管理暂行办法》等要求。

### 8.3 安全

- Webhook 验签、事件去重；验证码、分流、下单、追问接口都限流。
- 写操作用 `SameSite` cookie 加 Origin 校验防 CSRF；设置 CSP；依赖漏洞扫描。
- 密钥只放在平台的密钥存储里；加密密钥和数据库访问权限分离。
- **提示注入**：用户文本放在分隔标记内，输出受 schema 和校验器约束，结果只返回给提交者本人，影响面可控。
- 运营后台单独鉴权，所有操作有审计日志。

---

## 9. 测试与验收

对照 PRD §9「上线验收清单」：

| PRD 验收项 | 测试方式 | 自动化 |
|---|---|---|
| 64 卦映射与独立对照表一致；遍历 4,096 个组合 | `iching-core` 单元测试（5.1） | CI |
| 先验算爻序和动爻 | 已知卦例和快照测试 | CI |
| 原文、白话覆盖完整 | 内容构建的覆盖率检查 | CI |
| 每个主题 6 个用例，至少 2 个边界或误分流 | `evals/` 评测集：L1 分流准确率、报告校验通过率、模型审查评分 | 改动提示词、模型、内容时运行 |
| 人工检查引文、事实、行动和风险表达 | 抽检清单（5.14） | 人工 |
| 两个测试账号的订单互相隔离 | Playwright：A 账号访问 B 账号的报告和追问接口，应返回 404 | CI（staging） |
| 付款后关闭页面，再从回看入口取报告 | Playwright + Stripe 测试卡 | CI（staging） |
| 重复通知、生成失败、退款，且用户能看到状态 | Stripe CLI 重放事件、打乱事件顺序；注入生成失败；手动加速 24 小时退款计时 | 半自动 |
| 断网、拒付、生成超时 | 断网模拟；Stripe 拒付测试卡；模型调用注入超时 | 半自动 |
| 手机实际操作：按钮、可读性、键盘、跳过动效 | 真机检查清单 + axe 无障碍扫描 | 人工 + CI |
| 起卦结果 ≤ 2 秒；九成订单 ≤ 30 秒 | 前端性能埋点；`report_delivered.latency_ms` 的 P90 | 监控 |

**评测集**的组成：每个主题 6 个用例（共 30 个），加上同卦异题、同题异卦、0 动、1 动、多动、全变，以及古文时代语境的用例（§6）。评分分两部分：确定性校验，加按评分细则打分的模型评审；再抽样人工复核。

---

## 10. 部署与运维

- **环境**：本地（Docker Postgres + Stripe CLI）→ staging（Stripe 测试模式，用独立的模型 API key）→ production。
- **CI/CD**：GitHub Actions 依次跑 lint、类型检查、单元测试、内容校验，再在 staging 上跑 E2E；合并到 `main` 后部署 staging，打 tag 后部署 production。
- **监控指标**：生成时延 P50/P90、校验失败率、拒答率、重试次数、`generation_failed` 数量、处于 `paid` 状态超过 5 分钟的订单数、webhook 错误、队列积压、退款数。
- **告警**：出现任何 `generation_failed`；webhook 连续失败；队列积压超过阈值；对账任务发现漏收的 webhook。
- **运行手册**：漏收 webhook、生成卡住、手动退款、内容版本回滚、模型服务故障时暂停收费（在付费入口加功能开关）。
- **备份**：开启时间点恢复（PITR），备份保留 ≤ 30 天（见 5.12）。

---

## 11. 成本估算（单笔订单，待实测替换）

价格依据：OpenAI 官方定价页（2026-11，Standard 档，每百万 token）——`gpt-6.2-sol` 输入 $2、输出 $10；`gpt-6.1-terra` 输入 $1、输出 $5；内容审核接口免费。token 用量为估计值，下表也没有计入缓存折扣。

| 项 | 假设 | 估算 |
|---|---|---|
| 内容审核（输入和输出各一次） | 免费 | $0 |
| L1 分流（terra） | 输入约 2.5K，输出约 0.6K | ≈ $0.01 |
| 报告生成（sol） | 输入约 8K，输出约 4K（含推理 token）；按 10% 重试率计 | ≈ $0.06 |
| 追问 × 3（sol，全部用完） | 每次输入约 7K，输出约 2K | ≈ $0.10 |
| 可选模型审查（terra） | 报告和每次追问各审一次 | ≈ $0.03 |
| **模型合计** | | **≈ $0.20**（报告和追问如果换成 `gpt-6.2-astra`，约 $0.70；报告开 fast 模式，再加约 $0.06） |
| Stripe 手续费 | 取决于开户国和卡的来源，以 2.9% + $0.30 为基线，境外卡和货币转换另计 | ≈ $0.6–1.0 |
| 税 | 视注册地 GST/VAT | 按含税价反算 |

按 US$9.90 计单笔毛利（税前、未含获客成本）约 US$8.8；下调到 US$0.99 后见附录 F.10。固定成本（托管、数据库、邮件、监控）约每月 $50–150。

---

## 12. 里程碑（对应 PRD §9）

粗估按 1 名全栈工程师加 1 名内容审校人员计算，仅供排期参考：

| 阶段 | 工程交付 | 内容交付 | 退出条件 | 粗估 |
|---|---|---|---|---|
| M0 设计评审 | 可点击原型（静态页加假数据）；`iching-core` 和 4,096 组合测试 | 四个主主题各一份样例报告；主题配置初稿 | 没读过《周易》的人能复述：免费得到什么，付费买到什么 | 1–2 周 |
| M1 免费闭环 | 写问题、起卦、结果页、规则页、样例页；L0 分流；内容构建与校验；埋点 | 450 条原文入库并对勘；白话注释和观察角度标注；主题提示和反思问题 | 64 卦映射与独立对照表一致；4,096 组合全部通过 | 工程 2–3 周；**内容并行 3–5 周，是关键路径** |
| M2 付费闭环 | 登录、L1 分流、Stripe、订单状态机、生成管线、校验器、追问、导出、删除、退款、运营后台、评测集 | 每主题 6 个验收用例；禁用断言词表；求助资源表 | 重复回调、断网、拒付、超时、重试、退款全部通过；订单归属一致 | 3–4 周 |
| M3 小范围上线 | 监控告警、抽检流程、时延调优 | 隐私政策、服务条款、退款政策 | 10 位首测用户中至少 8 位能独立走通，且每个主入口都有人试用 | 2–4 周 |
| M4 开放推广 | 主题落地页、来源归因、短视频落地参数 | 每个主主题一条短视频 | 能解释用户在哪一步流失、为什么付费 | — |

**建议的开工顺序**：`iching-core` 和内容导入可以马上并行开始，两者没有依赖；Stripe 开户和业务确认（§2-8）的周期最难预估，应尽早启动。

---

## 13. 风险清单

| 风险 | 影响 | 应对 |
|---|---|---|
| 支付服务商不接受或事后封禁占卜类业务 | 无法收款 | 开户前书面确认业务描述；避开受限辖区；准备备选收款方案；付费入口加功能开关 |
| 内容审校量大（约 450 条白话、120–180 句主题文案、样例、用例） | 免费闭环延期 | 模型起草加人工审校；按卦并行；先完成高频卦 |
| 报告质量与安全（补出用户没说的事实、宿命论、断言他人） | 投诉、退款、品牌风险 | 三层分流；确定性校验器；模型审查；抽检；评测回归 |
| P90 超过 30 秒 | 体验差，退款增多 | 控制长度、调 `reasoning.effort`、换更快的模型档位、开 fast 模式；"可关页面"加邮件通知 |
| 隐私合规（数据跨境到模型服务方、人工抽检） | 监管与信任风险 | 同意页、隐私政策逐项落实；加密；最小化；保留期清理 |
| 样本太小（每主题约 20 个会话、5 笔付款） | 指标不显著 | 按 §10 以访谈和流失原因为主；不在早期按百分比下结论 |
| 用户为同一件事反复起卦 | 免费体验被滥用、口碑 | 先埋点观察，再决定是否限制 |
| 简繁体之争 | 部分用户觉得不贴合 | i18n 架构预留；按地区数据决定 |
| 模型拒答（健康、心理等话题） | 生成失败 | 分流前置；拒答时转求助指引并自动退款 |
| 内容审核接口对中文的效果没有官方说明 | 漏判高风险问题 | 只作为补充，不单独依赖；与词表、模型分类叠加使用；上线前用中文边界用例实测 |
| 依赖单一模型服务商（可用性、价格、政策变化） | 生成中断或成本上升 | 通过内部接口 `llm.generateStructured` 隔离；模型名放在配置里；出故障时用功能开关暂停收费 |

---

## 附录 A：代码仓库结构

```
wenshan-iching/
├─ apps/web/                 Next.js：页面、API、worker 入口
│  ├─ app/                   路由
│  ├─ server/                订单、支付、分流、生成、校验、任务
│  └─ worker.ts              pg-boss worker 进程
├─ packages/iching-core/     起卦、卦表、选文（纯函数，前后端共用）
├─ packages/content/         典籍、白话、主题配置、分流词表、提示词（YAML），以及构建与校验脚本
├─ packages/report-schema/   报告和追问的 schema（Zod），以及渲染辅助
├─ evals/                    主题用例、评测脚本、盲评工具
├─ docs/                     本文档等
└─ infra/                    部署配置
```

## 附录 B：参考

- PRD V0.2 中的全部来源链接（维基文库《周易》、Stripe、PDPC、YouTube 帮助等）
- Stripe 受限业务列表（2026-11-20 核查）：https://stripe.com/legal/restricted-businesses ——「Psychic services and fortune tellers」列在泰国、日本、墨西哥的辖区禁止业务中
- Stripe Checkout 履约：https://docs.stripe.com/checkout/fulfillment
- OpenAI API 文档（2026-11-20 核查；产品页 https://openai.com/zh-Hans-CN/api/ 无法自动抓取，所以以下以开发者文档为准）：
  - 模型：https://developers.openai.com/api/docs/models
  - 定价：https://developers.openai.com/api/docs/pricing
  - 迁移到 Responses API：https://developers.openai.com/api/docs/guides/migrate-to-responses
  - 结构化输出：https://developers.openai.com/api/docs/guides/structured-outputs
  - 提示词缓存：https://developers.openai.com/api/docs/guides/prompt-caching
  - 数据政策：https://developers.openai.com/api/docs/guides/your-data
  - 数据驻留：https://developers.openai.com/api/docs/guides/data-residency
  - 内容审核：https://developers.openai.com/api/docs/guides/moderation
  - 安全实践（`safety_identifier`）：https://developers.openai.com/api/docs/guides/safety-best-practices

## 附录 C：实现备注（2026-11-20）

免费与付费闭环已按本方案实现，以下是与正文不同或正文未写到的地方：

| 项 | 实现 | 原因 |
|---|---|---|
| 后台任务 | 自建 `jobs` 表代替 pg-boss；默认在 Web 进程内运行（`WORKER_MODE=inline`），也可 `npm run worker` 单独运行 | 依赖更少；能在开发用的 PGlite 上运行；与订单同事务入队的要求不变 |
| 开发数据库 | 未配置 `DATABASE_URL` 时用内嵌 PGlite（WASM 版 Postgres）；测试用内存实例 | 本机无需安装 Postgres 或 Docker |
| 外部服务替身 | 支付、模型、邮件各有 fake 实现（模拟支付页、模拟报告、控制台邮件），生产环境禁止使用 | 不依赖外部账号即可走通并测试完整状态机 |
| 生成异常 | 除正文所述"重试一次后转生成异常"外，维护任务每 30 分钟重新生成一次，直到退款期限；拒答、原文缺失则立即退款 | PRD §8 要求"后台自动重试，用户无需再付款" |
| 禁用断言词表 | 「化解」只在与法事、符咒、花钱请人等连用时拦截 | 解卦等注释里"以正道化解问题"是正常用法，过宽会误判 |
| 服务端内容 | 主题的报告要求另生成 `apps/web/server/generated/report-rules.json`，不进浏览器内容包 | 浏览器不需要这些字段 |
| 测试工具 | Vitest 4（Vitest 5 需要 Node 22）；npm 设 `legacy-peer-deps` 绕过依赖解析崩溃 | 本机为 Node 20 |

## 附录 D：首发改造（2026-11-20，基线 9acdd19）

### D.1 改动

| 项 | 实现 |
|---|---|
| 冻结付费题意 | `readings.revision`：问题、背景、主题或采用改写时 +1。分流结果绑定修订号与规则版本 `triage@2`，同一修订复用不再调模型。新增决定 `reframe_required`（预测官司、收益，或一次问多件事、看不出问什么）：用户须采用改写（`POST /api/readings/:id/reframe`）并重新分流才能下单。下单时把题意、背景、卦象、获准引用的原文与版本、分流结果冻结进订单（`orders.intent_ct` 密文 + `orders.basis`），报告与追问只读快照 |
| 重复退款与原订单相互独立 | 撤回按订单进行（`revokeOrderContent`）；共享的阅读数据只在没有有效且未清除的订单时才清除（`releaseReadingIfUnused`）。用户删除报告时，一并清除该卦所有订单快照里的个人内容、分流摘要与追问，账务字段保留 |
| 交付与退款同一状态机 | 交付在同一事务里先条件更新 `generating → delivered`，成功后才写报告和入队通知；退款或拒付先生效时，晚到的生成结果被丢弃（`discarded`）。部分退款记账但保留访问并标记 `partial_refund`，整单退款撤回访问；退款或拒付回调先于付款到达时返回 503 让支付平台重发；金额或币种异常进入 `needs_review` |
| 独立 worker | 原因：定时器 `unref()` 导致进程立即退出。现在区分 inline（Web 内，unref）与 standalone（常驻，SIGTERM 后等当前任务结束再退出）。任务租约 `JOB_LEASE_MS`；启动时先做一次维护；`recoverPaidOrders` 为丢了任务的已付款订单重新入队。`orders.generation_calls` 持久化，`MAX_REPORT_CALLS_PER_ORDER`（默认 6）约束全部重试，`OPENAI_MAX_RETRIES`（默认 1）约束 SDK 重试 |
| 收款开关与审核门槛 | `SALES_ENABLED` 默认关闭；`/api/offer` 是首页、结果页、解锁页和下单接口共用的报价与开放状态。真实收款前 `contentGate` 要求本次必需原文、白话与主题均为 `reviewed`；彖传、大象只纳入已审条目；未审白话不进入提示词。`ALLOW_UNREVIEWED_CONTENT` 只能与模拟支付一起用，`npm run dev:test` 是对应的测试配置 |
| 旧数据兼容 | 迁移 `0001_launch_readiness` 只加列与表。旧报告照常可读（问题与卦象回退到阅读数据）。维护任务 `backfillLegacyOrders`：阅读在下单后未改过的旧订单补建快照；无法还原的待支付订单作废、已付款订单转 `needs_review`（`legacy_intent_unrecoverable`） |
| 工单 | `/support` 表单（五类问题；报告问题可标三种原因），游客可提交；先持久化并返回工单号，运营通知异步（`notify_support_ticket`），邮件失败不影响工单；字段校验、按 IP 和用户限流、幂等键防重复；订单与报告只在服务端确认归属后关联，报告工单附模型、Prompt 与内容版本，问卦原文由用户选择是否附上。`/ops` 后台按工单号、类型、状态查找与更新状态，可对关联订单发起原路退款，并显示近 30 天模型成本 |
| 模型分工 | 分流 `gpt-6.1-terra/low`，报告 `gpt-6.2-sol/low`，追问默认继承报告，可用 `OPENAI_MODEL_FOLLOWUP`、`OPENAI_EFFORT_FOLLOWUP` 覆盖。每次调用记录任务类型、模型、推理档位、Prompt 与内容版本、输入与缓存 token、输出与推理 token、耗时、失败原因（含未购买用户的分流与失败重试）。成本按价格表计算，推理 token 已含在输出 token 内 |
| 示范与评测 | 报告示范改为取自内容仓库的样例（`report-prompt@2`）。`evals/cases.yaml` 14 个用例；`npm run eval:models` 默认走替身，`-- --live` 才调真实 API，比较通过率、原文依据、无依据数字、行动可执行、是否符合期望、耗时与成本 |

### D.2 新增环境变量

`SALES_ENABLED`、`ALLOW_UNREVIEWED_CONTENT`、`OPENAI_MODEL_FOLLOWUP`、`OPENAI_EFFORT_FOLLOWUP`、`OPENAI_MAX_RETRIES`、`MAX_REPORT_CALLS_PER_ORDER`、`JOB_LEASE_MS`、`WORKER_POLL_MS`、`SUPPORT_EMAIL`、`SUPPORT_NOTIFY_EMAIL`、`OPS_EMAILS`（说明见 `apps/web/.env.example`）。

### D.3 本地验证结果（模型与支付均为替身，不产生真实 token 与扣款）

- `npm test`：9 个测试文件全部通过，其中 `launch.test.ts` 逐条覆盖六项验收，`worker-process.test.ts` 启动真实的独立 worker 子进程，验证它接手"崩溃 worker"留下的任务、持续运行、收到 SIGTERM 后正常退出。
- `npm run typecheck`、`npm run build`、`npm run content:check` 通过。
- `npm run content:strict`：906 条错误、退出码 1——450 条原文未对勘、450 条白话为初稿、5 个主题为初稿、求助号码未核实。这是预期的发布拦截。
- 浏览器验收：默认配置下首页、结果页、解锁页均显示"暂未开放"，免费起卦正常，游客可提交工单，非运营用户访问 `/ops` 得到 404；测试配置下走通登录 → 题意确认 → 模拟支付 → 报告 → "反馈这份报告" → 运营后台看到带版本信息的工单与成本统计。

### D.4 模型费用估算（未实测，按价格表与假设 token 量）

| 环节 | 假设 | 单次 |
|---|---|---|
| 分流（terra/low） | 输入约 2.5K，输出约 0.6K | ≈ $0.0055 |
| 报告（sol/low） | 输入约 8K，输出约 4K（含推理），10% 校验重试 | ≈ $0.062 |
| 追问（继承 sol/low） | 输入约 7K，输出约 2K | ≈ $0.034；改用 terra 约 $0.017 |

每笔成功交付约 $0.17（三次追问都用 Sol）或 $0.12（追问改 Terra）；若免费到付费的转化率为 20%，每笔还要分摊 5 次分流，约 $0.03。上线前用 `npm run eval:models -- --live` 与 `/ops` 的实际 token 数替换这些估算。

### D.5 真实服务上线前仍需完成

1. Stripe：测试模式密钥与 webhook（`stripe listen`）下，跑一次真实测试卡付款、整单退款、部分退款、拒付测试卡，确认回调顺序变化时的 503 重发与最终状态；确认账户所在地与业务描述（§2-8）。
2. OpenAI：`npm run check:services` 验证模型与结构化输出参数；`npm run eval:models -- --live` 跑一轮，确认 Sol 报告的通过率、时延（P90 ≤ 25 秒）与费用，再决定追问是否改用 Terra。
3. 邮件：Resend 验证发件域名；配置 `SUPPORT_EMAIL`、`SUPPORT_NOTIFY_EMAIL`、`OPS_EMAILS`，实测验证码、交付通知与工单通知。
4. 内容：完成原文对勘、白话与主题审校、求助号码核实，直到 `npm run content:strict` 通过，再打开 `SALES_ENABLED`。
5. 生产数据库：`npm run db:migrate` 执行迁移 0000、0001；部署独立 worker 时 Web 设 `WORKER_MODE=off`。

（以上清单已由附录 E.6 更新。）

## 附录 E：第二轮——收款异常恢复与发布验收（2026-11-21，基线 3d6c23f）

### E.1 采纳情况

建议逐条对照代码核实后再动手。确认属实的问题：旧页面可以按改过的题意下单；并发点击会建出多笔待支付订单；找不到订单的已付款回调被标为已处理、不再重发；退款任务按订单去重，失败后无法再次入队；同一笔追问重复结算会多退次数；任务没有认领令牌，被接管后旧 worker 仍能写回；`dev:test` 会跟随 `.env.local` 或继承的 `DATABASE_URL`；关闭收款的生产环境没有 Stripe、OpenAI 凭据就无法启动；未核实的求助号码直接展示在公开页面。

| 建议 | 处理 | 说明 |
|---|---|---|
| P0-1 题意、分流、报价绑定 Checkout | 采纳 | 见 E.2 |
| P0-2 退款可发现、可恢复、可核对 | 采纳 | 见 E.2 |
| P0-3 并发一致性 | 采纳 | 见 E.2 |
| P0-4 测试库隔离、按能力校验配置 | 采纳 | 见 E.3 |
| P0-4 严格审核失败作为可见发布结果 | 调整 | 没有做成构建失败：免费体验在内容审核完成前也要能发布。改为 `npm run release:check` 与 `/ops` 的发布验收面板，分别给出"免费体验 / 开放收款"能否发布及阻断原因；所选目标不可发布时退出码为 1，可直接接进部署流程 |
| P0-4 未核实求助资源由审核状态控制 | 采纳并收紧 | 未核实的号码在正式环境直接不展示（不是展示后加提示），危机面板只给"联系当地紧急服务"的通用指引；开发与测试环境展示并标"待核实"。错误号码会耽误求助，宁缺勿错 |
| P1 `check:services` 走三条真实路由 | 采纳，加开关 | 默认完整检查（合成样例，约 US$0.1）；`--quick` 只确认参数被接受 |
| P1 区分业务调用与 SDK 重试 | 采纳，改法不同 | SDK 自身重试关掉（`maxRetries: 0`），由适配层按 `OPENAI_MAX_RETRIES` 重发并逐次记录为 `attempt_kind = transport`，这样才拿得到每一次失败发送 |
| P1 Sol 与 Terra 追问盲测 | 只完成工具 | 结论需要真实 API 运行加人工评审，不能在替身上得出；工具、用例与评审表已就绪（E.4），追问暂按原配置继承 Sol |

### E.2 收款、退款与并发（P0-1 至 P0-3）

| 项 | 实现 |
|---|---|
| 下单确认 | 解锁页提交 `readingRevision`、`triageId`、`priceVersion`。服务端核对归属、当前修订、当前分流、当前报价，不一致返回 409：`intent_changed`（附当前修订与分流）、`price_changed`（附当前报价）、`triage_required`、`reframe_required`；页面据此重新确认题意或刷新价格 |
| 并发点击与重试 | 确认键 = 阅读、修订、分流、报价版本、金额、币种的哈希；部分唯一索引 `orders_pending_confirmation` 保证同一确认只有一笔待支付订单。订单先落库再调支付平台，Checkout 幂等键 `checkout:<订单号>`；支付平台超时返回 503 `payment_unavailable`，订单保留，重试复用同一订单与会话 |
| 对不上订单的付款 | 先按会话号找，再按 metadata 里的订单号找并回写会话号；都找不到时回调返回 503、事件不标为已处理，支付平台会重发；对账任务同时核对待支付与已过期但有会话的订单 |
| 退款记录 | 新表 `refunds`：每次尝试一行（序号、幂等键、支付平台退款号、状态 requested/pending/succeeded/failed/canceled、金额、币种、原因、发起人、失败原因、最近核对时间）。第一次尝试沿用旧幂等键 `refund:<订单号>`（兼容迁移前已发起的退款），之后为 `refund:<订单号>:<序号>`；任务按退款尝试去重，不再按订单去重 |
| 退款状态更新 | 处理 `refund.created/updated/failed` 与 `charge.refunded`；以支付平台确认的累计金额结算：全额 → `refunded` 并撤回访问，部分 → 保留访问并标记 `partial_refund`。订单页显示实际退款金额 |
| 退款失败与重试 | 失败 → 订单 `refund_failed`，订单页显示"退款处理中"并给出反馈入口。超过 15 分钟未完成的尝试由对账任务向支付平台查询或重新执行（同一幂等键，安全重放）。运营"核实后重试"先向支付平台核实上一次结果：已成功则只更新记录；确认失败才建新尝试（新幂等键） |
| 运营异常单 | `/ops` 订单异常列表：待核实、退款失败、超过 1 小时未完成的退款、生成异常、部分退款，显示状态、原因、最近的退款尝试与运营记录；可原路退款、核实后重试、重新生成。新表 `ops_actions` 记录操作人、时间、动作、结果与备注 |
| 追问原子化 | 提交：一条条件更新同时检查订单已交付、内容未清除、报告未删除未过期、次数未用完。完成：追问仍是 queued 且订单与报告仍有效才写回答。退还次数：只有从 queued 转出的那一次退还，且订单仍有效。退款、删除、到期之后晚到的结果直接丢弃，不留回答、不改次数 |
| 删除与在途付款 | 删除报告时同一卦仍可支付的旧 Checkout 本地作废，并入队 `expire_checkout` 关闭支付平台会话；若支付平台显示已付款（在途付款），按已付款处理并因内容已删除原路退款。工单里随附的问卦原文随报告删除一起清除；工单描述与运营备注按 `SUPPORT_RETENTION_DAYS` 单独清除 |
| 任务认领令牌 | 每次认领生成 `jobs.lock_token`；完成、失败、续租都要带令牌，租约被接管后旧 worker 的写回无效。长任务每 1/3 租约续租一次 |
| 副作用幂等 | 交付通知先认领 `ready_notified_at` 再发信，失败时释放；工单通知同理；退款靠幂等键；报告调用次数持久化 |
| 旧报告 | 迁移前交付、无法还原题意的报告照常可读；继续追问返回 `followups_unavailable`，订单标记 `legacy_followups_unavailable` 供运营处理 |

### E.3 测试库隔离与按能力校验配置（P0-4）

- `RUN_MODE=simulation`（`npm run dev:test`、`npm run worker:test`、worker 集成测试）：在连接数据库之前完成校验。支付、模型、邮件一律用替身，真实密钥即使在 `.env.local` 或继承的环境变量里也被清空；忽略 `DATABASE_URL`，只连 `SIMULATION_DATABASE_URL`（库名必须含 test）或 PGlite 测试目录（目录名含 test，默认 `.data/pglite-test`）；生产环境禁止。`ALLOW_UNREVIEWED_CONTENT` 只能在模拟模式下开启。独立 worker 在模拟模式下不读本地配置文件，指向非测试库时直接退出。
- 按能力校验（`server/capabilities.ts`）：数据库（生产要求 PostgreSQL + 字段加密密钥，不允许落到 PGlite）、支付、模型、邮件各自校验。生产环境只允许真实服务，缺配置就是"不可用"，接口返回 503 `service_unavailable`，绝不退回替身。开放收款的生产环境在启动时要求全部就绪，否则退出（`server/startup.ts`）；关闭收款时只打印哪些能力不可用。
- 已付款订单的履约与退款在执行前检查各自需要的能力（报告与追问要模型，退款要支付，交付通知与工单通知要邮件）；缺配置时任务延后 10 分钟重试，不消耗重试次数、不改订单状态、不触发自动退款等善后。维护任务缺配置时每种只提示一次。
- 求助资源：`help.yaml` 改为逐条 `reviewStatus`（核实后须写来源与日期）。正式环境的 `/help` 与危机面板只展示已核实的号码。
- 发布验收：`npm run release:check`（按生产规则评估当前环境变量，可 `--env-file`、`--target=sales|free`、`--json`）与 `/ops` 的发布验收面板共用 `server/release.ts`，并附 `content:strict` 的分类统计。

### E.4 模型评测与成本（P1）

- 线上与评测共用同一条路径：分流 `decideTriage` → 订单快照 `buildSnapshot`（同一套选文）→ `attemptReport` / `attemptFollowup`（同一套业务校验、输出内容审核、带反馈重试，`server/report/attempts.ts`）。
- 每次运行记录：最终结果（ok / invalid / moderation_flagged / refusal / incomplete / request_error / content_missing / not_run）、每次业务调用的结果与问题码、传输层重发次数、端到端耗时（含重试、内容审核与退避）、token 与成本。报告没有通过时，追问记为 not_run，不计入样本。
- 汇总按环节与模型给出样本数、通过率、失败类型分布、P50 / P90、token、已知成本与"成本未知"的样本数。价格表里没有的模型或没有用量的调用，成本显示"未知"，不按 0 计（评测与 `/ops` 成本统计相同）。
- 线上用量：输出内容审核未通过记为 `moderation_flagged`（不再混入校验失败）；每次失败的发送另记一行 `attempt_kind = transport`、`request_error:<429|5xx|timeout|connection>`，不计入调用次数。
- 用例：`evals/cases.yaml` 20 个，五个主题各有主场景（都带同题追问）与边界场景（他人心意、预测结果、投资涨跌、一次问多件事），另有信息不足、同卦不同题、同题不同卦、追问换题、健康 / 求子 / 官司 / 危机转介。`sample-love`（"有机会复合吗"）原先与分流规则不一致：`triage.yaml` 补充"复合吗、会回来吗、有可能吗、有戏吗"等取决于他人的问法后，期望与规则一致（替身下全部用例的分流期望 100% 符合）。
- 人工评审表：每次评测另写 `.review.md`，逐条列出问题、背景、观察与所引原文、七天行动，要求人工确认"引用支持解释、没有编造背景、行动贴合处境"；自动指标只作初筛。
- 追问盲测：`evals/followup-blind.yaml` 3 个用例、7 个追问（含 2 个换题）。先用报告模型为每个用例冻结一份通过业务校验的报告（真实 API 下写入 `evals/fixtures/blind-reports.json` 并提交），之后各模型基于同一份报告、同一段追问历史回答；评审表只有 A/B 标签（每个用例随机分配），对应关系与汇总另存 `.blind-key.json`。
- `npm run check:services`：默认用合成样例按线上配置完整走一遍分流、报告、追问，检查完整输出、拒答、截断与业务校验；`--quick` 只确认参数被接受。

### E.5 迁移、环境变量与验证结果

迁移 `0002_recovery_and_release`（只新增，不改旧数据）：新表 `refunds`、`ops_actions`；新列 `generation_attempts.attempt_kind`、`jobs.lock_token`、`orders.confirmation_key`、`orders.ready_notified_at`、`support_tickets.purged_at`；部分唯一索引 `orders_pending_confirmation`。

新增环境变量：`RUN_MODE`、`SIMULATION_DATABASE_URL`、`SUPPORT_RETENTION_DAYS`。含义变化：`OPENAI_MAX_RETRIES` 改为适配层的传输重发次数（SDK 不再自行重试）；`ALLOW_UNREVIEWED_CONTENT` 只能在模拟模式下开启；`PGLITE_DIR` 在模拟模式下默认 `.data/pglite-test` 且必须是测试目录。说明见 `apps/web/.env.example`。

本地验证（支付、模型、邮件均为替身，不产生真实扣款与 token）：

| 检查 | 结果 |
|---|---|
| `npm test`（含本机 PostgreSQL 16） | 13 个测试文件、128 个测试全部通过。其中 `round2.test.ts` 19 个（P0-1 至 P0-3）、`release.test.ts` 14 个（P0-4）、`eval.test.ts` 7 个与 `p1-usage.test.ts` 2 个（P1）、`worker-process.test.ts` 2 个（模拟模式下继承占位 `DATABASE_URL` 与密钥仍完成任务并在 SIGTERM 后退出；指向非测试目录时连接前退出） |
| `postgres-concurrency.test.ts`（真实 PostgreSQL，连续 5 轮） | 7 个测试每轮通过：10 次并发下单只建 1 笔订单与 1 个 Checkout；同一付款回调并发 10 次只入队 1 个报告任务；6 个 worker 并发认领 30 个任务无重复，租约接管后旧 worker 写回无效；剩 3 次追问时并发提交 6 次恰好成功 3 次；删除与追问并发后不留回答；3 个运营同时退款只产生 1 次退款尝试。不设 `TEST_POSTGRES_URL` 时跳过 |
| `npm run typecheck`、`npm run build`、`npm run content:check` | 通过 |
| `npm run content:strict` | 915 项未通过（原文未审 450、白话未审 450、主题未审 5、求助号码未核实 10），退出码 1：预期的发布拦截 |
| `npm run release:check`（本机，无生产配置） | 免费体验、开放收款均不可发布：免费体验的阻断项只有"数据库未配置"（本机环境如此，非业务问题）；开放收款另被内容审核、求助号码、支付 / 模型 / 邮件配置阻断 |
| 生产模式启动（`next start`，关闭收款，只配本机 PostgreSQL 与加密密钥） | 正常启动，日志列出不可用的支付、模型、邮件各一次；首页显示付费报告暂未开放；`/help` 只显示通用求助指引；游客提交工单成功；支付回调与登录分别返回 503（支付、邮件不可用）。同样配置但 `SALES_ENABLED=true` 时拒绝启动（退出码 1）并列出缺少的配置 |
| `npm run eval:models`（替身） | 20 个用例：分流 19 次（危机用例由规则直接处理）期望全部符合；两个报告模型各 14 个样本、追问两个模型各 6 个样本全部通过；成本显示"未知"。`--blind-followups`（替身）14 条回答，标签随机分配 |
| 浏览器 | 开发环境 `/help` 与危机面板显示号码并标"待核实"；`/ops` 发布验收面板在 375 px 宽度下无横向滚动 |

环境问题（非业务失败）：本机 PostgreSQL 临时实例的 Unix socket 路径超长、启动时缺少 locale，改用 TCP 与 `LC_ALL=C` 后正常；`release:check` 在本机因为没有生产配置而判定不可发布。业务失败：无。

### E.6 仍待人工与真实服务验收

人工：原文对勘 450 条、白话审校 450 条、主题审校 5 个、求助号码逐条核实 10 个（直到 `npm run content:strict` 与 `npm run release:check -- --target=sales` 通过）；真实评测后的人工评审表；追问盲测的 A/B 评审。

真实服务（本轮全部使用替身，均未实测）：

1. Stripe 测试模式：真实测试卡付款；整单与部分退款；异步退款失败（Stripe 测试卡可模拟）后 `refund_failed` → 运营核实后重试；退款回调乱序与重放；拒付；删除报告时关闭仍可支付的 Checkout，以及在途付款的原路退款。
2. OpenAI：`npm run check:services`（完整三条路由，约 US$0.1）；`npm run eval:models -- --live`（按价格表估算约 US$5，其中 Astra 报告对照约占 US$3.5）与人工评审；`--live --blind-followups --freeze-reports` 冻结报告后做 Sol 与 Terra 追问盲测，再决定 `OPENAI_MODEL_FOLLOWUP`。
3. Resend：验证码、交付通知、工单通知的实际发送，以及发送失败后的重试不重复发信。
4. 生产 PostgreSQL：`npm run db:migrate` 执行迁移 0002；部署后运行 `npm run release:check` 确认目标可发布。


## 附录 F：第三轮——支付对账、故障恢复与上线验收（2026-11-21，基线 27595ee）

### F.0 采纳情况

建议逐条对照源码与支付方契约核实。确认属实的问题：Checkout 的有效期每次调用时重算，同一幂等键配了不同参数，在真实 Stripe 下重试会被拒绝（`idempotency_error`），响应丢失后再也拿不回会话；会话过期后直接作废订单另开一笔，没有先确认旧会话不可支付；报价版本只是一个配置字符串，改价忘了改版本号时旧页面照样按新价格下单；订单只有报价金额，整单退款拿报价比较；`charge.refunded` 的累计数直接改订单，退款没有身份校验，支付方后台的手动退款会被绑到"最近一次进行中的尝试"上；运营"核实后重试"在本地更新被乱序保护挡住时仍记"已同步"；超时退款用应用时间筛选、取锁后不重新校验，可能把刚交付的订单退掉，交付也不看期限；通知在发送前就写"已通知"，进程中途退出会留下假象；分流、改主题、采用改写、工单附原文都在读写之间没有保护，删除后迟到的结果能把已清除的内容写回去；PostgreSQL 测试会清空连接串指向的那个库的 `public` schema。

| 建议 | 处理 | 说明 |
|---|---|---|
| P0 付款尝试持久化、幂等键与参数一一对应 | 采纳 | 新表 `checkout_attempts`，见 F.1 |
| P0 区分创建前失败 / 已创建响应丢失 / 会话过期 | 采纳并补全 | 另处理了建议没提到的一种：Stripe 会把 5xx 也保存在幂等键下，同一键重放永远得到同样的错误——这时按尝试 ID 在支付方列表里对账，确认查无此会话才作废（F.1） |
| P0 报价标识绑定金额与币种 | 采纳 | 标识为 `PRICE_VERSION:金额:币种`（可读，不用哈希），改价不改版本号时标识也会变 |
| P0 适配器契约测试 | 采纳，并复用到真实联调 | `server/payments/contract.ts` 同一组检查在单测里跑替身、在 `npm run acceptance -- --service=stripe` 里跑 Stripe 测试模式 |
| P0 报价、实收、已退分开存 | 采纳 | 见 F.2；迁移前已付款的旧单按旧版本的核对规则回填实收，核对不了的（金额异常单）留空、进异常列表 |
| P0 回调乱序保护与主动核实分开 | 采纳，改法更严 | 与本地终态矛盾的回调不再直接忽略，而是触发一次主动核实：Stripe 的退款可能先成功后失败（测试卡 4000 0000 0000 5126），旧的保护会把真实的失败吞掉 |
| P0 超时退款与交付同一套条件 | 采纳 | 先定约定再实现，见 F.3 |
| P0 退款身份唯一、外部退款独立入账、未知结果转人工 | 采纳 | 本系统发起的退款带 `refund_attempt_id` 元数据；"最近一次尝试"的猜测只保留给迁移前的旧尝试；重试边界见 F.2 |
| P1 通知认领与"已被接受"分开、邮件幂等键 | 采纳 | 见 F.4；补收窗口限制在 Resend 幂等键的有效期（24 小时）内 |
| P1 删除与迟到写回 | 采纳，范围扩大 | 除分流与工单附件外，改主题、采用改写也加了保护（F.5） |
| P1 发布验收三项结果 | 采纳 | 见 F.6；严格审校仍不做成构建失败（理由同 E.1），`--target=sales` 时阻断 |
| P1 PostgreSQL 测试用临时库、接入可重复的检查 | 采纳 | 测试自建自删临时库；`npm run verify` 没有连接串时自动起临时集群 |
| P1 `--reviewed-only` 调用下单的 `contentGate` | 采纳 | 见 F.7 |
| P1 用已审样例跑三条路由后做 Sol/Terra 盲测并选型 | 只完成工具与规则 | 当前内容全部待审，按已审内容评测时合格样本为 0——这只说明内容待审，不能据此判断模型；选型规则见 F.7，默认保持现有路由 |
| P1 真实联调使用授权环境并留证据 | 只完成工具 | 本会话没有获得调用真实服务的授权，`npm run acceptance` 已就绪但未运行（F.6、F.9） |

### F.1 Checkout 在真实支付方契约下可重试

| 项 | 实现 |
|---|---|
| 付款尝试 | `checkout_attempts`：第一次请求前写入尝试 ID、序号、幂等键 `checkout:<订单>:<尝试>`、金额、币种、请求有效期、成功与取消地址、描述。重试原样重放这些参数（有效期不重算）；写回支付方返回的会话 ID、结账地址与实际有效期。订单上的 `provider_session_id / checkout_url` 只是最近一次尝试的冗余 |
| 有效期 | 请求有效期 = 创建尝试时 + 40 分钟：Stripe 要求至少 30 分钟，多出的 10 分钟让同一尝试在这段时间内的重放都能通过参数校验；剩余不足 2 分钟的会话不再复用 |
| 失败分类 | 适配器把错误归为 `not_created`（4xx：支付方明确没有创建，参数校验失败的结果不会被保存）、`unknown`（连接错误、5xx、429、409）、`param_mismatch`（`idempotency_error`）。`not_created` → 尝试作废，可开新尝试（全新尝试也被拒说明是配置问题，直接 503）；`unknown` / `param_mismatch` → 先按尝试 ID 在支付方对账，找到就采用，超过 2 分钟仍查无此会话才作废 |
| 会话过期 | 开新尝试前先确认旧会话不可支付：已付款 → 按已付款处理（下单接口返回 `checkoutUrl: null`，页面去订单页）；仍可支付 → 先在支付方关闭（关闭时恰好被付款也按已付款处理）；已过期 → 作废。部分唯一索引保证一笔订单同一时刻只有一个未终结的尝试 |
| 写回检查 | 在订单行锁下写回会话：订单已删除或作废时不返回结账链接（409 `order_closed`），并入队 `expire_checkout` 关闭支付方那边的会话 |
| 付款归属 | `markPaid` 先按会话 ID 找尝试，其次按元数据里的尝试 ID，迁移前的会话按订单上的会话 ID 或元数据订单号；同一订单的意外第二笔付款单独原路退款，订单本身不受影响 |
| 对账 | 成功页与每分钟的维护任务核对订单所有未终结的尝试（`reconcileCheckouts`）；`checkout.expired` 回调只作废对应尝试，订单仍待支付 |
| 契约测试 | 同一键 + 同样参数 → 同一会话；同一键 + 不同有效期 → `param_mismatch`；有效期不足 30 分钟 → `not_created` 且不占用这个键；按尝试 ID 找回会话；关闭后不可支付；退款同一键同一笔、元数据带回尝试 ID、可按付款列出、全额退后再退被拒（`RefundRejectedError`） |

### F.2 按实际资金流水结算退款

- 订单分开记三样：报价 `amount_minor/currency`、支付方确认的实收 `paid_amount_minor/paid_currency`、已成功退款合计 `refunded_amount_minor/refunded_currency`。订单页与运营后台显示的都是支付方确认的数字。
- `refunds` 是退款流水：本系统发起的尝试（`source = local`）与在支付方后台发起的外部退款（`source = external`）各自一行；`provider_refund_id` 全表唯一，`provider_payment_id` 记被退的那笔付款。结算在订单行锁下按流水重算（`recomputeOrderRefunds`）：只计主付款、与实收同币种的成功退款；合计 ≥ 实收 → 整单退款并按订单撤回；部分 → 保留访问、标 `partial_refund`；先判定已退、后来支付方显示失败 → `refund_failed` + `refund_reversed`（已撤回的内容不恢复）；进行中的退款全部结束且最近一次失败 → `refund_failed`；币种不一致 → `refund_currency_mismatch`。
- 绑定规则：先按退款 ID；其次按元数据里的退款记录 ID（本系统发起的退款都带）；迁移前的旧尝试没有元数据，只在恰好一条未绑定的旧尝试时关联；其余一律作为外部退款独立入账。`charge.refunded` 不再直接用累计数改订单，而是按支付方的退款列表逐笔入账；列表合计仍少于累计数时标 `refund_ledger_incomplete` 交运营。
- 乱序与核实：普通回调只推进未终结的记录；与本地终态矛盾时入队 `verify_refund` 主动查询，以查询结果为准（可以把成功改为失败，也可以把误判的失败改回处理中或成功），但必须是同一笔付款、同一个退款 ID、同一条尝试。运营"核实后重试"同样先查：支付方成功或仍在处理 → 只同步（事务实际更新成功才记 `synced:<状态>`，否则记 `sync_rejected:<原因>` 并返回 409）；确认失败或查无此退款 → 按支付方列表重新入账后仍未退完，才开新尝试（新幂等键 `refund:<订单>:<记录>`）。
- 结果持续未知：没拿到支付方退款 ID 的尝试按同一幂等键自动重试；达到 6 次，或距发起超过 20 小时（Stripe 幂等键 24 小时后失效，之后再自动重发可能多退），先按尝试 ID 在支付方找，找不到就标 `escalated_at`、不再自动重试，订单转 `refund_failed` + `refund_unconfirmed`；已有的成功退款与合计不受影响。运营核实后重试时，支付方查无此尝试 → 作废、开新尝试退剩余金额。
- 旧单：迁移前已付款、实收无法核实的订单（金额异常单）退款时只记账，标 `payment_unverified`，进运营异常列表，不据此判断整单或部分退款。

### F.3 交付与超时退款的约定

交付期限 `refund_due_at` 在付款时按数据库时间写入（`now() + REFUND_AFTER_HOURS`）。约定：

1. 交付事务在数据库时间 ≤ 期限时提交 → 已交付，不退款；之后超时退款取得订单锁、重新校验，看到已交付即跳过。
2. 过了期限仍未交付 → 原路退款；期限后才完成的报告丢弃，交付事务自己在同一锁下发起这笔退款（与超时退款任务竞争时，第二方看到已有进行中的尝试，不会再开一笔）。
3. 期限已过的订单不再开始生成（不浪费模型调用），由超时退款接手。运营"重新生成"时重新承诺期限。

两边都在订单行锁下、用同一个数据库时钟判断。真实 PostgreSQL 上 12 笔期限散布在"现在"前后的订单同时生成与超时退款，每一笔都只得到"已交付且无退款"或"退款中且无报告"之一。

### F.4 通知：认领与"已被接受"分开

交付通知与工单通知都分两步：先条件更新认领（尚未被接受，且没有 5 分钟内的有效认领；被占用时任务延后 5 分钟，不消耗重试次数），再带稳定幂等键发送（`ready-mail:<订单>`、`ticket-notify:<工单>`，Resend `Idempotency-Key`），邮件服务接受后才写 `ready_notified_at` / `notified_at`，失败则释放认领交给重试。进程在认领后退出：认领过期后被重新认领、用同一幂等键重发；服务已接受但响应丢失：重发被邮件服务去重，只投递一封。重试用尽的通知由维护任务每 30 分钟补一次，只补 20 小时内的（超过 24 小时幂等键失效，再发可能重复）。邮件服务明确拒绝（4xx，除 409、429 外）不再重试。

### F.5 删除后迟到的写回

分流结果、改主题、采用改写、工单附原文都把"源数据仍有效"的检查放进写入事务：分流在阅读行锁下确认这一卦未删除、问题仍在、修订号未变才保存，否则丢弃并返回 409；改主题与采用改写的更新条件包含未删除与修订号（同时防止两处同时编辑互相覆盖）；工单在订单行锁下读取并附上原文，订单内容已清除时不附。删除事务更新同一行时会等待或被等待，删除完成后迟到的结果无法再写回已清除的原题或摘要。

### F.6 发布验收与真实联调

- `npm run release:check` 与 `/ops` 面板给出三项结果——配置校验、内容审校、真实联调——以及"免费体验 / 开放收款"两个目标的结论；参数写错（例如 `--target=prod`、拼错的参数名）直接报错，退出码 2。
- 免费体验单独验收：数据库与加密密钥、运营入口（`OPS_EMAILS`）、公开支持邮箱（`SUPPORT_EMAIL`）缺一项即阻断；支付与模型对免费体验"不适用"；可加 `--smoke-url=<部署地址>` 检查首页、`/help`、`/support` 可打开且报价接口显示收款关闭。
- 开放收款另外要求：收款开关打开；严格审校（读源文件，与 `content:strict` 一致）通过；`generated/` 与 `server/generated/report-rules.json` 和源文件一致；求助号码全部核实；Stripe、OpenAI、Resend 三项都有通过的联调记录、没有待核实项、在干净的提交上运行，且联调后相关配置没有改动（每项各自的配置版本：价格与支付方式 / 模型与推理档位 / 发件地址，不含密钥与站点地址）。运营面板读不到内容源文件，相关两项显示"需要运行 CLI"。
- 真实联调：`npm run acceptance -w @wenshan/web -- --service=stripe|openai|resend --env-file=… --yes`。Stripe 只接受测试模式密钥，跑 F.1 的契约检查并用测试卡确认一笔付款验证退款；OpenAI 必须给 `--budget-usd`，用合成样例按线上路径走分流、报告、追问三条路由，默认只用已审内容；Resend 默认发到 `delivered@resend.dev`，同一幂等键发两次应只产生一封。每次运行把提交、是否有未提交改动、配置版本、各项检查与待核实项追加到 `apps/web/acceptance/live-evidence.json`（不含密钥）。`--provider=fake` 不联网，对替身跑同一套检查。

### F.7 评测与追问选型

- `--reviewed-only`：可购买的用例先过下单所用的内容审核门槛（`contentGate`），被挡住的记为 `review_pending`、单独计数，不计入样本；汇总写"合格样本"与"内容待审"两列，合格样本为 0 时明确写"这只表示内容还没审完，不能据此判断模型质量"。盲测同样适用。
- 汇总新增"未知成本占比"。`--live` 必须给 `--budget-usd`：每次调用前检查已知花费，超出即停；价格表里没有的模型在第一次出现未知成本后即停，除非 `--allow-unknown-cost`。
- 追问选型规则（`followupDecision`）：默认保持现有路由（追问继承报告模型 Sol）。只有候选模型（Terra）在同一份冻结报告上的错误率不高、P90 不慢、已知费用更低、两边都没有未知成本，并且人工评审的贴合度不低于现有模型时，才建议设置 `OPENAI_MODEL_FOLLOWUP`；合格样本不足时结论为"不足以选型"。

### F.8 迁移、命令与验证结果

迁移 `0003_payment_ledger`（兼容旧数据）：新表 `checkout_attempts`；`orders` 新增 `paid_amount_minor`、`paid_currency`、`refunded_currency`、`ready_notify_claimed_at`；`refunds` 新增 `provider_payment_id`、`source`、`legacy_request`、`tries`、`escalated_at`，`provider_refund_id` 改为部分唯一索引；`support_tickets` 新增 `notify_claimed_at`。手写的回填：旧退款尝试标为 `legacy_request`（重放沿用当时的请求参数）并补上被退的付款；同一支付方退款 ID 的重复记录保留最早一条、其余作废；旧版本核对过金额的已付款订单回填实收（金额异常单留空）；有会话 ID 的旧订单补一条 legacy 付款尝试（只按会话 ID 对账，不重放）。没有新增环境变量；`PRICE_VERSION` 的报价标识改为"版本:金额:币种"。

新命令：`npm run verify`（一键本地验收）、`npm run acceptance -w @wenshan/web`（真实联调与证据记录）；`npm run release:check` 新增 `--smoke-url`，参数错误退出码 2；`npm run eval:models -- --live` 必须给 `--budget-usd`。

本地验证（支付、模型、邮件均为替身或 Stripe 契约的本地模拟，没有真实扣款、token 与邮件）：

| 检查 | 结果 |
|---|---|
| `npm run verify` | 通过：类型检查、内容一致性、测试（替身 + 自动起的临时 PostgreSQL 16 集群）、生产构建、替身评测全部通过；业务失败 0 项，环境问题 0 项 |
| 全部测试（含真实 PostgreSQL，连续 3 轮） | 14 个测试文件、166 个测试每轮全部通过。新增 `round3.test.ts` 25 个：适配器契约；参数先持久化、重放不重算有效期（支付方创建请求 2 次、实际创建 1 次）；响应丢失后找回同一会话；5xx 被保存在幂等键下时对账后才开新尝试、重放被参数校验拒绝时换新尝试；过期 / 将过期会话先确认不可支付、关闭前已付款按已付款处理；请求在途时订单被删除不返回链接并关闭会话；改价不改版本号也要求重新确认；报价与实收分开、按实收判定整单退款；金额异常单部分退款后仍待核实且不能重新生成；旧单实收未核实进异常列表；运营核实的三种状态（支付方失败 → 新尝试；仍在处理 → 更正为处理中、不开新尝试；已成功 → 已退款并撤回访问）及"更正没写进去就不记已同步"；乱序回调触发核实、退款先成功后失败转 `refund_reversed`；外部退款独立入账、我方在途尝试只按自己的退款 ID 绑定、不重复计数；结果持续未知转人工且保留已确认的退款；交付期限三种情形；通知的认领回收、延后不耗次数、已接受但响应丢失只投递一封；删除后迟到的分流被丢弃、工单不附已删除的原文。`eval.test.ts` 新增 3 个、`release.test.ts` 重写为 18 个 |
| `postgres-concurrency.test.ts`（真实 PostgreSQL） | 13 个：原有 7 个，加上——首个响应丢失时 10 次并发点击仍只创建 1 个会话；12 笔订单在期限附近同时生成与超时退款，每笔只得到一个结果；工单提交与删除并发 6 轮不留原文；分流、改主题与删除并发 4 轮不写回问题、背景与摘要；同一支付方退款的 5 个并发回调只入账 1 条；迁移 0003 在 0002 的旧数据上执行后回填正确、去重正确、唯一约束生效。测试自己创建并删除临时库，跑完 `pg_database` 里没有残留的 `wenshan_test_*` |
| `npm run acceptance -- --provider=fake` | Stripe 契约 7 项 + 退款契约 4 项全部通过；OpenAI 三条路由在 `--allow-unreviewed` 下通过，默认（只用已审内容）报告与追问被内容审核挡住，如实记为待审 |
| `npm run eval:models -- --reviewed-only`（替身） | 报告两个模型各 14 个、追问各 6 个可购买用例全部被内容审核挡住，合格样本 0，报告写明"不能据此判断模型质量"；盲测选型初判为"不足以选型" |
| `npm run release:check`（本机，无生产配置） | 三项结果：配置校验阻断（本机没有数据库、`OPS_EMAILS`、`SUPPORT_EMAIL`），内容审校对收款阻断（915 项待审）、源文件与生成文件一致，真实联调对收款阻断（没有联调记录）。免费体验、开放收款均不可发布——前者是本机环境如此 |
| 浏览器（`dev:test`，375 px） | 迁移 0003 在已有数据的 PGlite 测试库上自动执行；旧订单的实收回填为 US$9.90；新下单的报价标识为 `price@2026-11:990:usd`；付款 → 交付 → 运营退款后订单页显示"已原路退款 US$9.90"、报告已收回；`/ops` 发布验收显示三项结果，异常订单卡片显示报价 / 实收 / 已退与退款流水；无横向滚动 |

环境问题（非业务失败）：无。说明：浏览器里一笔上一轮付款的订单退款被替身拒绝、转为 `refund_failed` 进入异常列表——替身把会话存在进程内存里，开发服务器重启后不认得旧付款；系统按"支付方明确拒绝"处理的行为本身正确，真实 Stripe 不存在这个问题。业务失败：无。

### F.9 仍待人工与真实服务验收

人工：原文对勘 450 条、白话审校 450 条、主题审校 5 个、求助号码核实 10 个——在此之前按已审内容的评测合格样本为 0，开放收款的内容审校项保持阻断；真实评测与盲测的人工评审（贴合度打分后用 `followupDecision` 得出追问选型结论，默认保持 Sol）。

真实服务（本轮没有获得调用授权，工具已就绪、均未运行）：

1. Stripe 测试模式：`npm run acceptance -w @wenshan/web -- --service=stripe --env-file=… --yes`（契约与退款检查，约 1 笔测试付款）；待核实项见脚本输出——Checkout 页面用 4242 付款并经部署地址收到 webhook、4000 0000 0000 5126 退款先成功后失败、4000 0000 0000 0259 拒付、删除报告时关闭会话与在途付款退款。
2. OpenAI：`--service=openai --budget-usd=1`（三条路由约 US$0.1）；内容审完后 `npm run eval:models -- --live --budget-usd 5 --reviewed-only` 与追问盲测。
3. Resend：`--service=resend`（默认发到 `delivered@resend.dev`），再用自己的测试收件箱各收一次验证码、交付通知、工单通知。
4. 生产 PostgreSQL：`npm run db:migrate` 执行 0003；部署后 `npm run release:check -- --target=free --smoke-url=<地址>`，开放收款前 `--target=sales` 须全部通过。

### F.10 定价调整与本地模型（2026-11-21）

- 一次付款由 US$9.90 改为 **US$0.99**：`PRICE_AMOUNT_MINOR` 默认值 99，报价标识随之变为 `price@2026-11:99:usd`，按 9.90 打开的旧页面下单时会被要求确认新价格。测试固定用 990 的价格，退款金额等断言不受产品定价影响。
- 单笔经济账（估算，以实际账户为准）：Stripe 以 2.9% + US$0.30 为基线约 US$0.33（约占三分之一，境外卡与货币转换另计）；模型按 Sol 报告加三次追问约 US$0.17–0.20，加上分摊的分流约 US$0.03。合计约 US$0.53–0.56，税前毛利约 US$0.43。退款时 Stripe 不退手续费，每笔退款约亏 US$0.33 加已花的模型费用——交付失败率与重复付款对利润的影响比定价 US$9.90 时大得多。Stripe 美元最低收款 US$0.50，0.99 满足。
- 模型与 ChatGPT 订阅：ChatGPT Plus 不含 API 用量，API 按量单独计费；Plus 也不在"订阅送 API 额度"的范围内（那是 Pro 与 Business）。API 没有可用的免费模型。2026-11-21 本地实测：密钥有效，`gpt-6.2-sol`、`gpt-6.1-terra`、`gpt-6-luna`、`gpt-6.2-astra` 都可见，`gpt-6-luna` 与 `gpt-6.1-terra` 都能正常生成，响应里 `billing.payer = developer`（计入 API 账户）；`gpt-6-luna` 在分流、报告、追问三条路由上都接受严格结构化输出。
- 本地测试：`npm run dev:test:llm`（模拟模式 + 真实模型，支付走模拟支付页）。本机 `.env.local` 把三条路由都设为最便宜的 `gpt-6-luna`（约为 Sol 的 1/20），只影响本地；线上默认仍是分流 Terra、报告与追问 Sol，换模型要先按 F.7 的评测与盲测决定。完全不想花钱时用 `npm run dev:test`（模型替身）。

## 附录 G：第四轮——简化免费结果与付费报告（2026-11-21，基线 36e7c7a）

首个验收场景「面试学校后，接下来能顺利入职吗？」（小畜 → 贲，九二、九五动）。改版前后的输出、截图与人工检查见 `docs/round4/README.md`。

### G.0 采纳情况

| 建议 | 处理 | 说明 |
|---|---|---|
| 免费页顺序：问题 → 紧凑卦象 → 一段白话解读 → 解锁入口；卦图、爻辞、注释、出处默认折叠 | 采纳 | G.1 |
| 白话解读一个有原文依据的主旨，最多两句；主题提示与反思问题收敛成一条；免费页不调用模型 | 采纳 | 本地按选文规则取本次重点原文：原文第一句 + 白话里落到处境上的那一句；只保留主题提示 |
| 移动端首屏读到卦意、同屏一个主操作，解锁按钮说明买到什么 | 采纳 | 375 px 下卦意与按钮都在首屏；按钮"看针对这件事的行动方案 · 价格"，价格读当前报价 |
| 付费页先一句回应、再"下一步"；完整卦象与引用放进"为什么这样看"；追问、反馈、导出作为次级入口 | 采纳 | G.3 |
| 简版格式 takeaway / basis / next_step / 可空 artifact | 采纳 | 另保留 0–2 条追问建议（只用于追问入口的快捷选项） |
| 主文约 250 字、每条事实只写一次、用具体对象替代泛化标题 | 采纳并加确定性检查 | 主文超过 320 字、basis 重复同一原文时校验不通过并带反馈重试 |
| Prompt 给出明确卦意方向、只用用户事实、缺日期按条件输出、禁止编造进展与录用概率 | 采纳并加确定性检查 | 只靠 Prompt 不够：用户没给的日期、星期，以及"录用可能性很大"、百分比之类，校验器直接拒绝（`unsupported_date`、`probability`）。Prompt 里附上今天的日期，模型才能判断用户给的日期是否已过 |
| 只选真正支撑解读的原文 | 采纳并收紧 | 依据里至少一条必须是本次重点原文（动爻；无动爻时为本卦卦辞）。实测中 Luna 曾只引两卦卦辞、不引动爻，按这条规则会被拒绝重试 |
| 新格式版本区分，验证旧报告阅读、导出、追问；同步替身、校验与评测 | 采纳 | G.2 |
| 三种面试情形、同卦异题、375 px 检查、复制反馈、前后对比与 Luna/Sol 比较 | 采纳 | 评测用例固定题意（跳过分流），保证前后与模型之间输入一致 |
| 改版前后用同一模型对比 | 采纳 | 改版前先用 Sol 跑了旧格式基线（必须在改代码之前跑），改版后 Sol 与 Luna 各跑一遍；共花 US$0.08 |

### G.1 免费结果页

- `composeFreeReading` 新增 `gist`（本次重点原文的第一句、白话里落到处境上的那一句、是否初稿）与 `hint`（主题按观察角度的提示）。纯函数，问题文本不参与，不调用模型。
- 页面顺序：问题 →「小畜 → 贲 · 九二、九五动」一行摘要 → 卦意（"重点在「牵复，吉」：和志同道合的人相互提醒，一起回到正轨。"）与提示 → 主按钮 →「查看卦象与原文」（默认折叠：卦图、全部选文、白话、出处与繁体）。"修改问题或主题"降为文字链接。
- 样例页同步：免费部分用同样的结构；事业样例新增简版报告样例（`samples/career.yaml` 的 `concise`），也作为 Prompt 的示范。

### G.2 简版报告（report@2）

| 项 | 实现 |
|---|---|
| 结构 | `takeaway`（一句，≤ 70 字）、`next_step`（`trigger` 什么情况或时间点、`action` 对谁做什么、`signal` 怎样判断进展）、`basis`（1–2 条：原文编号 + 为什么支持这个判断；完整原文按编号从订单快照渲染）、`artifact`（可空：跟进消息、谈话开场或选择清单，用户没提供的细节用【】留空）、`followup_suggestions`（0–2） |
| Prompt | `report-prompt@3`：先给卦意方向再落到这件事；只用用户事实；没给日期写成条件；不写泛化标题；每条事实只写一次；主文 250 字以内。用户层附上今天的日期，并标出"本次重点"原文 |
| 校验 | `validator@2`：结构与字数；引用必须在本次允许范围内、至少一条是本次重点原文、不重复；主文 ≤ 320 字；禁用表述与错引（沿用）；日期、星期只能来自用户的问题、背景、确认的摘要与今天的日期；不给概率。追问也做日期与概率检查 |
| 版本 | `REPORT_SCHEMA_VERSION = report@2` 写进报告的 `versions.schema`；旧报告（`report@1`）原样读取、按旧版呈现并标"旧版报告"，可以打印导出、继续追问（追问结构不变） |
| 替身 | 生成能通过 v2 校验的演示报告；下一步按用户给的时间事实分"没给时间 / 给了还没到 / 已经过了"三种写法，不编日期 |
| 评测 | 指标改为：依据含本次重点原文、下一步可执行（有触发条件、具体动作、判断信号，且不是"准备蓄势"之类空话）、主文字数、带材料比例；人工评审表改为"直接回应问题 / 能照着做 / 没编造现实事实 / 引用支持解释"。用例新增三种面试情形与同卦异题，可用 `fixedTriage` 固定题意 |

### G.3 付费报告页

首屏：一句判断（大字）→「下一步」卡片（什么时候 / 做什么 / 怎么判断进展）→ 可复制材料（复制按钮：成功显示"✓ 已复制"并有文字提示；剪贴板被拒绝时退回选中复制，仍失败就自动选中文字、提示长按复制）→「为什么这样看」（默认折叠：卦象、每条依据的完整原文、解释、出处；打印时自动展开）→ 追问、导出 / 打印、删除、反馈作为次级入口。375 px 下第一屏能读完一句判断与整个"下一步"；页面高度从约 3000 px 降到约 1800 px。

### G.4 开发环境的两处调整

- `allowedDevOrigins: ["127.0.0.1"]`，开发环境的同源检查也接受与 Host 一致的 Origin（生产环境不变，只认 `APP_URL`）。这样可以在 `127.0.0.1` 与 `localhost` 并行打开两个独立的登录会话做验收。
- 注意：开发服务器里的后台任务（报告与追问生成）在启动时加载，**不随热更新替换**。改了报告生成、Prompt 或校验的代码后要重启开发服务器，否则新下的单仍按旧代码生成（本轮实测踩到过一次，页面能正确识别为旧版报告）。

### G.5 验证结果

| 检查 | 结果 |
|---|---|
| `npm run verify` | 通过：类型检查、内容一致性、测试（替身 + 临时 PostgreSQL 16）、生产构建、替身评测；业务失败 0 项，环境问题 0 项 |
| 全部测试 | 15 个文件、178 个测试全部通过（含 13 个真实 PostgreSQL 测试）。新增 `round4.test.ts` 8 个：卦意取本次重点原文且不超过两句、覆盖各卦与动爻数；简版报告的版本与引用渲染；三种情形把用户的时间事实与今天的日期送进 Prompt、规则在系统层；编造面试日期与录用把握的输出被拒绝并带反馈重试、交付内容里没有它们；简版报告可追问；旧版报告原样读取并可追问；开发环境的同源放宽只在非生产生效。`validate.test.ts` 新增日期、概率、篇幅、依据来源四类检查 |
| 真实模型（显式预算） | 改版前 Sol 4 份 US$0.0486；改版后 Sol 4 份 US$0.0291、Luna 4 份 US$0.0016；全部一次通过校验。对比见 `docs/round4/README.md` |
| 浏览器（375 px，`dev:test:llm`，Luna） | 免费页首屏读到卦意与提示、唯一主按钮在首屏（按钮底部 578 px / 812 px）；付费页首屏读完一句判断与整个下一步；展开"为什么这样看"显示原文、解释与出处；复制成功显示"✓ 已复制"，无焦点时的失败提示也正常；页面里追问一次得到回答，剩余次数减一；打印时折叠内容自动展开；旧版报告按旧版呈现并标"旧版报告"；无横向滚动 |

### G.6 仍待人工确认

- 改版前后与 Luna/Sol 的人工评审（`docs/round4/*.review.md`）：初评认为改版后三件事都更好，需要你确认；两处引申解释（Luna 对「富以其邻」的用法、反复出现的"请熟悉招聘的人帮忙"）请你判断。
- 线上报告模型：Luna 费用约为 Sol 的 1/18、质量接近但更泛；按 F.7 的规则，等人工贴合度结论后再决定是否切换，默认保持 Sol。
- 免费页的卦意来自白话注释初稿，注释审校完成前会标"注释初稿"。
