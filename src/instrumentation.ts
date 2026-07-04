// Next runs register() once on server startup. We use it to boot the in-process
// scheduler (the cron) — only on the Node.js runtime, only when AUTO_TICK=true.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startScheduler } = await import("./lib/scheduler.js");
    startScheduler();
  }
}
