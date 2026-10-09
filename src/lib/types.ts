// 全局业务类型：农田区块 / 检测记录 / 预警 / 病虫害档案

export type BlockStatus = "normal" | "climate" | "pest" | "offline";
export type PestLevel = "low" | "medium" | "high";
export type AlertType = "temp_high" | "temp_low" | "humid_high" | "humid_low" | "pest";
export type Severity = "urgent" | "warning" | "info";
export type Category = "disease" | "insect";

/** 作物适宜温湿度区间 */
export interface Range {
  temp: [number, number];
  humid: [number, number];
}

export interface Crop {
  id: string;
  name: string;
  emoji: string;
  range: Range;
}

/** 农田区块（静态布局信息） */
export interface FarmBlock {
  id: string; // A1 ... F4
  row: number;
  col: number;
  cropId: string;
  areaMu: number; // 面积（亩）
}

/** 单区块最近一次后端上报 */
export interface Reading {
  blockId: string;
  temp: number;
  humid: number;
  hasPest: boolean;
  pestCode?: string;
  pestLevel?: PestLevel;
  collectedAt: string; // ISO
  status: BlockStatus;
}

/** 历史曲线采样点 */
export interface HistoryPoint {
  t: string; // ISO
  temp: number;
  humid: number;
}

export interface AlertItem {
  id: string;
  blockId: string;
  type: AlertType;
  severity: Severity;
  message: string;
  createdAt: string;
  resolved: boolean;
}

/** 病虫害档案 */
export interface PestDoc {
  code: string;
  name: string;
  alias: string;
  category: Category;
  level: PestLevel;
  crops: string[];
  symptom: string;
  condition: string;
  spread: string;
  season: string;
  control: { agri: string[]; bio: string[]; chemo: string[] };
}

/** 区块现场补拍素材（人工上传的图片/视频，用于自动巡检漏检情况的病虫害研判） */
export interface BlockMedia {
  id: string;
  blockId: string;
  url: string; // 公网可访问地址
  kind: "image" | "video";
  caption: string | null;
  sizeBytes: number;
  createdAt: string; // ISO
}

/** 首页概览统计 */
export interface OverviewStats {
  avgTemp: number;
  avgHumid: number;
  maxTemp: { value: number; blockId: string };
  minTemp: { value: number; blockId: string };
  onlineCount: number;
  totalCount: number;
  pestCount: number;
  climateCount: number;
}

export const ALERT_TYPE_LABEL: Record<AlertType, string> = {
  temp_high: "温度过高",
  temp_low: "温度过低",
  humid_high: "湿度过高",
  humid_low: "湿度过低",
  pest: "病虫害提醒",
};

export const SEVERITY_LABEL: Record<Severity, string> = {
  urgent: "紧急",
  warning: "警告",
  info: "提示",
};

export const STATUS_LABEL: Record<BlockStatus, string> = {
  normal: "正常",
  climate: "温湿度异常",
  pest: "病虫害",
  offline: "数据缺失",
};
