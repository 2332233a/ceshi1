// 农田读数派生器（服务端）：区块温湿度一律基于「全田真实气象」派生，不再独立随机生成。
// 唯一允许的扰动是确定性的微环境偏移量（按区块 ID 哈希得到、跨轮次稳定），代表地块朝向/墒情差异；
// 一旦拿不到某时刻的气象数据，本模块直接返回 null —— 调用方必须跳过该区块，不得凭空补数。

export interface BlockRow {
  id: string;
  row_idx: number;
  col_idx: number;
  crop_id: string;
  area_mu: number | string;
}

export interface CropSpec {
  name: string;
  temp: [number, number];
  humid: [number, number];
}

export const CROPS: Record<string, CropSpec> = {
  corn: { name: "玉米", temp: [18, 30], humid: [55, 80] },
  rice: { name: "水稻", temp: [20, 33], humid: [70, 92] },
  wheat: { name: "小麦", temp: [12, 26], humid: [45, 70] },
  cotton: { name: "棉花", temp: [20, 32], humid: [50, 75] },
  cucumber: { name: "黄瓜", temp: [16, 30], humid: [60, 85] },
};

/** 固定注入的异常区块，保证监测场景稳定可见 */
export const PEST_BLOCKS: Record<string, { code: string; level: string }> = {
  C2: { code: "rust", level: "high" },
  E3: { code: "mite", level: "medium" },
  B4: { code: "aphid", level: "low" },
};
export const OFFLINE_BLOCKS = new Set(["F4"]);

export type BlockStatus = "normal" | "climate" | "pest" | "offline";

/** 病虫害为设备检出结果，与气象无关，仍由固定档案决定 */
export function statusOf(blockId: string): BlockStatus {
  if (OFFLINE_BLOCKS.has(blockId)) return "offline";
  if (PEST_BLOCKS[blockId]) return "pest";
  return "normal";
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * 区块相对全田气象的微环境偏移量（确定性，非每轮重掷）。
 * 温度 ±1.2℃、湿度 ±4%RH，量级参考大田实测的地块间差异。
 */
export function microOffset(blockId: string): { temp: number; humid: number } {
  const r = rng(hashStr(blockId));
  return { temp: round1((r() - 0.5) * 2.4), humid: round1((r() - 0.5) * 8) };
}

/** 某时刻的全田气象输入；缺失时调用方不应生成读数 */
export interface WeatherAt {
  temp: number;
  humid: number;
}

export interface ReadingOut {
  block_id: string;
  temp: number;
  humid: number;
  has_pest: boolean;
  pest_code: string | null;
  pest_level: string | null;
  status: BlockStatus;
  collected_at: string;
}

/**
 * 单区块读数 = 该时刻全田真实气象 + 该区块固定微环境偏移。
 * weather 为 null 表示气象数据未覆盖此刻，返回 null 让调用方跳过。
 */
export function makeReading(
  block: BlockRow,
  now: Date,
  weather: WeatherAt | null,
): ReadingOut | null {
  if (!weather) return null;
  const status = statusOf(block.id);
  const off = microOffset(block.id);
  const pest = PEST_BLOCKS[block.id];

  return {
    block_id: block.id,
    temp: round1(weather.temp + off.temp),
    humid: Math.min(100, Math.max(0, round1(weather.humid + off.humid))),
    has_pest: !!pest,
    pest_code: pest?.code ?? null,
    pest_level: pest?.level ?? null,
    status,
    collected_at: now.toISOString(),
  };
}

/** 历史曲线采样点：同样只由气象派生；无气象则返回 null */
export function historyPoint(
  blockId: string,
  weather: WeatherAt | null,
): { temp: number; humid: number } | null {
  if (!weather) return null;
  const off = microOffset(blockId);
  return {
    temp: round1(weather.temp + off.temp),
    humid: Math.min(100, Math.max(0, round1(weather.humid + off.humid))),
  };
}

export interface HistoryRow {
  block_id: string;
  temp: number;
  humid: number;
  bucket_at: string;
}

/**
 * 按小时步长重建整段历史曲线：每个整点取一次真实气象，再派生各区块读数。
 * 气象未覆盖的小时直接跳过；离线区块（数据缺失）不产生曲线点。
 * 所有数值都来自全田真实气象 + 区块固定微偏移，不含任何随机成分。
 * `index` 为「整点毫秒 → 气温/湿度」查找表，由调用方用 indexWeather 或读库结果构造。
 */
export function buildHistoryRows(
  blocks: BlockRow[],
  index: Map<number, { temp: number; humid: number }>,
  fromMs: number,
  toMs: number,
  stepMs = 3_600_000,
): HistoryRow[] {
  const rows: HistoryRow[] = [];
  const HOUR = 3_600_000;
  const start = Math.ceil(fromMs / HOUR) * HOUR;
  for (let at = start; at <= toMs; at += stepMs) {
    const sample = index.get(at);
    if (!sample) continue;
    for (const b of blocks) {
      if (OFFLINE_BLOCKS.has(b.id)) continue;
      const pt = historyPoint(b.id, sample);
      if (!pt) continue;
      rows.push({ block_id: b.id, temp: pt.temp, humid: pt.humid, bucket_at: new Date(at).toISOString() });
    }
  }
  return rows;
}

export interface AlertOut {
  block_id: string;
  type: string;
  severity: string;
  message: string;
  created_at: string;
}

/** 依据作物适宜区间判定预警（阈值随区块当前作物变化） */
export function buildAlerts(blocks: BlockRow[], readings: ReadingOut[], now: Date): AlertOut[] {
  const byBlock = new Map(readings.map((r) => [r.block_id, r]));
  const items: AlertOut[] = [];

  for (const block of blocks) {
    const rd = byBlock.get(block.id);
    if (!rd || rd.status === "offline") continue;
    const crop = CROPS[block.crop_id] ?? CROPS.corn;
    const [tLo, tHi] = crop.temp;
    const [hLo, hHi] = crop.humid;
    const push = (type: string, severity: string, message: string, offsetMin: number) => {
      items.push({
        block_id: block.id,
        type,
        severity,
        message,
        created_at: new Date(now.getTime() - offsetMin * 60_000).toISOString(),
      });
    };
    if (rd.has_pest && rd.pest_code) {
      const label = rd.pest_level === "high" ? "重度" : rd.pest_level === "medium" ? "中度" : "轻度";
      push("pest", rd.pest_level === "high" ? "urgent" : "warning", `检出${label}病虫害风险`, 6 + (hashStr(block.id) % 40));
    }
    if (rd.temp > tHi) push("temp_high", rd.temp > tHi + 4 ? "urgent" : "warning", `温度 ${rd.temp}℃，高于${crop.name}适宜上限 ${tHi}℃`, 12 + (hashStr(block.id) % 50));
    if (rd.temp < tLo) push("temp_low", "warning", `温度 ${rd.temp}℃，低于${crop.name}适宜下限 ${tLo}℃`, 20 + (hashStr(block.id) % 60));
    if (rd.humid > hHi) push("humid_high", "warning", `湿度 ${rd.humid}%RH，高于适宜上限 ${hHi}%RH`, 30 + (hashStr(block.id) % 70));
    if (rd.humid < hLo) push("humid_low", "info", `湿度 ${rd.humid}%RH，低于适宜下限 ${hLo}%RH`, 45 + (hashStr(block.id) % 80));
  }
  return items.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 24);
}
