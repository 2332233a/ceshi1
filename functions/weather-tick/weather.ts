// 全田气象数据：从 Open-Meteo 公开气象接口获取逐时气温与相对湿度，供区块读数派生使用。
// 说明：本模块只产出「真实气象」字段（平均/最高/最低气温、平均湿度），不含任何随机成分。
// 接口：https://api.open-meteo.com/v1/forecast
//   ?latitude=..&longitude=..&daily=temperature_2m_max,temperature_2m_min
//   &hourly=temperature_2m,relative_humidity_2m
//   &current=temperature_2m,relative_humidity_2m&timezone=auto&past_days=31

export interface WeatherHour {
  /** ISO 字符串，整点 */
  at: string;
  temp: number;
  humid: number;
}

export interface WeatherDay {
  /** YYYY-MM-DD */
  date: string;
  avgTemp: number;
  maxTemp: number;
  minTemp: number;
  avgHumid: number;
  hours: WeatherHour[];
}

export interface FieldWeather {
  /** 数据来源标识 */
  source: string;
  /** 站点描述 */
  station: string;
  /** 采集时刻 ISO */
  observedAt: string;
  /** 今日实况（当前时刻的气温/湿度） */
  now: { temp: number; humid: number };
  /** 按日期升序的逐日数据；含 past_days 回溯的历史日与今日之后的预报日 */
  days: WeatherDay[];
}

/** 农田中心点坐标（浙江湖州德清一带），可用同名环境变量覆盖 */
const DEFAULT_LATITUDE = "30.2639";
const DEFAULT_LONGITUDE = "119.7172";
/** 回溯天数，与前端「近 30 天」口径对齐 */
const PAST_DAYS = 31;

const SOURCE_NAME = "open-meteo";

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

interface OpenMeteoPayload {
  current?: { temperature_2m?: number | string; relative_humidity_2m?: number | string };
  hourly?: {
    time?: string[];
    temperature_2m?: (number | string | null)[];
    relative_humidity_2m?: (number | string | null)[];
  };
  daily?: {
    time?: string[];
    temperature_2m_max?: (number | string | null)[];
    temperature_2m_min?: (number | string | null)[];
  };
  timezone?: string;
  utc_offset_seconds?: number;
  latitude?: number;
  longitude?: number;
}

/** 把 "2026-10-01T13:00"（站点本地时间）转成 UTC ISO。 */
function localToUtcIso(local: string, offsetSeconds: number): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(local)) return null;
  const ms = Date.parse(`${local.slice(0, 16)}:00Z`);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms - offsetSeconds * 1000).toISOString();
}

