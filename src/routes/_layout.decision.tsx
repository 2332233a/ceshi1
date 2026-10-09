// 智能决策建议：后端按固定规则（病虫害档案 + 作物适宜区间）生成处置方案，按重要性排序；
// 登录用户可就地「解决」——删除对应预警行代表已处理。游客只读。
import { useCallback, useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { BrainCircuit, Eye, Loader2, RefreshCw, Sparkles, Check, AlertTriangle } from "lucide-react";
import { useFarmLive } from "@/lib/farm-live";
import { fetchDecisions, resolveDecision, type DecisionItem } from "@/lib/decision-service";
import { formatTime } from "@/lib/farm-service";
import { ALERT_TYPE_LABEL, type AlertType } from "@/lib/types";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_layout/decision")({
  component: DecisionPage,
});

const PRIORITY_STYLE: Record<string, string> = {
  high: "bg-destructive/12 text-destructive",
  medium: "bg-block-warn/20 text-clay",
  low: "bg-secondary text-secondary-foreground",
};
const PRIORITY_LABEL: Record<string, string> = { high: "优先处置", medium: "尽快处置", low: "关注" };

/** 离线类建议没有对应预警行，不可解决 */
function isResolvable(d: DecisionItem): boolean {
  return !!d.blockId && !d.id.startsWith("offline:") && /^[0-9a-f-]{36}$/i.test(d.id);
}
function typeLabel(type?: string): string {
  if (!type) return "";
  return (ALERT_TYPE_LABEL as Record<string, string>)[type as AlertType] ?? "设备状态";
}

