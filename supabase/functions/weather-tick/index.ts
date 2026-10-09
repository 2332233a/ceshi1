// 全田真实气象 API：拉取 Open-Meteo → 写入 farm_weather（逐日 + 整点序列）→ 重建区块历史曲线。
// 允许匿名只读调用；写入走 service_role，绕开「仅 authenticated 可写」的前端 RLS。
// 拿不到气象数据时不写库、直接返回错误，绝不凭空补数。
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { fetchFieldWeather, indexWeather, type WeatherDay } from "./weather.ts";
import { buildHistoryRows, type BlockRow } from "./generator.ts";

const functionName = "weather-tick";

/** 历史曲线重建回溯天数：与气象 past_days=31、前端「近 30 天」口径一致 */
const REBUILD_DAYS = 31;

interface DayRow {
  day_date: string;
  avg_temp: number;
  max_temp: number;
  min_temp: number;
  avg_humid: number;
  source: string;
  station: string;
  updated_at: string;
}

interface HourRow {
  bucket_at: string;
  temp: number;
  humid: number;
  source: string;
  station: string;
  updated_at: string;
}

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID().slice(0, 8);
  const headers = { "Content-Type": "application/json" };

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) {
      throw new Error("缺少 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 环境变量");
    }

    // 气象写入由服务身份完成，前端与游客都只有读取权限
    const supabase = createClient(supabaseUrl, serviceKey);

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

    const nowIso = new Date().toISOString();
    const dayRows: DayRow[] = weather.days.map((d: WeatherDay) => ({
      day_date: d.date,
      avg_temp: d.avgTemp,
      max_temp: d.maxTemp,
      min_temp: d.minTemp,
      avg_humid: d.avgHumid,
      source: weather.source,
      station: weather.station,
      updated_at: nowIso,
    }));

    // 逐时表：写入 Open-Meteo 的真实整点序列（含过去回溯），不再只落当前小时一行。
    // 只保留「不晚于采集时刻」的整点，未来预报小时不进实况表。
    const HOUR_MS = 3_600_000;
    const observedMs = Date.parse(weather.observedAt);
    const seen = new Set<string>();
    const hourRows: HourRow[] = [];
    for (const d of weather.days) {
      for (const h of d.hours) {
        const bucket = new Date(Math.floor(Date.parse(h.at) / HOUR_MS) * HOUR_MS).toISOString();
        if (Date.parse(bucket) > observedMs) continue;
        if (seen.has(bucket)) continue;
        seen.add(bucket);
        hourRows.push({
          bucket_at: bucket,
          temp: h.temp,
          humid: h.humid,
          source: weather.source,
          station: weather.station,
          updated_at: nowIso,
        });
      }
    }
    // 兜底：整点序列为空时至少写入当前实况
    if (hourRows.length === 0) {
      hourRows.push({
        bucket_at: new Date(Math.floor(observedMs / HOUR_MS) * HOUR_MS).toISOString(),
        temp: weather.now.temp,
        humid: weather.now.humid,
        source: weather.source,
        station: weather.station,
        updated_at: nowIso,
      });
    }
    hourRows.sort((a, b) => a.bucket_at.localeCompare(b.bucket_at));

    const { error: dayError } = await supabase.from("farm_weather_daily").upsert(dayRows, {
      onConflict: "day_date",
    });
    if (dayError) throw new Error(`写入逐日气象失败: ${dayError.message}`);

    const { error: hourError } = await supabase.from("farm_weather_hourly").upsert(hourRows, {
      onConflict: "bucket_at",
    });
    if (hourError) throw new Error(`写入逐时气象失败: ${hourError.message}`);

    console.info(
      `[${functionName}] success ${requestId} days=${dayRows.length} hours=${hourRows.length} station=${weather.station} temp=${weather.now.temp} humid=${weather.now.humid}`,
    );

    // 区块历史曲线重建：整段以 Open-Meteo 真实气象重算，替换旧的随机/异源数据。
    // 失败只记录并降级返回，不影响气象本身已写入的结果。
    let historyRebuilt = 0;
    let historyError: string | null = null;
    try {
      const { data: blocks, error: blockError } = await supabase
        .from("farm_blocks")
        .select("id,row_idx,col_idx,crop_id,area_mu");
      if (blockError) throw new Error(`读取区块失败: ${blockError.message}`);
      const blockRows = (blocks ?? []) as unknown as BlockRow[];
      if (blockRows.length > 0) {
        const fromMs = observedMs - REBUILD_DAYS * 86_400_000;
        const rows = buildHistoryRows(blockRows, indexWeather(weather), fromMs, observedMs);

        const { error: purgeError } = await supabase
          .from("reading_history")
          .delete()
          .gte("bucket_at", new Date(fromMs).toISOString());
        if (purgeError) throw new Error(`清理旧历史曲线失败: ${purgeError.message}`);

        const chunkSize = 500;
        for (let i = 0; i < rows.length; i += chunkSize) {
          const chunk = rows.slice(i, i + chunkSize);
          const { error: insertError } = await supabase.from("reading_history").insert(chunk);
          if (insertError) throw new Error(`写入历史曲线失败: ${insertError.message}`);
          historyRebuilt += chunk.length;
        }
      }
    } catch (e) {
      historyError = e instanceof Error ? e.message : String(e);
      console.warn(`[${functionName}] request ${requestId} history rebuild skipped: ${historyError}`);
    }

    return new Response(
      JSON.stringify({
        ok: true,
        weatherAvailable: true,
        source: weather.source,
        station: weather.station,
        observedAt: weather.observedAt,
        now: weather.now,
        today: dayRows.find((d) => d.day_date === nowIso.slice(0, 10)) ?? null,
        days: dayRows,
        historyRebuilt,
        historyError,
      }),
      { headers },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[${functionName}] failed ${requestId}: ${message}`);
    return new Response(JSON.stringify({ error: message }), { status: 500, headers });
  }
});
