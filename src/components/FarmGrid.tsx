// 农田区块网格：状态着色 + 悬浮详情浮层（紧耦合父子组件同文件内联）
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Bug, CircleAlert, CloudOff, LineChart, Sprout } from "lucide-react";
import { COLS, CROPS, ROW_COUNT, loadBlocks, relativeTime } from "@/lib/farm-service";
import type { FarmBlock } from "@/lib/types";
import { findPest } from "@/lib/pest-docs";
import { STATUS_LABEL, type BlockStatus, type Reading } from "@/lib/types";
import { cn } from "@/lib/utils";

type Filter = "all" | "abnormal" | "pest";

const STATUS_STYLE: Record<BlockStatus, string> = {
  normal: "bg-block-ok",
  climate: "bg-block-warn",
  pest: "bg-block-danger",
  offline: "bg-block-offline",
};

/** 缺行补齐用的占位区块，保证网格始终为 6×4 */
function fallbackBlocks(): FarmBlock[] {
  const list: FarmBlock[] = [];
  for (let r = 0; r < ROW_COUNT; r++) {
    for (let c = 0; c < COLS.length; c++) {
      const id = `${COLS[c]}${r + 1}`;
      list.push({ id, row: r, col: c, cropId: "corn", areaMu: 0 });
    }
  }
  return list;
}

