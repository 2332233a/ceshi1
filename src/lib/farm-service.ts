// 云服务数据访问层：区块 / 读数 / 预警 / 历史曲线的真实查询与上报触发。
// 页面层只依赖本模块导出的 Snapshot / HistoryPoint 契约，后续换后端实现不影响 UI。
import { decode } from "base64-arraybuffer";
import { supabase, supabaseAnonKey, supabaseUrl } from "@/supabase/client";
import type {
  AlertItem,
  BlockMedia,
  BlockStatus,
  Crop,
  FarmBlock,
  HistoryPoint,
  OverviewStats,
  PestLevel,
  Reading,
  Severity,
} from "./types";

export const COLS = ["A", "B", "C", "D", "E", "F"];
export const ROW_COUNT = 4;

/** 现场补拍素材存储桶（storage.buckets.id，平台 bucket ID 为 UUID，不能用 name） */
const MEDIA_BUCKET_ID = "9620eac6-2fd1-4376-a932-0c6547e2edf8";
/** 单文件大小上限 20MB，超出直接拒绝，避免浏览器长时间卡住 */
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

/** 作物适宜区间：与服务端生成器保持一致的展示元数据 */
export const CROPS: Record<string, Crop> = {
  corn: { id: "corn", name: "玉米", emoji: "🌽", range: { temp: [18, 30], humid: [55, 80] } },
  rice: { id: "rice", name: "水稻", emoji: "🌾", range: { temp: [20, 33], humid: [70, 92] } },
  wheat: { id: "wheat", name: "小麦", emoji: "🌿", range: { temp: [12, 26], humid: [45, 70] } },
  cotton: { id: "cotton", name: "棉花", emoji: "☁️", range: { temp: [20, 32], humid: [50, 75] } },
  cucumber: { id: "cucumber", name: "黄瓜", emoji: "🥒", range: { temp: [16, 30], humid: [60, 85] } },
};

/** 作物下拉选项（按 id 升序稳定展示） */
export const CROP_LIST: Crop[] = Object.values(CROPS);

interface BlockRow {
  id: string;
  row_idx: number;
  col_idx: number;
  crop_id: string;
  area_mu: number | string;
}

interface ReadingRow {
  block_id: string;
  temp: number | string;
  humid: number | string;
  has_pest: boolean;
  pest_code: string | null;
  pest_level: string | null;
  status: string;
  collected_at: string;
}

interface AlertRow {
  id: string;
  block_id: string;
  type: string;
  severity: string;
  message: string;
  resolved: boolean;
  created_at: string;
}

interface HistoryRow {
  block_id: string;
  temp: number | string;
  humid: number | string;
  bucket_at: string;
}

const num = (v: number | string): number => (typeof v === "number" ? v : Number(v));
const round1 = (n: number): number => Math.round(n * 10) / 10;

function toReading(row: ReadingRow): Reading {
  return {
    blockId: row.block_id,
    temp: round1(num(row.temp)),
    humid: round1(num(row.humid)),
    hasPest: row.has_pest,
    pestCode: row.pest_code ?? undefined,
    pestLevel: (row.pest_level as PestLevel | null) ?? undefined,
    collectedAt: row.collected_at,
    status: (row.status as BlockStatus) ?? "normal",
  };
}

function toAlert(row: AlertRow): AlertItem {
  return {
    id: row.id,
    blockId: row.block_id,
    type: row.type as AlertItem["type"],
    severity: row.severity as Severity,
    message: row.message,
    createdAt: row.created_at,
    resolved: row.resolved,
  };
}

export interface Snapshot {
  readings: Record<string, Reading>;
  alerts: AlertItem[];
  overview: OverviewStats;
  syncedAt: string;
}

