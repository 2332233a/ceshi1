// 全田温湿度概览：平均温/湿、最高最低温度及所在区块
import { Droplets, Gauge, Thermometer } from "lucide-react";
import type { OverviewStats } from "@/lib/types";
import { cn } from "@/lib/utils";

export function FieldOverview({ stats }: { stats: OverviewStats }) {
  const noData = stats.onlineCount === 0;
  const spread = stats.maxTemp.value - stats.minTemp.value;

  return (
    <section className="rounded-2xl border border-border/70 bg-card p-4 shadow-sm">
      <header className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-[14px] font-bold tracking-tight">
          <Gauge className="size-4 text-primary" strokeWidth={2.2} />
          全田温湿度概览
        </h2>
        <span className="tnum text-[11px] text-muted-foreground">
          {stats.onlineCount}/{stats.totalCount} 区块在线
        </span>
      </header>

      <div className="mt-3 grid grid-cols-2 gap-2.5">
        <BigMetric
          label="平均温度"
          value={noData ? null : stats.avgTemp.toFixed(1)}
          unit="℃"
          Icon={Thermometer}
        />
        <BigMetric
          label="平均湿度"
          value={noData ? null : stats.avgHumid.toFixed(1)}
          unit="%RH"
          Icon={Droplets}
        />
      </div>

      {/* 极值对比条 */}
      <div className="mt-3 rounded-xl border border-border/60 bg-secondary/40 p-3">
        <div className="flex items-end justify-between text-xs">
          <div>
            <p className="text-muted-foreground">最低温度</p>
            <p className="tnum mt-0.5 text-lg font-bold leading-none text-chart-3">
              {noData ? "—" : `${stats.minTemp.value.toFixed(1)}℃`}
              <span className="ml-1 font-mono text-[10px] font-semibold text-muted-foreground">
                {!noData && `#${stats.minTemp.blockId}`}
              </span>
            </p>
          </div>
          <div className="text-right">
            <p className="text-muted-foreground">最高温度</p>
            <p className="tnum mt-0.5 text-lg font-bold leading-none text-clay">
              {noData ? "—" : `${stats.maxTemp.value.toFixed(1)}℃`}
              <span className="ml-1 font-mono text-[10px] font-semibold text-muted-foreground">
                {!noData && `#${stats.maxTemp.blockId}`}
              </span>
            </p>
          </div>
        </div>
        <div className="relative mt-2.5 h-1.5 overflow-hidden rounded-full bg-block-ok/25">
          {!noData && (
            <div
              className="sheen absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-chart-3 via-block-warn to-destructive"
              style={{ width: `${Math.min(100, Math.max(18, spread * 9))}%` }}
            />
          )}
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          全田温差 <b className="tnum text-foreground">{noData ? "—" : `${spread.toFixed(1)}℃`}</b>
          ，异常区块 <b className="tnum text-clay">{stats.climateCount}</b> 个，病虫害区块{" "}
          <b className="tnum text-destructive">{stats.pestCount}</b> 个
        </p>
      </div>
    </section>
  );
}

function BigMetric({
  label,
  value,
  unit,
  Icon,
}: {
  label: string;
  value: string | null;
  unit: string;
  Icon: typeof Thermometer;
}) {
  return (
    <div className="rounded-xl border border-border/60 px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Icon className="size-3.5" strokeWidth={2} />
        {label}
      </p>
      <p className="tnum mt-1 text-2xl font-bold leading-none tracking-tight">
        {value ?? <span className={cn("text-base font-medium text-muted-foreground")}>—</span>}
        {value && <span className="ml-0.5 text-xs font-semibold text-muted-foreground">{unit}</span>}
      </p>
    </div>
  );
}
