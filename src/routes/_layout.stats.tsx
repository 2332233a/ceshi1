// 数据统计报表：作物/病虫害图片展示 + 温湿度趋势 + 历史统计（预警与环境数据）+ 病虫害分布
import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Activity, BarChart3, Bug, CheckCircle2, Clock3, CloudSun, Droplets, History, Info, Loader2, RadioTower, Save, Sprout, Thermometer, TriangleAlert } from "lucide-react";
import {
  COLS,
  CROPS,
  CROP_LIST,
  fetchAlertHistory,
  fetchDailyStats,
  fetchFieldHistory,
  fetchFieldWeather,
  fetchHistory,
  formatTime,
  loadBlocks,
  relativeTime,
  updateBlockCrop,
  type DailyStat,
  type FieldWeather,
} from "@/lib/farm-service";
import { useFarmLive } from "@/lib/farm-live";
import { useAuth } from "@/lib/auth";
import { PEST_DOCS, findPest } from "@/lib/pest-docs";
import { BlockEvidenceUpload } from "@/components/BlockEvidenceUpload";
import { ALERT_TYPE_LABEL, SEVERITY_LABEL, type AlertItem, type AlertType, type FarmBlock } from "@/lib/types";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_layout/stats")({
  component: StatsPage,
  validateSearch: (search: Record<string, unknown>): { block?: string } => ({
    block: typeof search.block === "string" ? search.block : undefined,
  }),
});

const RANGES = [
  { key: "24", label: "近 24 小时" },
  { key: "168", label: "近 7 天" },
  { key: "720", label: "近 30 天" },
] as const;