function buildOverview(
  blocks: FarmBlock[],
  readings: Record<string, Reading>,
  alerts: AlertItem[] // 新增：传入预警列表
): OverviewStats {
  const valid = blocks.map((b) => readings[b.id]).filter((r): r is Reading => !!r && r.status !== "offline");
  const totalCount = blocks.length;
  if (valid.length === 0) {
    return {
      avgTemp: 0, avgHumid: 0,
      maxTemp: { value: 0, blockId: "—" }, minTemp: { value: 0, blockId: "—" },
      onlineCount: 0, totalCount, pestCount: 0, climateCount: 0,
    };
  }
  let max = valid[0];
  let min = valid[0];
  const sumT = valid.reduce((s, r) => s + r.temp, 0);
  const sumH = valid.reduce((s, r) => s + r.humid, 0);
  for (const r of valid) {
    if (r.temp > max.temp) max = r;
    if (r.temp < min.temp) min = r;
  }

  // ✅ 从预警数组统计
  const pestAlerts = alerts.filter(a => a.type === "pest");
  const climateAlerts = alerts.filter(a => ["temp_high","temp_low","humid_high","humid_low"].includes(a.type));

  return {
    avgTemp: round1(sumT / valid.length),
    avgHumid: round1(sumH / valid.length),
    maxTemp: { value: max.temp, blockId: max.blockId },
    minTemp: { value: min.temp, blockId: min.blockId },
    onlineCount: valid.length,
    totalCount,
    pestCount: pestAlerts.length,
    climateCount: climateAlerts.length,
  };
}

/** 区块布局（变化极少，进程内缓存一次） */
let blocksCache: FarmBlock[] | null = null;

export async function loadBlocks(): Promise<FarmBlock[]> {
  if (blocksCache) return blocksCache;
  const { data, error } = await supabase
    .from("farm_blocks")
    .select("id,row_idx,col_idx,crop_id,area_mu")
    .order("row_idx")
    .order("col_idx");
  if (error) throw new Error(`加载农田区块失败：${error.message}`);
  const rows = (data ?? []) as unknown as BlockRow[];
  blocksCache = rows.map((r) => ({
    id: r.id,
    row: r.row_idx,
    col: r.col_idx,
    cropId: r.crop_id,
    areaMu: num(r.area_mu),
  }));
  return blocksCache;
}

/** 最近一次同步快照：读数为真值，概览在前端按区块聚合 */
export async function fetchSnapshot(): Promise<Snapshot> {
  const blocks = await loadBlocks();
  const [readingRes, alertRes] = await Promise.all([
    supabase
      .from("sensor_readings")
      .select("block_id,temp,humid,has_pest,pest_code,pest_level,status,collected_at")
      .order("collected_at", { ascending: false }),
    supabase
      .from("alerts")
      .select("id,block_id,type,severity,message,resolved,created_at")
      .eq("resolved", false)
      .order("created_at", { ascending: false })
      .limit(60),
  ]);
  if (readingRes.error) throw new Error(`加载检测读数失败：${readingRes.error.message}`);
  if (alertRes.error) throw new Error(`加载预警数据失败：${alertRes.error.message}`);

  const readings: Record<string, Reading> = {};
  for (const row of (readingRes.data ?? []) as unknown as ReadingRow[]) {
    // 已按时间倒序，首次出现即该区块最新一条
    if (!readings[row.block_id]) readings[row.block_id] = toReading(row);
  }
  const alerts = ((alertRes.data ?? []) as unknown as AlertRow[]).map(toAlert);
  const syncedAt = Object.values(readings).reduce(
    (latest, r) => (r.collectedAt > latest ? r.collectedAt : latest),
    new Date().toISOString(),
  );

  return { readings, alerts, overview: buildOverview(blocks, readings, alerts), syncedAt };

}

/** 历史曲线单页行数上限（PostgREST 单次返回会被截断，长窗口必须分页） */
const HISTORY_PAGE = 5000;

/**
 * 按时间升序分页取回窗口内的全部历史行。
 * ⚠️ 每轮必须重新构造 query builder：supabase-js 的 PostgrestFilterBuilder 是 thenable，
 * 同一实例被 await 两次会抛 "Cannot parse a never resolved query builder"。
 */
