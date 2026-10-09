// 智能决策建议：读取各区块最新读数与未处理预警，返回处置决策列表。
// 分析模型尚未接入，当前按用户要求返回空置列表（decisions: []），保留完整入参校验与鉴权链路。
// 游客模式为只读身份（无 Supabase session）：本函数只做数据读取，允许匿名调用；
// 任何写操作仍由 report-tick 承担，并保持登录校验。
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const functionName = "decision";

interface DecisionOut {
  id: string;
  block_id?: string;
  title: string;
  detail: string;
  priority: "low" | "medium" | "high";
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID().slice(0, 8);

  if (req.method !== "POST") {
    return json({ ok: false, error: "仅支持 POST 请求" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const authHeader = req.headers.get("Authorization");

  if (!supabaseUrl || !anonKey) {
    console.error(`[${functionName}] missing env ${requestId}`);
    return json({ ok: false, error: "服务未正确配置，缺少必要环境变量" }, 500);
  }

  // 有 Authorization 时校验登录态（真实账号）；游客为只读身份、无 session，允许匿名读取分析结果。
  const supabase = createClient(supabaseUrl, anonKey, {
    global: authHeader ? { headers: { Authorization: authHeader } } : undefined,
  });

  if (authHeader) {
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user) {
      console.warn(`[${functionName}] unauthorized ${requestId}`);
      return json({ ok: false, error: "登录状态已失效，请重新登录" }, 401);
    }
  } else {
    console.info(`[${functionName}] anonymous read-only ${requestId}`);
  }

  try {
    // 拉取真实数据用于后续分析（当前仅统计规模，不参与决策生成）
    const [{ count: readingCount }, { count: alertCount }] = await Promise.all([
      supabase.from("sensor_readings").select("id", { count: "exact", head: true }),
      supabase.from("alerts").select("id", { count: "exact", head: true }).eq("resolved", false),
    ]);

    const decisions: DecisionOut[] = [];

    console.info(
      `[${functionName}] success ${requestId} readings=${readingCount ?? 0} alerts=${alertCount ?? 0} decisions=0`,
    );

    return json({
      ok: true,
      decisions,
      generatedAt: new Date().toISOString(),
      note: "决策分析能力尚未接入，当前返回空列表",
      scope: { readings: readingCount ?? 0, openAlerts: alertCount ?? 0 },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[${functionName}] failed ${requestId}: ${message}`);
    return json({ ok: false, error: message }, 500);
  }
});