function DecisionPage() {
  const { snapshot, canWrite } = useFarmLive();
  const [items, setItems] = useState<DecisionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchDecisions();
      setItems(res.items);
      setGeneratedAt(res.generatedAt);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "获取决策建议失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onResolve = useCallback(
    async (d: DecisionItem) => {
      setResolvingId(d.id);
      setNotice(null);
      setError(null);
      try {
        await resolveDecision(d.id);
        // 先本地摘除保证即时反馈，再重拉列表与后端对齐
        setItems((prev) => prev.filter((x) => x.id !== d.id));
        setNotice(`区块 ${d.blockId} 的「${typeLabel(d.type)}」预警已标记为已解决`);
        void load();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "标记已解决失败");
        void load();
      } finally {
        setResolvingId(null);
      }
    },
    [load],
  );

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
            <BrainCircuit className="size-5 text-primary" />
            智能决策建议
          </h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            基于各区块温湿度、病虫害与预警情况，由后端分析后给出处置决策
          </p>
        </div>
        <button
          onClick={() => void load()}
          disabled={loading}
          title={canWrite ? "重新请求后端生成决策" : "游客可重新读取决策结果，不会触发任何数据变更"}
          className={cn(
            "flex h-9 items-center gap-1.5 rounded-lg border border-border/70 bg-card px-3.5 text-[13px] font-medium transition-colors",
            loading ? "cursor-not-allowed opacity-60" : "hover:bg-accent",
          )}
        >
          {loading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : canWrite ? (
            <RefreshCw className="size-4" />
          ) : (
            <Eye className="size-4" />
          )}
          {canWrite ? "重新生成" : "重新读取"}
        </button>
      </header>

      {!canWrite && (
        <div className="flex items-start gap-2 rounded-xl border border-block-warn/40 bg-block-warn/10 px-4 py-2.5 text-[13px] text-clay">
          <Eye className="mt-0.5 size-4 shrink-0" />
          <span>游客模式下决策建议仅供查看，「重新读取」只获取后端已有的分析结果，不会产生任何处置动作。</span>
        </div>
      )}

      {notice && (
        <div className="flex items-start gap-2 rounded-xl border border-primary/30 bg-primary/8 px-4 py-2.5 text-[13px] text-primary">
          <Check className="mt-0.5 size-4 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      {snapshot && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ["在线区块", `${snapshot.overview.onlineCount}/${snapshot.overview.totalCount}`],
            ["病虫害检出", `${snapshot.overview.pestCount} 个`],
            ["温湿度异常", `${snapshot.overview.climateCount} 个`],
            ["待处理预警", `${snapshot.alerts.length} 条`],
          ].map(([label, value]) => (
            <div key={label} className="rounded-xl border border-border/70 bg-card px-4 py-3 shadow-sm">
              <p className="text-[11px] text-muted-foreground">{label}</p>
              <p className="tnum mt-1 text-lg font-bold tracking-tight">{value}</p>
            </div>
          ))}
        </div>
      )}

      {error ? (
        <div className="flex items-start gap-2 rounded-2xl border border-destructive/30 bg-destructive/8 px-5 py-4 text-[13px] text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : loading ? (
        <div className="grid min-h-[45vh] place-items-center rounded-2xl border border-border/70 bg-card text-sm text-muted-foreground shadow-sm">
          <Loader2 className="mr-2 size-4 animate-spin" />
          正在向后端请求决策…
        </div>
      ) : items.length === 0 ? (
        <div className="flex min-h-[45vh] flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-border bg-card/60 px-6 py-16 text-center">
          <span className="grid size-14 place-items-center rounded-2xl bg-field text-primary">
            <Sparkles className="size-7" strokeWidth={1.8} />
          </span>
          <div>
            <p className="text-[15px] font-bold tracking-tight">暂无决策建议</p>
            <p className="mx-auto mt-1.5 max-w-md text-[13px] leading-relaxed text-muted-foreground">
              决策内容由后端分析服务生成，该能力尚未接入。当前页面仅展示真实采集到的区块数据概览，
              接入后即可在此看到针对每个异常区块的处置建议。
            </p>
          </div>
          {generatedAt && (
            <p className="tnum text-[11px] text-muted-foreground/70">最近一次请求：{formatTime(generatedAt)}</p>
          )}
        </div>
      ) : (
        <>
          <ul className="space-y-3">
            {items.map((d, i) => (
              <li
                key={d.id}
                className="fade-up rounded-2xl border border-border/70 bg-card p-5 shadow-sm transition-shadow hover:shadow-md"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="tnum grid size-6 shrink-0 place-items-center rounded-lg bg-secondary text-[12px] font-bold text-secondary-foreground">
                    {i + 1}
                  </span>
                  <span
                    className={cn(
                      "rounded-full px-2.5 py-1 text-[11px] font-bold",
                      PRIORITY_STYLE[d.priority] ?? PRIORITY_STYLE.low,
                    )}
                  >
                    {PRIORITY_LABEL[d.priority] ?? "关注"}
                  </span>
                  <span className="rounded-full border border-border/70 px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                    {d.blockId ? `区块 ${d.blockId}` : "全田"}
                  </span>
                  <h2 className="min-w-0 flex-1 text-[15px] font-bold tracking-tight">{d.title}</h2>
                  {canWrite && isResolvable(d) ? (
                    <button
                      onClick={() => void onResolve(d)}
                      disabled={resolvingId === d.id}
                      title="删除该条预警并视为已处理"
                      className={cn(
                        "flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-primary/40 bg-primary/8 px-3 text-[12px] font-semibold text-primary transition-colors",
                        resolvingId === d.id ? "cursor-wait opacity-70" : "hover:bg-primary hover:text-primary-foreground",
                      )}
                    >
                      {resolvingId === d.id ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Check className="size-3.5" />
                      )}
                      解决
                    </button>
                  ) : d.type === "offline" ? (
                    <span className="shrink-0 rounded-lg border border-dashed border-border px-2.5 py-1 text-[11px] text-muted-foreground">
                      需现场排查
                    </span>
                  ) : null}
                </div>
                <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{d.detail}</p>
                {(d.type || d.createdAt) && (
                  <p className="tnum mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground/70">
                    {d.type && <span>类型：{typeLabel(d.type)}</span>}
                    {d.createdAt && <span>预警时间：{formatTime(d.createdAt)}</span>}
                  </p>
                )}
              </li>
            ))}
          </ul>
          <p className="text-[12px] leading-relaxed text-muted-foreground/70">
            说明：点「解决」即删除该条预警记录。若底层温湿度或虫情异常仍然存在，下一轮设备上报会重新判定并生成同样的预警，
            属正常现象；需要长期消除某项异常，请按建议调整种植作物或现场处置条件。
          </p>
        </>
      )}
    </div>
  );
}