async function fetchHistoryPage(blockId: string | null, sinceIso: string): Promise<HistoryRow[]> {
  const rows: HistoryRow[] = [];
  for (;;) {
    const build = () => {
      const selected = supabase.from("reading_history").select("block_id,temp,humid,bucket_at");
      const scoped = blockId ? selected.eq("block_id", blockId) : selected;
      return scoped
        .gte("bucket_at", sinceIso)
        .order("bucket_at", { ascending: true })
        .order("id", { ascending: true })
        .range(rows.length, rows.length + HISTORY_PAGE - 1);
    };
    const { data, error } = await build();
    if (error) throw new Error(`加载历史曲线失败：${error.message}`);
    const page = (data ?? []) as unknown as HistoryRow[];
    for (const r of page) rows.push(r);
    if (page.length < HISTORY_PAGE) break;
  }
  return rows;
}

/**
 * 目标点数：折线图横轴只有几十个像素刻度，逐小时全量既慢又无意义。
 * 按窗口长度自动选步长（≤24h 每小时、≤7天 每 2 小时、更长每 3 小时），保证点数可控且全程覆盖。
 */
function stepHoursFor(hours: number): number {
  if (hours <= 24) return 1;
  if (hours <= 168) return 2;
  return 3;
}

/** 把逐小时行按「区块 × 步长桶」压成均值点 */
function bucketRows(rows: HistoryRow[], stepHours: number): Map<string, Map<string, { ts: number; hs: number; n: number }>> {
  const out = new Map<string, Map<string, { ts: number; hs: number; n: number }>>();
  const stepMs = stepHours * 3_600_000;
  for (const r of rows) {
    const bucket = new Date(Math.floor(new Date(r.bucket_at).getTime() / stepMs) * stepMs).toISOString();
    let perBlock = out.get(r.block_id);
    if (!perBlock) {
      perBlock = new Map();
      out.set(r.block_id, perBlock);
    }
    const temp = round1(num(r.temp));
    const humid = round1(num(r.humid));
    const cur = perBlock.get(bucket);
    if (cur) {
      cur.ts += temp;
      cur.hs += humid;
      cur.n += 1;
    } else {
      perBlock.set(bucket, { ts: temp, hs: humid, n: 1 });
    }
  }
  return out;
}

/** 从已落库的全田整点气象构造「整点毫秒 → 气温/湿度」查找表 */
async function loadWeatherIndex(sinceIso: string): Promise<Map<number, { temp: number; humid: number }>> {
  const index = new Map<number, { temp: number; humid: number }>();
  const HOUR_MS = 3_600_000;
  for (;;) {
    const { data, error } = await supabase
      .from("farm_weather_hourly")
      .select("bucket_at,temp,humid")
      .gte("bucket_at", sinceIso)
      .order("bucket_at", { ascending: true })
      .range(index.size, index.size + HISTORY_PAGE - 1);
    if (error) throw new Error(`加载全田逐时气象失败：${error.message}`);
    const page = (data ?? []) as unknown as { bucket_at: string; temp: number | string; humid: number | string }[];
    for (const r of page) {
      index.set(Math.floor(new Date(r.bucket_at).getTime() / HOUR_MS) * HOUR_MS, {
        temp: round1(num(r.temp)),
        humid: round1(num(r.humid)),
      });
    }
    if (page.length < HISTORY_PAGE) break;
  }
  return index;
}

