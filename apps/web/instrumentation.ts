/** Next.js 服务启动时调用一次：配置校验与后台任务都在 server/startup.ts（只在 Node.js 运行时加载） */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startup } = await import("./server/startup");
  await startup();
}