export function FarmGrid({ readings }: { readings: Record<string, Reading> }) {
  const [blocks, setBlocks] = useState<FarmBlock[]>(fallbackBlocks);
  const [filter, setFilter] = useState<Filter>("all");
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [tipPos, setTipPos] = useState<{ x: number; y: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  // 区块布局来自数据库（进程内已缓存，失败时保留占位网格）
  useEffect(() => {
    let alive = true;
    loadBlocks()
      .then((list) => {
        if (alive && list.length > 0) setBlocks(list);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const onMove = useCallback((e: React.MouseEvent) => {
    const box = containerRef.current?.getBoundingClientRect();
    if (!box) return;
    // 浮层避让：靠近右/下边缘时翻转
    const TIP_W = 268;
    const TIP_H = 230;
    let x = e.clientX - box.left + 16;
    let y = e.clientY - box.top + 14;
    if (x + TIP_W > box.width) x = e.clientX - box.left - TIP_W - 12;
    if (y + TIP_H > box.height) y = Math.max(8, e.clientY - box.top - TIP_H - 8);
    setTipPos({ x, y });
  }, []);

  const visible = blocks.filter((b) => {
    const rd = readings[b.id];
    if (filter === "abnormal") return rd && (rd.status === "climate" || rd.status === "pest");
    if (filter === "pest") return rd?.hasPest;
    return true;
  });
  const dimmed = new Set(blocks.filter((b) => !visible.includes(b)).map((b) => b.id));
  const hovered = hoverId ? readings[hoverId] : undefined;
  const hoveredBlock = hoverId ? blocks.find((b) => b.id === hoverId) : undefined;
  /** 是否已有基于真实气象的区块读数（无读数时网格整体呈「数据缺失」态） */
  const hasAnyReading = Object.keys(readings).length > 0;

  return (
    <div className="flex flex-col rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
      {/* 头部：标题 + 图例 + 筛选 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-bold tracking-tight">东岭示范田 · 区块检测视图</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {hasAnyReading
              ? "6 × 4 共 24 个独立检测区块，悬浮查看最近一次上报数据"
              : "尚未收到基于真实气象的区块读数：请先采集全田气象，再触发设备上报"}
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-full border border-border/70 bg-secondary/60 p-1 text-xs">
          {(
            [
              ["all", "全部"],
              ["abnormal", "仅异常"],
              ["pest", "仅有病虫害"],
            ] as [Filter, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={cn(
                "rounded-full px-3 py-1 font-medium transition-all",
                filter === key
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* 网格 */}
      <div ref={containerRef} onMouseMove={onMove} className="relative mt-4">
        <div className="grid grid-cols-6 gap-2 sm:gap-2.5">
          {blocks.map((block) => {
            const rd = readings[block.id];
            const status = rd?.status ?? "offline";
            const isDim = dimmed.has(block.id);
            const crop = CROPS[block.cropId];
            return (
              <button
                key={block.id}
                type="button"
                onMouseEnter={() => setHoverId(block.id)}
                onMouseLeave={() => setHoverId(null)}
                onClick={() =>
                  void navigate({ to: "/stats", search: { block: block.id } })
                }
                className={cn(
                  STATUS_STYLE[status],
                  "group relative flex aspect-square flex-col justify-between overflow-hidden rounded-lg p-2 text-left text-primary-foreground outline-none transition-all duration-200",
                  "ring-offset-2 hover:-translate-y-0.5 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring",
                  status === "pest" && "pest-pulse",
                  isDim && "opacity-25 saturate-50",
                  hoverId === block.id && "z-10 ring-2 ring-field-deep/70",
                )}
                aria-label={`区块 ${block.id}，${STATUS_LABEL[status]}`}
              >
                <span className="furrow-texture absolute inset-0 opacity-40" aria-hidden />
                <span className="relative flex items-start justify-between">
                  <span className="font-mono text-[11px] font-bold tracking-wide">{block.id}</span>
                  {status === "pest" && <Bug className="size-3.5" strokeWidth={2.5} />}
                  {status === "climate" && <CircleAlert className="size-3.5" strokeWidth={2.5} />}
                  {status === "offline" && <CloudOff className="size-3.5" strokeWidth={2.5} />}
                </span>
                <span className="relative hidden sm:block">
                  <span className="tnum block text-[11px] font-semibold leading-tight">
                    {rd && status !== "offline" ? `${rd.temp.toFixed(1)}℃` : "—"}
                  </span>
                  <span className="tnum block text-[10px] leading-tight text-primary-foreground/75">
                    {rd && status !== "offline" ? `${rd.humid.toFixed(0)}%RH` : ""}
                  </span>
                  <span className="mt-0.5 block truncate text-[9px] text-primary-foreground/70">
                    {crop.name}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        {/* 悬浮详情浮层 */}
        {hovered && hoveredBlock && tipPos && (
          <div
            className="tip-in pointer-events-none absolute z-20 w-[268px] rounded-xl border border-border bg-popover/95 p-4 shadow-xl backdrop-blur"
            style={{ left: tipPos.x, top: tipPos.y }}
          >
            <BlockTip reading={hovered} block={hoveredBlock} />
          </div>
        )}
      </div>

      {/* 图例 */}
      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border/60 pt-3 text-xs text-muted-foreground">
        {(
          [
            ["bg-block-ok", "正常"],
            ["bg-block-warn", "温湿度异常"],
            ["bg-block-danger", "存在病虫害"],
            ["bg-block-offline", "数据缺失"],
          ] as [string, string][]
        ).map(([c, label]) => (
          <span key={label} className="flex items-center gap-1.5">
            <span className={cn("size-3 rounded-[4px]", c)} />
            {label}
          </span>
        ))}
        <span className="ml-auto flex items-center gap-1.5">
          <LineChart className="size-3.5" /> 点击区块可查看历史曲线
        </span>
      </div>
    </div>
  );
}

function BlockTip({ reading, block }: { reading: Reading; block: FarmBlock }) {
  const crop = CROPS[block.cropId] ?? CROPS.corn;
  const pest = findPest(reading.pestCode);
  const offline = reading.status === "offline";
  const [tLo, tHi] = crop.range.temp;
  const [hLo, hHi] = crop.range.humid;
  const tempOut = !offline && (reading.temp < tLo || reading.temp > tHi);
  const humidOut = !offline && (reading.humid < hLo || reading.humid > hHi);

  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 font-mono text-sm font-bold">
          <Sprout className="size-4 text-primary" /> 区块 {block.id}
        </span>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[10px] font-semibold",
            reading.status === "normal" && "bg-block-ok/15 text-field-deep",
            reading.status === "climate" && "bg-block-warn/20 text-clay",
            reading.status === "pest" && "bg-destructive/12 text-destructive",
            offline && "bg-muted text-muted-foreground",
          )}
        >
          {STATUS_LABEL[reading.status]}
        </span>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        {crop.emoji} {crop.name} · {block.areaMu.toFixed(1)} 亩 · 适宜 {tLo}–{tHi}℃ / {hLo}–{hHi}%RH
      </p>

      {offline ? (
        <div className="mt-3 rounded-lg bg-muted/70 px-3 py-4 text-center text-xs text-muted-foreground">
          <CloudOff className="mx-auto mb-1.5 size-5" />
          该区块传感器离线
          <br />
          最后上报于 {relativeTime(reading.collectedAt)}
        </div>
      ) : (
        <dl className="mt-3 grid grid-cols-2 gap-2">
          <Metric label="温度" value={`${reading.temp.toFixed(1)} ℃`} warn={tempOut} />
          <Metric label="湿度" value={`${reading.humid.toFixed(1)} %RH`} warn={humidOut} />
        </dl>
      )}

      {!offline && (
        <div
          className={cn(
            "mt-2 flex items-start gap-2 rounded-lg px-3 py-2 text-xs",
            reading.hasPest ? "bg-destructive/10 text-destructive" : "bg-block-ok/12 text-field-deep",
          )}
        >
          {reading.hasPest ? (
            <>
              <Bug className="mt-0.5 size-3.5 shrink-0" />
              <span>
                存在病虫害：<b>{pest?.name ?? "未定性"}</b>
                {pest && `（${reading.pestLevel === "high" ? "重度" : reading.pestLevel === "medium" ? "中度" : "轻度"}风险）`}
              </span>
            </>
          ) : (
            <span className="flex items-center gap-2">
              <Sprout className="size-3.5 shrink-0" /> 未发现病虫害
            </span>
          )}
        </div>
      )}
      <p className="mt-2.5 text-right text-[10px] text-muted-foreground">
        采集时间 {relativeTime(reading.collectedAt)}
      </p>
    </div>
  );
}

function Metric({ label, value, warn }: { label: string; value: string; warn: boolean }) {
  return (
    <div className={cn("rounded-lg border border-border/60 px-2.5 py-2", warn && "border-block-warn/60 bg-block-warn/10")}>
      <dt className="text-[10px] text-muted-foreground">{label}</dt>
      <dd className={cn("tnum mt-0.5 text-sm font-bold", warn && "text-clay")}>{value}</dd>
    </div>
  );
}

export { COLS, ROW_COUNT };