/** 区块微环境偏移：与云端派生器同一算法（FNV-1a 哈希 → 确定性伪随机），温度 ±1.2℃、湿度 ±4%RH */
function microOffset(blockId: string): { temp: number; humid: number } {
  let h = 2166136261;
  for (let i = 0; i < blockId.length; i++) {
    h ^= blockId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  const next = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { temp: round1((next() - 0.5) * 2.4), humid: round1((next() - 0.5) * 8) };
}

/** 离线区块不产生曲线点，与云端 buildHistoryRows 保持一致 */
const OFFLINE_BLOCKS = new Set(["F4"]);

/**
 * 用全田真实气象派生某区块的整段曲线点。
 * 数值口径与云端完全一致：气象整点值 + 该区块固定微偏移，不含任何随机成分。
 */
function deriveBlockPoints(
  blockId: string,
  index: Map<number, { temp: number; humid: number }>,
  fromMs: number,
  toMs: number,
  stepMs: number,
): HistoryPoint[] {
  if (OFFLINE_BLOCKS.has(blockId)) return [];
  const off = microOffset(blockId);
  const pts: HistoryPoint[] = [];
  const start = Math.ceil(fromMs / 3_600_000) * 3_600_000;
  for (let at = start; at <= toMs; at += stepMs) {
    const sample = index.get(at);
    if (!sample) continue;
    pts.push({
      t: new Date(at).toISOString(),
      temp: round1(sample.temp + off.temp),
      humid: Math.min(100, Math.max(0, round1(sample.humid + off.humid))),
    });
  }
  return pts;
}

/** 单区块历史曲线：优先读落库曲线；若该区块尚无落库数据则直接由全田气象派生，保证曲线完整 */
export async function fetchHistory(blockId: string, hours: number): Promise<HistoryPoint[]> {
  const sinceMs = Date.now() - hours * 3_600_000;
  const since = new Date(sinceMs).toISOString();
  const rows = await fetchHistoryPage(blockId, since);
  if (rows.length === 0) {
    const index = await loadWeatherIndex(since);
    return deriveBlockPoints(blockId, index, sinceMs, Date.now(), stepHoursFor(hours) * 3_600_000);
  }
  const perBlock = bucketRows(rows, stepHoursFor(hours)).get(blockId);
  if (!perBlock) return [];
  return Array.from(perBlock.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([t, v]) => ({ t, temp: round1(v.ts / v.n), humid: round1(v.hs / v.n) }));
}

/**
 * 全田平均曲线：短窗口直接按落库曲线分桶求均值；
 * 落库行数超过一页（说明窗口很长、逐小时全量拉取代价高）时，
 * 改为读取全田整点气象后按步长出点，彻底避开 PostgREST 截断导致的「只剩开头几天」。
 */
export async function fetchFieldHistory(hours: number): Promise<HistoryPoint[]> {
  const sinceMs = Date.now() - hours * 3_600_000;
  const since = new Date(sinceMs).toISOString();
  const rows = await fetchHistoryPage(null, since);

  if (rows.length >= HISTORY_PAGE) {
    const index = await loadWeatherIndex(since);
    const blocks = await loadBlocks();
    const merged = new Map<string, { ts: number; hs: number; n: number }>();
    const stepMs = stepHoursFor(hours) * 3_600_000;
    for (const b of blocks) {
      for (const p of deriveBlockPoints(b.id, index, sinceMs, Date.now(), stepMs)) {
        const key = p.t.slice(0, 13) + ":00:00";
        const cur = merged.get(key);
        if (cur) {
          cur.ts += p.temp;
          cur.hs += p.humid;
          cur.n += 1;
        } else {
          merged.set(key, { ts: p.temp, hs: p.humid, n: 1 });
        }
      }
    }
    return Array.from(merged.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([t, v]) => ({ t, temp: round1(v.ts / v.n), humid: round1(v.hs / v.n) }));
  }

  const buckets = new Map<string, { ts: number; hs: number; n: number }>();
  for (const [, perBlock] of bucketRows(rows, stepHoursFor(hours))) {
    for (const [bucket, v] of perBlock) {
      const cur = buckets.get(bucket);
      if (cur) {
        cur.ts += v.ts;
        cur.hs += v.hs;
        cur.n += v.n;
      } else {
        buckets.set(bucket, { ...v });
      }
    }
  }
  return Array.from(buckets.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([t, v]) => ({ t, temp: round1(v.ts / v.n), humid: round1(v.hs / v.n) }));
}

/** 预警历史（含已处理），按时间倒序 */
export async function fetchAlertHistory(hours: number, limit = 60): Promise<AlertItem[]> {
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  const { data, error } = await supabase
    .from("alerts")
    .select("id,block_id,type,severity,message,resolved,created_at")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`加载历史预警失败：${error.message}`);
  return ((data ?? []) as unknown as AlertRow[]).map(toAlert);
}

