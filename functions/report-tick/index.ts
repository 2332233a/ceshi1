// 田间传感器设备的一次上报：先取全田真实气象，再按区块派生读数、历史曲线与预警写入数据库。
// 仅登录用户可调用（JWT），数据以真实行写入，前端通过 Realtime 感知刷新。
// 拿不到气象数据时不生成任何区块读数，直接返回 weatherAvailable:false。
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { fetchFieldWeather, indexWeather, sampleWeather } from "./weather.ts";
import { buildAlerts, historyPoint, makeReading, type BlockRow } from "./generator.ts";

const functionName = "report-tick";

interface TickPayload {
  backfillDays?: number;
}

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID().slice(0, 8);
  const headers = { "Content-Type": "application/json" };

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      console.error(`[${functionName}] request ${requestId} missing Authorization`);
      return new Response(JSON.stringify({ error: "未登录，无法触发上报" }), { status: 401, headers });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    if (!supabaseUrl || !anonKey) {
      throw new Error("缺少 SUPABASE_URL / SUPABASE_ANON_KEY 环境变量");
    }

    // 以调用者身份读写，遵守 RLS（写入策略限定 authenticated）
    const supabase = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (authError || !authData.user) {
      console.warn(`[${functionName}] request ${requestId} invalid session: ${authError?.message}`);
      return new Response(JSON.stringify({ error: "登录状态无效，请重新登录" }), { status: 401, headers });
    }

    let payload: TickPayload = {};
    if (req.method === "POST") {
      try {
        payload = (await req.json()) as TickPayload;
      } catch {
        payload = {};
      }
    }

    const now = new Date();

    // 1. 全田真实气象：失败即中止，绝不凭空补数
    let weather;
    try {
      weather = await fetchFieldWeather();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[${functionName}] request ${requestId} weather unavailable: ${msg}`);
      return new Response(
        JSON.stringify({ ok: false, weatherAvailable: false, error: `获取气象数据失败：${msg}` }),
        { status: 502, headers },
      );
    }
    const weatherIndex = indexWeather(weather);
    const nowSample = sampleWeather(weatherIndex, now.getTime());
    console.info(
      `[${functionName}] request ${requestId} source=${weather.source} days=${weather.days.length} temp=${nowSample?.temp} humid=${nowSample?.humid}`,
    );

    const { data: blocks, error: blockError } = await supabase
      .from("farm_blocks")
      .select("id,row_idx,col_idx,crop_id,area_mu");
    if (blockError) throw new Error(`读取区块失败: ${blockError.message}`);
    if (!blocks || blocks.length === 0) throw new Error("农田区块为空，请先初始化区块数据");
    const blockRows = blocks as unknown as BlockRow[];

    // 2. 当前轮次读数：无气象采样的区块直接跳过
    const readings = blockRows
      .map((b) => makeReading(b, now, nowSample))
      .filter((r): r is NonNullable<typeof r> => r !== null);

    if (readings.length === 0) {
      return new Response(
        JSON.stringify({ ok: false, weatherAvailable: false, error: "气象数据未覆盖当前时刻，本轮不生成区块数据" }),
        { status: 502, headers },
      );
    }

    // 3. 每个区块保留最近一条读数，保证「最近上报」语义
    const { error: deleteReadingsError } = await supabase.from("sensor_readings").delete().neq("collected_at", now.toISOString());
    if (deleteReadingsError) throw new Error(`清理旧读数失败: ${deleteReadingsError.message}`);

    const { data: inserted, error: insertError } = await supabase.from("sensor_readings").insert(readings).select("id");
    if (insertError) throw new Error(`写入读数失败: ${insertError.message}`);
    if (!inserted || inserted.length === 0) throw new Error("读数写入被 RLS 策略拦截");

    // 4. 预警：先清空本轮再重建，避免重复堆积
    const alerts = buildAlerts(blockRows, readings, now);
    const { error: deleteAlertsError } = await supabase.from("alerts").delete().eq("resolved", false);
    if (deleteAlertsError) throw new Error(`清理旧预警失败: ${deleteAlertsError.message}`);

    if (alerts.length > 0) {
      const { error: alertInsertError } = await supabase.from("alerts").insert(alerts);
      if (alertInsertError) throw new Error(`写入预警失败: ${alertInsertError.message}`);
    }

    // 5. 历史曲线回灌：逐小时取真实气象采样，气象未覆盖的小时跳过
    let historyWritten = 0;
    const backfillDays = Number.isFinite(payload.backfillDays) ? Math.trunc(payload.backfillDays as number) : 0;
    if (backfillDays > 0) {
      const rows: { block_id: string; temp: number; humid: number; bucket_at: string }[] = [];
      for (let h = backfillDays * 24; h >= 0; h--) {
        const at = new Date(now.getTime() - h * 3_600_000);
        const sample = sampleWeather(weatherIndex, at.getTime());
        if (!sample) continue;
        for (const b of blockRows) {
          const pt = historyPoint(b.id, sample);
          if (!pt) continue;
          rows.push({ block_id: b.id, temp: pt.temp, humid: pt.humid, bucket_at: at.toISOString() });
        }
      }
      const chunkSize = 500;
      for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        const { error: histError } = await supabase.from("reading_history").insert(chunk);
        if (histError) throw new Error(`写入历史曲线失败: ${histError.message}`);
        historyWritten += chunk.length;
      }
    }

    console.info(`[${functionName}] success ${requestId} readings=${readings.length} alerts=${alerts.length} history=${historyWritten}`);
    return new Response(
      JSON.stringify({
        ok: true,
        weatherAvailable: true,
        weather: { source: weather.source, station: weather.station, observedAt: weather.observedAt },
        readings: readings.length,
        alerts: alerts.length,
        historyWritten,
      }),
      { headers },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[${functionName}] failed ${requestId}: ${message}`);
    return new Response(JSON.stringify({ error: message }), { status: 500, headers });
  }
});