async function fetchOpenMeteo(lat: string, lon: string): Promise<FieldWeather> {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    daily: "temperature_2m_max,temperature_2m_min",
    hourly: "temperature_2m,relative_humidity_2m",
    current: "temperature_2m,relative_humidity_2m",
    timezone: "auto",
    past_days: String(PAST_DAYS),
  });
  const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`气象源返回 HTTP ${res.status}`);
  const payload = (await res.json()) as OpenMeteoPayload;

  const offsetSeconds = Number.isFinite(payload.utc_offset_seconds) ? (payload.utc_offset_seconds as number) : 0;

  const nowTemp = num(payload.current?.temperature_2m);
  const nowHumid = num(payload.current?.relative_humidity_2m);
  if (!Number.isFinite(nowTemp) || !Number.isFinite(nowHumid)) {
    throw new Error("气象源未返回可用的实况温湿度");
  }

  // 逐时序列：按站点本地时间戳归到「日期 + 整点」，缺失值直接跳过该小时
  const byDate = new Map<string, WeatherHour[]>();
  const times = payload.hourly?.time ?? [];
  for (let i = 0; i < times.length; i++) {
    const temp = num(payload.hourly?.temperature_2m?.[i]);
    const humid = num(payload.hourly?.relative_humidity_2m?.[i]);
    if (!Number.isFinite(temp) || !Number.isFinite(humid)) continue;
    const at = localToUtcIso(times[i], offsetSeconds);
    if (!at) continue;
    const date = times[i].slice(0, 10);
    const list = byDate.get(date) ?? [];
    list.push({ at, temp: round1(temp), humid: round1(humid) });
    byDate.set(date, list);
  }

  const avgOf = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const days: WeatherDay[] = [];
  const dailyTime = payload.daily?.time ?? [];
  for (let i = 0; i < dailyTime.length; i++) {
    const date = dailyTime[i];
    const hours = (byDate.get(date) ?? []).sort((a, b) => a.at.localeCompare(b.at));
    if (hours.length === 0) continue;
    const maxTemp = num(payload.daily?.temperature_2m_max?.[i]);
    const minTemp = num(payload.daily?.temperature_2m_min?.[i]);
    days.push({
      date,
      avgTemp: round1(avgOf(hours.map((h) => h.temp))),
      maxTemp: round1(Number.isFinite(maxTemp) ? maxTemp : Math.max(...hours.map((h) => h.temp))),
      minTemp: round1(Number.isFinite(minTemp) ? minTemp : Math.min(...hours.map((h) => h.temp))),
      avgHumid: round1(avgOf(hours.map((h) => h.humid))),
      hours,
    });
  }
  if (days.length === 0) throw new Error("气象源未返回逐日数据");

  const tz = payload.timezone;
  const station = tz ? `${tz} (${lat}, ${lon})` : `${lat}, ${lon}`;

  return {
    source: SOURCE_NAME,
    station,
    observedAt: new Date().toISOString(),
    now: { temp: round1(nowTemp), humid: round1(nowHumid) },
    days: days.sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/**
 * 获取全田气象数据。
 * 数据源为免密钥的 Open-Meteo forecast 接口（含 past_days 回溯）；
 * 若后续换用需要密钥的气象服务，在此追加分支并用 Deno.env.get("WEATHER_API_KEY") 读取密钥即可，调用方无需改动。
 */
export async function fetchFieldWeather(): Promise<FieldWeather> {
  const lat = Deno.env.get("FARM_WEATHER_LATITUDE") || DEFAULT_LATITUDE;
  const lon = Deno.env.get("FARM_WEATHER_LONGITUDE") || DEFAULT_LONGITUDE;
  return fetchOpenMeteo(lat, lon);
}

/** 把逐时气象摊平成「小时起点 → 气温/湿度」查找表，便于按任意时刻插值 */
export function indexWeather(weather: FieldWeather): Map<number, WeatherHour> {
  const map = new Map<number, WeatherHour>();
  for (const d of weather.days) for (const h of d.hours) map.set(new Date(h.at).getTime(), h);
  return map;
}

/**
 * 取某时刻的气象值：命中整点直接用，否则在前后两个采样点间线性插值。
 * 超出数据覆盖范围时返回 null —— 调用方据此跳过该时刻，不做任何猜测性填充。
 */
export function sampleWeather(
  index: Map<number, WeatherHour>,
  atMs: number,
  maxGapMs = 6 * 3_600_000,
): { temp: number; humid: number } | null {
  const HOUR = 3_600_000;
  const lo = Math.floor(atMs / HOUR) * HOUR;
  const keys = [lo - 3 * HOUR, lo - 2 * HOUR, lo - HOUR, lo, lo + HOUR, lo + 2 * HOUR, lo + 3 * HOUR];
  const pts = keys
    .map((k) => ({ k, v: index.get(k) }))
    .filter((p): p is { k: number; v: WeatherHour } => !!p.v && Math.abs(p.k - atMs) <= maxGapMs)
    .sort((a, b) => Math.abs(a.k - atMs) - Math.abs(b.k - atMs));
  if (pts.length === 0) return null;
  if (pts.length === 1) return { temp: pts[0].v.temp, humid: pts[0].v.humid };

  const before = pts.filter((p) => p.k <= atMs).pop();
  const after = pts.find((p) => p.k >= atMs);
  if (!before || !after || after.k === before.k) {
    const v = before ?? after!;
    return { temp: v.v.temp, humid: v.v.humid };
  }
  const ratio = (atMs - before.k) / (after.k - before.k);
  return {
    temp: round1(before.v.temp + (after.v.temp - before.v.temp) * ratio),
    humid: round1(before.v.humid + (after.v.humid - before.v.humid) * ratio),
  };
}