export interface DailyStat {
  date: string; // MM-DD
  avgTemp: number;
  maxTemp: number;
  minTemp: number;
  avgHumid: number;
  samples: number;
}

/** 东八区日历日 YYYY-MM-DD：历史数据按本地日归组，避免 UTC 切日导致跨天错位 */
function localDay(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 分页拉取 reading_history 指定时间窗口的全部行（PostgREST 单次上限会截断长窗口） */
async function fetchHistoryRows(sinceIso: string): Promise<HistoryRow[]> {
  const PAGE = 5000;
  const rows: HistoryRow[] = [];
  for (;;) {
    const { data, error } = await supabase
      .from("reading_history")
      .select("block_id,temp,humid,bucket_at")
      .gte("bucket_at", sinceIso)
      .order("bucket_at", { ascending: true })
      .order("id", { ascending: true })
      .range(rows.length, rows.length + PAGE - 1);
    if (error) throw new Error(`加载历史环境数据失败：${error.message}`);
    const page = (data ?? []) as unknown as (HistoryRow & { id?: number })[];
    for (const r of page) rows.push({ block_id: r.block_id, temp: r.temp, humid: r.humid, bucket_at: r.bucket_at });
    if (page.length < PAGE) break;
  }
  return rows;
}

/** 环境数据日统计：一次范围查询后按「区块 × 本地日」聚合，再汇总全田 */
export async function fetchDailyStats(days: number): Promise<DailyStat[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = await fetchHistoryRows(since);

  // key: 本地日期 -> 该日各区块均值累加器
  const perDay = new Map<string, Map<string, { ts: number; hs: number; n: number }>>();
  for (const r of rows) {
    const day = localDay(r.bucket_at);
    let blocks = perDay.get(day);
    if (!blocks) {
      blocks = new Map();
      perDay.set(day, blocks);
    }
    const temp = round1(num(r.temp));
    const humid = round1(num(r.humid));
    const cur = blocks.get(r.block_id);
    if (cur) {
      cur.ts += temp;
      cur.hs += humid;
      cur.n += 1;
    } else {
      blocks.set(r.block_id, { ts: temp, hs: humid, n: 1 });
    }
  }

  return Array.from(perDay.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, blocks]) => {
      const avgs = Array.from(blocks.values()).map((b) => ({
        temp: b.ts / b.n,
        humid: b.hs / b.n,
      }));
      const temps = avgs.map((a) => a.temp);
      return {
        date: day.slice(5),
        avgTemp: round1(temps.reduce((s, t) => s + t, 0) / temps.length),
        maxTemp: round1(Math.max(...temps)),
        minTemp: round1(Math.min(...temps)),
        avgHumid: round1(avgs.reduce((s, a) => s + a.humid, 0) / avgs.length),
        samples: blocks.size,
      };
    });
}