export function StatsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const { snapshot } = useFarmLive();
  const { user } = useAuth();
  const canWrite = Boolean(user?.canWrite);
  const [hours, setHours] = useState<(typeof RANGES)[number]["key"]>("24");
  const [block, setBlock] = useState<string>(search.block ?? "all");

  const linkedBlock = search.block;

  // 历史曲线：真实查询，随区块 / 时间范围变化重新拉取
  const [raw, setRaw] = useState<{ time: string; temp: number; humid: number }[]>([]);
  const [chartLoading, setChartLoading] = useState(true);
  const [chartError, setChartError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setChartLoading(true);
    setChartError(null);
    const promise = block === "all" ? fetchFieldHistory(Number(hours)) : fetchHistory(block, Number(hours));
    promise
      .then((pts) => {
        if (!alive) return;
        setRaw(pts.map((p) => ({ time: formatTime(p.t), temp: p.temp, humid: p.humid })));
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setChartError(e instanceof Error ? e.message : "加载历史曲线失败");
      })
      .finally(() => {
        if (alive) setChartLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [block, hours]);

  const chartData = raw;

  // 预警按类型汇总
  const alertByType = useMemo(() => {
    const map = new Map<AlertType, number>();
    for (const a of snapshot?.alerts ?? []) map.set(a.type, (map.get(a.type) ?? 0) + 1);
    return Array.from(map.entries())
      .map(([type, count]) => ({ name: ALERT_TYPE_LABEL[type], count }))
      .sort((a, b) => b.count - a.count);
  }, [snapshot]);

  // 异常区块 TOP
  const topBlocks = useMemo(() => {
    const cnt = new Map<string, number>();
    for (const a of snapshot?.alerts ?? []) cnt.set(a.blockId, (cnt.get(a.blockId) ?? 0) + 1);
    return Array.from(cnt.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [snapshot]);

  // 病虫害分布（档案 × 当前受影响区块数）
  const pestDist = useMemo(() => {
    const readings = Object.values(snapshot?.readings ?? {});
    return PEST_DOCS.map((p) => ({
      code: p.code,
      name: p.name,
      blocks: readings.filter((r) => r.pestCode === p.code).length,
    })).filter((d) => d.blocks > 0);
  }, [snapshot]);

  const totalBlocks = snapshot ? Object.keys(snapshot.readings).length : 0;

  // 区块布局（作物图片展示需要 cropId / 面积）
  const [blocks, setBlocks] = useState<FarmBlock[]>([]);
  useEffect(() => {
    let alive = true;
    loadBlocks()
      .then((l) => alive && setBlocks(l))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // 全田真实气象：只读云端已落库数据，未采集到时为空态
  const [weather, setWeather] = useState<FieldWeather | null>(null);
  useEffect(() => {
    let alive = true;
    fetchFieldWeather(30)
      .then((w) => alive && setWeather(w))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // 作物修改：仅登录用户可写，成功后重拉区块与预警阈值判定结果
  const [draftCrop, setDraftCrop] = useState<string | null>(null);
  const [cropSaving, setCropSaving] = useState(false);
  const [cropMsg, setCropMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    setDraftCrop(null);
    setCropMsg(null);
  }, [block]);

  const saveCrop = useCallback(async () => {
    if (!block || block === "all" || !draftCrop) return;
    setCropSaving(true);
    setCropMsg(null);
    try {
      await updateBlockCrop(block, draftCrop);
      const list = await loadBlocks();
      setBlocks(list);
      setCropMsg({ kind: "ok", text: `区块 ${block} 已改种${CROPS[draftCrop]?.name ?? draftCrop}，适宜阈值同步更新` });
      setDraftCrop(null);
    } catch (e: unknown) {
      setCropMsg({ kind: "err", text: e instanceof Error ? e.message : "修改作物失败" });
    } finally {
      setCropSaving(false);
    }
  }, [block, draftCrop]);

  // 历史统计：预警明细 + 环境日统计，随时间范围变化重新拉取
  const [historyAlerts, setHistoryAlerts] = useState<AlertItem[]>([]);
  const [dailyStats, setDailyStats] = useState<DailyStat[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const loadHistoryStats = useCallback(async (h: number) => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const days = Math.max(1, Math.round(h / 24));
      const [alerts, stats] = await Promise.all([fetchAlertHistory(h), fetchDailyStats(days)]);
      setHistoryAlerts(alerts);
      setDailyStats(stats);
    } catch (e: unknown) {
      setHistoryError(e instanceof Error ? e.message : "加载历史统计失败");
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadHistoryStats(Number(hours));
  }, [hours, loadHistoryStats]);

  // 当前选中区块的作物与病虫害档案
  const focusBlock = block === "all" ? undefined : blocks.find((b) => b.id === block);
  const focusCrop = focusBlock ? CROPS[focusBlock.cropId] : undefined;
  const focusReading = block === "all" ? undefined : snapshot?.readings[block];
  const focusPest = findPest(focusReading?.pestCode);

  // 该区块历史上出现过的病虫害（按预警信息里的名称匹配档案）
  const blockPestDocs = useMemo(() => {
    if (block === "all") return [];
    const names = new Set(
      historyAlerts.filter((a) => a.blockId === block && a.type === "pest").map((a) => a.message),
    );
    return PEST_DOCS.filter((p) => Array.from(names).some((m) => m.includes(p.name)));
  }, [block, historyAlerts]);

  const pestSummary = useMemo(() => {
    const cnt = new Map<string, number>();
    for (const a of historyAlerts) if (a.type === "pest") cnt.set(a.blockId, (cnt.get(a.blockId) ?? 0) + 1);
    return { blocks: cnt.size, total: Array.from(cnt.values()).reduce((s, n) => s + n, 0) };
  }, [historyAlerts]);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
            <BarChart3 className="size-5 text-primary" />
            数据统计报表
          </h1>
          <p className="mt-1 text-[13px] text-muted-foreground">作物与病虫害图示、温湿度趋势、历史预警与环境统计</p>
        </div>

        {/* 工具条 */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-full border border-border/70 bg-secondary/60 p-1 text-xs">
            {RANGES.map((r) => (
              <button
                key={r.key}
                onClick={() => setHours(r.key)}
                className={cn(
                  "rounded-full px-3 py-1.5 font-medium transition-all",
                  hours === r.key ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
          <select
            value={block}
            onChange={(e) => setBlock(e.target.value)}
            className="h-9 rounded-lg border border-input bg-card px-2.5 text-[13px] font-medium outline-none transition-all focus:border-primary focus:ring-2 focus:ring-ring/25"
          >
            <option value="all">全部区块（平均）</option>
            {Object.keys(snapshot?.readings ?? {})
              .sort()
              .map((id) => (
                <option key={id} value={id}>
                  区块 {id}
                </option>
              ))}
          </select>
        </div>
      </header>

      {/* 全田真实气象来源说明 */}
      <section className="rounded-2xl border border-border/70 bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px]">
          <span className="flex items-center gap-2 font-bold tracking-tight">
            <CloudSun className="size-4 text-primary" strokeWidth={2.2} />
            全田气象数据源
          </span>
          {weather?.observedAt ? (
            <>
              <span className="text-muted-foreground">
                站点 <b className="font-medium text-foreground">{weather.station || "—"}</b>（{weather.source || "open-meteo"}）
              </span>
              {weather.now && (
                <span className="tnum text-muted-foreground">
                  实况 <b className="font-medium text-foreground">{weather.now.temp}℃ / {weather.now.humid}%RH</b>
                </span>
              )}
              {weather.today && (
                <span className="tnum text-muted-foreground">
                  今日均温 <b className="font-medium text-foreground">{weather.today.avgTemp}℃</b> · 极值{" "}
                  <b className="font-medium text-foreground">{weather.today.minTemp}–{weather.today.maxTemp}℃</b> · 均湿{" "}
                  <b className="font-medium text-foreground">{weather.today.avgHumid}%RH</b>
                </span>
              )}
              <span className="ml-auto tnum text-muted-foreground">采集于 {formatTime(weather.observedAt)}</span>
            </>
          ) : (
            <span className="text-clay">
              云端尚未收到真实气象数据，区块温湿度暂不生成。登录后可在首页触发一次气象采集。
            </span>
          )}
        </div>
      </section>

      {linkedBlock && (
        <div className="fade-up flex items-center justify-between gap-3 rounded-xl border border-primary/30 bg-primary/8 px-4 py-2.5 text-[13px]">
          <span className="flex items-center gap-2">
            <Info className="size-4 text-primary" />
            正在查看 <b className="font-mono">区块 {linkedBlock}</b> 的历史数据（来自首页跳转）
          </span>
          <button
            onClick={() => void navigate({ to: "/stats", search: {}, replace: true })}
            className="shrink-0 text-xs font-semibold text-primary underline-offset-4 hover:underline"
          >
            取消联动
          </button>
        </div>
      )}

      {/* 区块实时数据 / 历史数据分区带 */}
      <ZoneBand
        tone="live"
        Icon={RadioTower}
        title="区块当前状态"
        desc={`最近一次同步快照${snapshot ? ` · ${formatTime(snapshot.syncedAt)}` : ""}，以下均为该区块的实时数据`}
      />

      {/* 作物与病虫害图示 */}
      <section className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-[14px] font-bold tracking-tight">
            <Sprout className="size-4 text-primary" strokeWidth={2.2} />
            作物与病虫害图示
          </h2>
          <span className="text-xs text-muted-foreground">
            {block === "all" ? "选择具体区块可查看该地块的作物与检出病虫害图片" : `区块 ${block}`}
          </span>
        </div>

        {block === "all" ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {Object.values(CROPS).map((c) => {
              const cnt = blocks.filter((b) => b.cropId === c.id).length;
              return (
                <div key={c.id} className="rounded-xl border border-border/60 bg-secondary/30 px-4 py-3">
                  <p className="text-2xl leading-none">{c.emoji}</p>
                  <p className="mt-2 text-[13px] font-bold">{c.name}</p>
                  <p className="tnum mt-0.5 text-[11px] text-muted-foreground">
                    种植 {cnt} 个区块 · 适宜 {c.range.temp[0]}–{c.range.temp[1]}℃ / {c.range.humid[0]}–{c.range.humid[1]}%RH
                  </p>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="mt-4 grid gap-4 lg:grid-cols-[260px_1fr]">
            {/* 当前作物 */}
            <div className="overflow-hidden rounded-xl border border-border/60 bg-secondary/30">
              <div className="grid h-28 place-items-center bg-field text-5xl">{focusCrop?.emoji ?? "🌱"}</div>
              <div className="p-4">
                <p className="text-[11px] text-muted-foreground">种植作物</p>
                <p className="mt-0.5 text-[15px] font-bold">{focusCrop?.name ?? "未登记"}</p>
                {focusBlock && (
                  <p className="tnum mt-1 text-[11px] text-muted-foreground">
                    {focusBlock.areaMu} 亩 · 第 {focusBlock.row} 行 {COLS[focusBlock.col - 1]} 列
                  </p>
                )}
                {focusReading && focusCrop && (
                  <p className="tnum mt-2 text-[11px] text-muted-foreground">
                    当前 {focusReading.temp}℃ / {focusReading.humid}%RH，适宜 {focusCrop.range.temp[0]}–
                    {focusCrop.range.temp[1]}℃ / {focusCrop.range.humid[0]}–{focusCrop.range.humid[1]}%RH
                  </p>
                )}

                {/* 改种：仅登录用户可操作；变更后适宜阈值与预警判定同步跟随 */}
                {focusBlock && (
                  <div className="mt-3 border-t border-border/60 pt-3">
                    <label className="text-[11px] text-muted-foreground" htmlFor="crop-select">
                      {canWrite ? "改种作物（适宜温湿度随作物变化）" : "改种作物（游客只读）"}
                    </label>
                    <div className="mt-1.5 flex items-center gap-2">
                      <select
                        id="crop-select"
                        disabled={!canWrite || cropSaving}
                        value={draftCrop ?? focusBlock.cropId}
                        onChange={(e) => setDraftCrop(e.target.value)}
                        className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-card px-2 text-[12.5px] font-medium outline-none transition-all focus:border-primary focus:ring-2 focus:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {CROP_LIST.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.emoji} {c.name} · {c.range.temp[0]}–{c.range.temp[1]}℃
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => void saveCrop()}
                        disabled={!canWrite || cropSaving || !draftCrop || draftCrop === focusBlock.cropId}
                        className="flex h-8 shrink-0 items-center gap-1 rounded-lg bg-primary px-2.5 text-[12px] font-semibold text-primary-foreground transition-all hover:brightness-110 active:scale-95 disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        {cropSaving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                        保存
                      </button>
                    </div>
                    {!canWrite && (
                      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                        游客模式不可修改种植作物，登录后可改种。
                      </p>
                    )}
                    {cropMsg && (
                      <p
                        className={cn(
                          "mt-1.5 text-[11px] leading-relaxed",
                          cropMsg.kind === "ok" ? "text-primary" : "text-destructive",
                        )}
                      >
                        {cropMsg.text}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* 病虫害检出信息：AI 示意图已下线，仅保留文字判定 */}
            <div>
              {(() => {
                const docs = blockPestDocs.length > 0 ? blockPestDocs : focusPest ? [focusPest] : [];
                if (docs.length === 0) {
                  return (
                    <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-card/60 px-4 py-8 text-center">
                      <Bug className="size-6 text-muted-foreground/40" />
                      <p className="text-[13px] text-muted-foreground">
                        {RANGES.find((r) => r.key === hours)?.label}内该区块未检出病虫害
                      </p>
                    </div>
                  );
                }
                return (
                  <ul className="grid gap-3 sm:grid-cols-2">
                    {docs.map((p) => (
                      <li key={p.code} className="fade-up rounded-xl border border-border/60 bg-card p-3.5 shadow-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={cn(
                              "rounded-full px-2 py-0.5 text-[10px] font-bold",
                              p.level === "high"
                                ? "bg-destructive/12 text-destructive"
                                : p.level === "medium"
                                  ? "bg-warning/15 text-warning-foreground"
                                  : "bg-secondary text-muted-foreground",
                            )}
                          >
                            {p.level === "high" ? "重度风险" : p.level === "medium" ? "中度风险" : "轻度风险"}
                          </span>
                          <p className="text-[13px] font-bold">{p.name}</p>
                          <span className="text-[11px] text-muted-foreground">{p.alias}</span>
                          {p.code === focusPest?.code && (
                            <span className="ml-auto text-[10px] font-semibold text-destructive">当前正在发生</span>
                          )}
                        </div>
                        <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">{p.symptom}</p>
                        <p className="tnum mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                          易发作物：{p.crops.join("、")} · 高发期：{p.season}
                        </p>
                      </li>
                    ))}
                  </ul>
                );
              })()}
            </div>
          </div>
        )}

        {/* 现场补拍素材：仅具体区块可上传，按区块重挂载自动刷新列表 */}
        {block !== "all" && <BlockEvidenceUpload key={block} blockId={block} canWrite={canWrite} />}
      </section>

      {/* 趋势图 */}
      <ZoneBand
        tone="history"
        Icon={History}
        title="历史数据"
        desc={`以下曲线、日统计与预警记录均为所选时间范围（${RANGES.find((r) => r.key === hours)?.label ?? ""}）内的历史回溯，不代表当前状态`}
      />

      <section className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
        <h2 className="text-[14px] font-bold tracking-tight">
          温湿度变化趋势
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {block === "all" ? "全田平均" : `区块 ${block}`} · {RANGES.find((r) => r.key === hours)?.label}
          </span>
        </h2>
        {chartLoading ? (
          <div className="grid h-72 place-items-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" /> 正在加载历史数据…
          </div>
        ) : chartError ? (
          <p className="py-16 text-center text-sm text-destructive">{chartError}</p>
        ) : chartData.length < 3 ? (
          <p className="py-16 text-center text-sm text-muted-foreground">该区块历史数据较少，暂无法绘制曲线</p>
        ) : (
          <div className="mt-4 h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 4, bottom: 4, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.885 0.022 150)" vertical={false} />
                <XAxis
                  dataKey="time"
                  tick={{ fontSize: 11, fill: "oklch(0.52 0.025 152)" }}
                  tickLine={false}
                  axisLine={{ stroke: "oklch(0.885 0.022 150)" }}
                  interval="preserveStartEnd"
                  minTickGap={28}
                />
                <YAxis
                  yAxisId="temp"
                  tick={{ fontSize: 11, fill: "oklch(0.52 0.025 152)" }}
                  tickLine={false}
                  axisLine={false}
                  width={44}
                />
                <YAxis
                  yAxisId="humid"
                  orientation="right"
                  domain={[0, 100]}
                  tick={{ fontSize: 11, fill: "oklch(0.52 0.025 152)" }}
                  tickLine={false}
                  axisLine={false}
                  width={40}
                />
                <Tooltip
                  contentStyle={{
                    borderRadius: 12,
                    border: "1px solid oklch(0.885 0.022 150)",
                    fontSize: 12,
                    boxShadow: "0 8px 24px oklch(0.24 0.03 155 / 0.12)",
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line yAxisId="temp" type="monotone" dataKey="temp" name="温度(℃)" stroke="oklch(0.6 0.19 25)" strokeWidth={2.2} dot={false} activeDot={{ r: 4 }} />
                <Line yAxisId="humid" type="monotone" dataKey="humid" name="湿度(%RH)" stroke="oklch(0.55 0.13 152)" strokeWidth={2.2} strokeDasharray="6 3" dot={false} activeDot={{ r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      {/* 历史统计：环境日统计 + 预警明细 */}
      <section className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-[14px] font-bold tracking-tight">
            <Clock3 className="size-4 text-primary" strokeWidth={2.2} />
            历史统计数据
          </h2>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{RANGES.find((r) => r.key === hours)?.label}</span>
            {historyLoading && <Loader2 className="size-3.5 animate-spin" />}
            {!historyLoading && !historyError && (
              <button
                onClick={() => void loadHistoryStats(Number(hours))}
                className="font-semibold text-primary underline-offset-4 hover:underline"
              >
                刷新
              </button>
            )}
          </div>
        </div>

        {historyError ? (
          <p className="py-10 text-center text-sm text-destructive">{historyError}</p>
        ) : historyLoading && dailyStats.length === 0 ? (
          <div className="grid h-56 place-items-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" /> 正在加载历史统计…
          </div>
        ) : (
          <div className="mt-4 grid gap-5 xl:grid-cols-[1.15fr_1fr]">
            {/* 环境数据统计 */}
            <div className="rounded-xl border border-border/60 bg-secondary/20 p-4">
              <h3 className="flex items-center gap-2 text-[13px] font-bold tracking-tight">
                <Activity className="size-4 text-primary" strokeWidth={2.2} />
                环境数据（全田逐日均值）
              </h3>
              {dailyStats.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">该时间段暂无历史环境数据</p>
              ) : (
                <>
                  <div className="mt-3 grid grid-cols-4 gap-2">
                    {[
                      ["均温", `${avgOf(dailyStats, "avgTemp")}℃`, Thermometer],
                      ["极值", `${maxOf(dailyStats)} / ${minOf(dailyStats)}℃`, Activity],
                      ["均湿", `${avgOf(dailyStats, "avgHumid")}%RH`, Droplets],
                      ["病虫害提醒", `${pestSummary.total} 次 · ${pestSummary.blocks} 区块`, Bug],
                    ].map(([label, value, Ico]) => {
                      const Icon = Ico as typeof Thermometer;
                      return (
                        <div key={label as string} className="rounded-lg bg-card px-2.5 py-2 shadow-sm">
                          <Icon className="size-3.5 text-primary" />
                          <p className="mt-1 truncate text-[10px] text-muted-foreground">{label as string}</p>
                          <p className="tnum mt-0.5 text-[13px] font-bold">{value as string}</p>
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-3 max-h-64 overflow-y-auto rounded-lg border border-border/50 bg-card">
                    <table className="w-full border-collapse text-[12px]">
                      <thead className="sticky top-0 bg-secondary/80 backdrop-blur">
                        <tr className="text-left text-[11px] text-muted-foreground">
                          <th className="px-3 py-2 font-medium">日期</th>
                          <th className="px-2 py-2 text-right font-medium">均温℃</th>
                          <th className="px-2 py-2 text-right font-medium">最高</th>
                          <th className="px-2 py-2 text-right font-medium">最低</th>
                          <th className="px-2 py-2 text-right font-medium">均湿%</th>
                          <th className="px-3 py-2 text-right font-medium">区块</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dailyStats
                          .slice()
                          .reverse()
                          .map((d) => (
                            <tr key={d.date} className="border-t border-border/40 transition-colors hover:bg-accent/40">
                              <td className="px-3 py-1.5 font-mono text-[11px]">{d.date}</td>
                              <td className="tnum px-2 py-1.5 text-right font-semibold">{d.avgTemp}</td>
                              <td className="tnum px-2 py-1.5 text-right text-destructive/90">{d.maxTemp}</td>
                              <td className="tnum px-2 py-1.5 text-right text-sky-700">{d.minTemp}</td>
                              <td className="tnum px-2 py-1.5 text-right">{d.avgHumid}</td>
                              <td className="tnum px-3 py-1.5 text-right text-muted-foreground">{d.samples}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>

            {/* 历史预警明细 */}
            <div className="rounded-xl border border-border/60 bg-secondary/20 p-4">
              <h3 className="flex items-center gap-2 text-[13px] font-bold tracking-tight">
                <TriangleAlert className="size-4 text-primary" strokeWidth={2.2} />
                历史预警记录
                <span className="tnum font-normal text-muted-foreground">（{historyAlerts.length} 条）</span>
              </h3>
              {historyAlerts.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">该时间段内未产生预警</p>
              ) : (
                <ul className="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">
                  {historyAlerts.map((a) => (
                    <li
                      key={a.id}
                      className="rounded-lg border border-border/50 bg-card px-3 py-2.5 shadow-sm transition-colors hover:border-primary/40"
                    >
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setBlock(a.blockId)}
                          className="shrink-0 rounded-md bg-secondary px-1.5 py-0.5 font-mono text-[11px] font-bold transition-colors hover:brightness-110"
                        >
                          {a.blockId}
                        </button>
                        <span className="truncate text-[12.5px] font-medium">{ALERT_TYPE_LABEL[a.type]}</span>
                        <span
                          className={cn(
                            "ml-auto shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold",
                            a.severity === "urgent"
                              ? "bg-destructive/12 text-destructive"
                              : a.severity === "warning"
                                ? "bg-block-warn/25 text-clay"
                                : "bg-secondary text-secondary-foreground",
                          )}
                        >
                          {SEVERITY_LABEL[a.severity]}
                        </span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-muted-foreground">{a.message}</p>
                      <div className="mt-1.5 flex items-center gap-2 text-[10.5px] text-muted-foreground/80">
                        <span className="tnum">{formatTime(a.createdAt)} · {relativeTime(a.createdAt)}</span>
                        <span
                          className={cn(
                            "ml-auto flex items-center gap-1 font-semibold",
                            a.resolved ? "text-primary" : "text-clay",
                          )}
                        >
                          {a.resolved ? <CheckCircle2 className="size-3" /> : <Clock3 className="size-3" />}
                          {a.resolved ? "已处理" : "待处理"}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </section>

      {/* 汇总区 */}
      <div className="grid gap-5 lg:grid-cols-3">
        <SummaryCard title="预警类型分布" Icon={TriangleAlert}>
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={alertByType} layout="vertical" margin={{ left: 4, right: 12 }}>
                <XAxis type="number" hide allowDecimals={false} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: "oklch(0.52 0.025 152)" }} tickLine={false} axisLine={false} width={76} />
                <Tooltip cursor={{ fill: "oklch(0.945 0.014 150)" }} contentStyle={{ borderRadius: 12, fontSize: 12 }} />
                <Bar dataKey="count" name="次数" fill="oklch(0.74 0.15 62)" radius={[0, 6, 6, 0]} barSize={16} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </SummaryCard>

        <SummaryCard title="异常区块 TOP" Icon={Sprout}>
          {topBlocks.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">暂无异常区块</p>
          ) : (
            <ul className="space-y-2.5 pt-1">
              {topBlocks.map(([id, count], i) => (
                <li key={id} className="flex items-center gap-3">
                  <span className="w-5 text-right font-mono text-[11px] font-bold text-muted-foreground">{i + 1}</span>
                  <button
                    onClick={() => setBlock(id)}
                    className={cn(
                      "w-11 shrink-0 rounded-md px-1.5 py-1 text-center font-mono text-[11px] font-bold transition-colors hover:brightness-110",
                      i === 0 ? "bg-destructive/15 text-destructive" : "bg-secondary text-secondary-foreground",
                    )}
                  >
                    {id}
                  </button>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-block-warn to-destructive"
                      style={{ width: `${(count / topBlocks[0][1]) * 100}%` }}
                    />
                  </div>
                  <span className="tnum w-8 text-right text-xs font-semibold">{count} 次</span>
                </li>
              ))}
            </ul>
          )}
        </SummaryCard>

        <SummaryCard title="病虫害影响面" Icon={Bug}>
          {pestDist.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">当前无病虫害检出</p>
          ) : (
            <ul className="space-y-3 pt-1">
              {pestDist.map((d) => (
                <li key={d.name}>
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium">{d.name}</span>
                    <span className="tnum text-muted-foreground">
                      {d.blocks} 个区块 · {totalBlocks ? Math.round((d.blocks / totalBlocks) * 100) : 0}%
                    </span>
                  </div>
                  <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-secondary">
                    <div
                      className="h-full rounded-full bg-block-danger"
                      style={{ width: `${Math.max(6, totalBlocks ? (d.blocks / totalBlocks) * 100 * 3 : 6)}%` }}
                    />
                  </div>
                </li>
              ))}
              <li className="pt-1 text-[11px] leading-relaxed text-muted-foreground">
                共 {Object.values(snapshot?.readings ?? {}).filter((r) => r.hasPest).length} 个区块检出病虫害，
                涉及 {pestDist.map((d) => findPest(d.code)?.name ?? d.name).join("、")}。
              </li>
            </ul>
          )}
        </SummaryCard>
      </div>

      <p className="pb-1 text-center text-[11px] text-muted-foreground/70">
        报表基于最近一次同步快照{snapshot ? `（${formatTime(snapshot.syncedAt)}）` : ""} · 列标 {COLS.join("–")} × 行 1–4
      </p>
    </div>
  );
}

function SummaryCard({
  title,
  Icon,
  children,
}: {
  title: string;
  Icon: typeof Sprout;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
      <h2 className="flex items-center gap-2 text-[13.5px] font-bold tracking-tight">
        <Icon className="size-4 shrink-0 text-primary" strokeWidth={2.2} />
        {title}
      </h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** 分区带：把「区块当前状态」与「历史数据」两类信息在视觉上明确切开 */
function ZoneBand({
  tone,
  Icon,
  title,
  desc,
}: {
  tone: "live" | "history";
  Icon: typeof Sprout;
  title: string;
  desc: string;
}) {
  const live = tone === "live";
  return (
    <div
      className={cn(
        "relative mt-8 pt-6",
        live && "mt-2 pt-0",
      )}
    >
      {/* 分隔线：中段断开让标签嵌进去 */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-x-0 top-0 h-px",
          live ? "hidden" : "bg-gradient-to-r from-transparent via-border to-transparent",
        )}
      />
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border px-4 py-2.5",
          live
            ? "border-primary/25 bg-primary/8"
            : "border-clay/30 bg-clay/8",
        )}
      >
        <span
          className={cn(
            "grid size-7 shrink-0 place-items-center rounded-lg",
            live ? "bg-primary/15 text-primary" : "bg-clay/18 text-clay",
          )}
        >
          <Icon className="size-4" strokeWidth={2.2} />
        </span>
        <h2 className="text-[13.5px] font-bold tracking-tight">{title}</h2>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[10px] font-bold",
            live ? "bg-primary text-primary-foreground" : "bg-clay text-primary-foreground",
          )}
        >
          {live ? "实时" : "历史"}
        </span>
        <p className="w-full text-[11.5px] leading-relaxed text-muted-foreground sm:w-auto sm:flex-1">
          {desc}
        </p>
      </div>
    </div>
  );
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

const avgOf = (rows: DailyStat[], key: "avgTemp" | "avgHumid"): number => {
  if (!rows.length) return 0;
  const sum = rows.reduce((s, r) => s + r[key], 0);
  return round1(sum / rows.length);
};
const maxOf = (rows: DailyStat[]): number =>
  rows.length ? Math.max(...rows.map((r) => r.maxTemp)) : 0;
const minOf = (rows: DailyStat[]): number =>
  rows.length ? Math.min(...rows.map((r) => r.minTemp)) : 0;
