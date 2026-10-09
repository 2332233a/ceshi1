// 智能决策建议：调用后端 decision 函数获取处置决策。
// 当前后端分析能力尚未接入，函数返回空置列表，页面据此展示空态。
import { supabase, supabaseAnonKey, supabaseUrl } from "@/supabase/client";

export interface DecisionItem {
  id: string;
  blockId?: string;
  type?: string; // pest | temp_high | temp_low | humid_high | humid_low | offline
  title: string;
  detail: string;
  priority: "low" | "medium" | "high";
  createdAt?: string;
}

export interface DecisionResult {
  items: DecisionItem[];
  generatedAt: string | null;
  note?: string;
}

interface RawDecision {
  id: string;
  block_id?: string;
  type?: string;
  title: string;
  detail: string;
  priority?: "low" | "medium" | "high";
  created_at?: string;
}

async function callDecision(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const session = (await supabase.auth.getSession()).data.session;
  const response = await fetch(`${supabaseUrl}/functions/v1/decision`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: supabaseAnonKey,
      ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error((result.error as string) ?? `请求失败（HTTP ${response.status}）`);
  }
  return result;
}

let pending: Promise<DecisionResult> | null = null;
export async function fetchDecisions(): Promise<DecisionResult> {
  // 并发去重：同一时刻只允许一次请求，避免重复触发导致网关限流
  if (pending) return pending;
  pending = request().finally(() => {
    pending = null;
  });
  return pending;
}

async function request(): Promise<DecisionResult> {
  const result = await callDecision({ action: "list" });
  if (!result.ok) {
    throw new Error((result.error as string) ?? "获取决策建议失败");
  }
  const rawList = ((result.decisions as RawDecision[]) ?? []);
  const items = rawList.map<DecisionItem>((d) => ({
    id: d.id,
    blockId: d.block_id,
    type: d.type,
    title: d.title,
    detail: d.detail,
    priority: d.priority ?? "low",
    createdAt: d.created_at,
  }));
  return {
    items,
    generatedAt: (result.generatedAt as string) ?? null,
    note: result.note as string | undefined,
  };
}

/**
 * 处理一条决策：删除其对应的预警行（代表已解决）。
 * 离线类建议没有 alert 行，前端不会对其调用本函数。
 */
export async function resolveDecision(decisionId: string): Promise<void> {
  const session = (await supabase.auth.getSession()).data.session;
  if (!session) throw new Error("请先登录后再处理预警");
  const r = await callDecision({ action: "resolve", alertId: decisionId });
  if (!r.ok) throw new Error((r.error as string) ?? "标记已解决失败");
}