/** 通用 Edge Function 调用：统一携带项目头与登录凭证，返回解析后的 JSON */
async function callFunction<T extends Record<string, unknown>>(
  name: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const session = (await supabase.auth.getSession()).data.session;
  const response = await fetch(`${supabaseUrl}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: supabaseAnonKey,
      ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  const result = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new Error((result as { error?: string }).error ?? `请求失败（HTTP ${response.status}）`);
  }
  return result;
}

/** 触发一次设备上报（写入数据库，前端通过 Realtime 收到刷新） */
export async function triggerReport(
  payload: Record<string, unknown> = {},
): Promise<{ ok: boolean; readings: number; alerts: number; weatherAvailable?: boolean }> {
  const r = await callFunction<{
    ok?: boolean;
    readings?: number;
    alerts?: number;
    weatherAvailable?: boolean;
    error?: string;
  }>("report-tick", payload);
  if (!r.ok) throw new Error(r.error ?? "上报失败");
  return {
    ok: true,
    readings: r.readings ?? 0,
    alerts: r.alerts ?? 0,
    weatherAvailable: r.weatherAvailable,
  };
}

/** 修改区块种植作物（仅登录用户；适宜温湿度阈值随作物同步变化） */
export async function updateBlockCrop(
  blockId: string,
  cropId: string,
): Promise<{ ok: boolean; cropId: string }> {
  const session = (await supabase.auth.getSession()).data.session;
  if (!session) throw new Error("请先登录后再修改种植作物");

  // 写入只允许经云函数下发；update-block 未部署时给出明确提示，不静默失败
  let r: { ok?: boolean; cropId?: string; error?: string };
  try {
    r = await callFunction<{ ok?: boolean; cropId?: string; error?: string }>("update-block", {
      blockId,
      cropId,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "";
    if (/not find|404|invoke/i.test(msg)) {
      throw new Error("改种服务尚未部署，请在云服务中部署 update-block 后重试");
    }
    throw e;
  }
  if (!r.ok) throw new Error(r.error ?? "修改作物失败");
  invalidateBlocks();
  return { ok: true, cropId: r.cropId ?? cropId };
}

/** 清除区块缓存，供作物变更后强制下次读取最新布局 */
export function invalidateBlocks(): void {
  blocksCache = null;
}

interface MediaRow {
  id: string;
  block_id: string;
  file_path: string;
  kind: string;
  caption: string | null;
  size_bytes: number | string | null;
  created_at: string;
}

/** 素材公网地址（bucket 为 public，直接拼对象路径即可） */
function mediaPublicUrl(filePath: string): string {
  return `${supabaseUrl}/storage/v1/object/public/${MEDIA_BUCKET_ID}/${filePath}`;
}

/** 区块现场补拍素材（含存储桶内路径，供删除时精确定位对象） */
export interface BlockMediaItem extends BlockMedia {
  filePath: string;
}

/** 读取某区块的现场补拍素材，按上传时间倒序 */
export async function fetchBlockMedia(blockId: string): Promise<BlockMediaItem[]> {
  const { data, error } = await supabase
    .from("farm_block_media")
    .select("id,block_id,file_path,kind,caption,size_bytes,created_at")
    .eq("block_id", blockId)
    .order("created_at", { ascending: false })
    .limit(60);
  if (error) throw new Error(`加载现场素材失败：${error.message}`);
  return ((data ?? []) as unknown as MediaRow[]).map((r) => ({
    id: r.id,
    blockId: r.block_id,
    url: mediaPublicUrl(r.file_path),
    filePath: r.file_path,
    kind: r.kind === "video" ? "video" : "image",
    caption: r.caption,
    sizeBytes: r.size_bytes == null ? 0 : num(r.size_bytes),
    createdAt: r.created_at,
  }));
}

function fileToKind(file: File): "image" | "video" | null {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  return null;
}

async function readAsBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000; // 分块避免 String.fromCharCode 参数溢出
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * 上传现场补拍素材（仅登录用户）。
 * 逐个上传：单个失败不中断整批，返回成功数与失败原因列表。
 */
export async function uploadBlockMedia(
  blockId: string,
  files: File[],
  caption?: string,
): Promise<{ ok: number; failed: string[] }> {
  const session = (await supabase.auth.getSession()).data.session;
  if (!session) throw new Error("请先登录后再上传现场素材");

  const failed: string[] = [];
  let ok = 0;

  for (const file of files) {
    const kind = fileToKind(file);
    if (!kind) {
      failed.push(`${file.name}：仅支持图片或视频`);
      continue;
    }
    if (file.size > MAX_MEDIA_BYTES) {
      failed.push(`${file.name}：超过 20MB 上限`);
      continue;
    }

    const ext = (file.name.split(".").pop() ?? (kind === "video" ? "mp4" : "jpg")).toLowerCase();
    const path = `media/${blockId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

    try {
      const base64 = await readAsBase64(file);
      const { error: upErr } = await supabase.storage
        .from(MEDIA_BUCKET_ID)
        .upload(path, decode(base64), { contentType: file.type, upsert: false });
      if (upErr) {
        failed.push(`${file.name}：${upErr.message}`);
        continue;
      }
      const { error: insErr } = await supabase.from("farm_block_media").insert({
        block_id: blockId,
        file_path: path,
        kind,
        caption: caption?.trim() || null,
        size_bytes: file.size,
        created_by: session.user.id,
      });
      if (insErr) {
        // 元数据写失败时顺手删掉已上传对象，避免留下孤儿文件
        await supabase.storage.from(MEDIA_BUCKET_ID).remove([path]);
        failed.push(`${file.name}：记录写入失败（${insErr.message}）`);
        continue;
      }
      ok += 1;
    } catch (e: unknown) {
      failed.push(`${file.name}：${e instanceof Error ? e.message : "上传异常"}`);
    }
  }

  return { ok, failed };
}

/** 删除一条现场素材（存储对象 + 元数据行；仅登录用户） */
export async function deleteBlockMedia(id: string, filePath: string): Promise<void> {
  const session = (await supabase.auth.getSession()).data.session;
  if (!session) throw new Error("请先登录后再删除素材");

  const { error: rmErr } = await supabase.storage.from(MEDIA_BUCKET_ID).remove([filePath]);
  if (rmErr) throw new Error(`删除文件失败：${rmErr.message}`);
  const { error: delErr } = await supabase.from("farm_block_media").delete().eq("id", id);
  if (delErr) throw new Error(`删除记录失败：${delErr.message}`);
}

export interface FieldWeatherDay {
  date: string; // YYYY-MM-DD
  avgTemp: number;
  maxTemp: number;
  minTemp: number;
  avgHumid: number;
}

export interface FieldWeather {
  /** 最近一次气象采集时刻（ISO）；为 null 表示云端尚未拿到任何真实气象数据 */
  observedAt: string | null;
  source: string;
  station: string;
  /** 当前实况（逐时表最新一行） */
  now: { temp: number; humid: number } | null;
  /** 今日逐日聚合（平均气温 / 最低最高气温 / 平均湿度） */
  today: FieldWeatherDay | null;
  /** 按日期升序的全部逐日记录 */
  days: FieldWeatherDay[];
}

interface WeatherDailyRow {
  day_date: string;
  avg_temp: number | string;
  max_temp: number | string;
  min_temp: number | string;
  avg_humid: number | string;
  source: string;
  station: string;
  updated_at: string;
}

interface WeatherHourlyRow {
  bucket_at: string;
  temp: number | string;
  humid: number | string;
  source: string;
  station: string;
}

/** 全田真实气象：只读云端已落库的数据，不做任何前端补数 */
export async function fetchFieldWeather(days = 30): Promise<FieldWeather> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const [dailyRes, hourlyRes] = await Promise.all([
    supabase
      .from("farm_weather_daily")
      .select("day_date,avg_temp,max_temp,min_temp,avg_humid,source,station,updated_at")
      .gte("day_date", since.slice(0, 10))
      .order("day_date", { ascending: true })
      .limit(60),
    supabase
      .from("farm_weather_hourly")
      .select("bucket_at,temp,humid,source,station")
      .gte("bucket_at", since)
      .order("bucket_at", { ascending: false })
      .limit(1),
  ]);
  if (dailyRes.error) throw new Error(`加载全田气象失败：${dailyRes.error.message}`);
  if (hourlyRes.error) throw new Error(`加载全田实况失败：${hourlyRes.error.message}`);

  const dailyRows = (dailyRes.data ?? []) as unknown as WeatherDailyRow[];
  const list: FieldWeatherDay[] = dailyRows.map((r) => ({
    date: r.day_date,
    avgTemp: round1(num(r.avg_temp)),
    maxTemp: round1(num(r.max_temp)),
    minTemp: round1(num(r.min_temp)),
    avgHumid: round1(num(r.avg_humid)),
  }));
  const latest = (hourlyRes.data ?? [])[0] as WeatherHourlyRow | undefined;
  const todayDate = localDay(new Date().toISOString());
  const row = dailyRows[dailyRows.length - 1];

  return {
    observedAt: latest?.bucket_at ?? row?.updated_at ?? null,
    source: latest?.source ?? row?.source ?? "",
    station: latest?.station ?? row?.station ?? "",
    now: latest ? { temp: round1(num(latest.temp)), humid: round1(num(latest.humid)) } : null,
    today: list.find((d) => d.date === todayDate) ?? null,
    days: list,
  };
}

/** 触发一次全田气象采集（写入云端气象表；游客不可调用） */
export async function triggerWeather(): Promise<{ ok: boolean; station: string }> {
  const r = await callFunction<{ ok?: boolean; station?: string; error?: string }>("weather-tick", {});
  if (!r.ok) throw new Error(r.error ?? "气象采集失败");
  return { ok: true, station: r.station ?? "" };
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  return `${Math.floor(hr / 24)} 天前`;
}

// ========== AI识别结果回写：标记区块病虫害状态 ==========
/**
 * 模型8类 → 图鉴6个pest_code映射
 */
const CLASS_TO_PEST_CODE: Record<string, string> = {
  powdery_mildew: "rust",
  wheat_rust: "rust",
  fusarium_head_blight: "blast",
  wheat_aphid: "aphid",
  wheat_red_mite: "mite",
  locust: "caterpillar",
  cotton_aphid: "aphid",
  cotton_bollworm: "caterpillar",
};

/** confidence → pest_level */
function confidenceToLevel(conf: number): "low" | "medium" | "high" {
  if (conf >= 0.7) return "high";
  if (conf >= 0.5) return "medium";
  return "low";
}

/**
 * AI识别成功后，把结果回写到 sensor_readings，让区块网格变红、预警流出现
 * 找到该区块最新一行读数，UPDATE 病虫害字段
 */
export async function markBlockPest(
  blockId: string,
  detections: Array<{ class_name: string; confidence: number }>,
): Promise<void> {
  if (!detections || detections.length === 0) return;
  // 取置信度最高的目标
  const top = detections.reduce((a, b) => (b.confidence > a.confidence ? b : a));
  // 直接使用模型输出类别，不再走映射表
  const pestCode = top.class_name;
  const pestLevel = confidenceToLevel(top.confidence);
  // 查询该区块最新一条 sensor_readings
  const { data: rows, error: qErr } = await supabase
    .from("sensor_readings")
    .select("id")
    .eq("block_id", blockId)
    .order("collected_at", { ascending: false })
    .limit(1);

  if (qErr) throw new Error(`查询读数失败: ${qErr.message}`);
  if (!rows || rows.length === 0) throw new Error("该区块暂无读数，无法标记病虫害");
  const latestId = rows[0].id;

  // 直接写对象，删掉 Record<string, unknown>，TS类型自动匹配
  const updatePayload = {
    has_pest: true,
    pest_code: pestCode,
    pest_level: pestLevel,
    status: "pest",
  };

  const { error: uErr } = await supabase
    .from("sensor_readings")
    .update(updatePayload)
    .eq("id", latestId);

  if (uErr) throw new Error(`回写病虫害状态失败: ${uErr.message}`);
  console.log(`✅ 已回写区块 ${blockId} → pest_code=${pestCode ?? "未知"}, level=${pestLevel}`);
}
