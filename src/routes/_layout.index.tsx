// 首页：左栏（预警推送 + 全田概览）+ 右栏（农田区块网格，约 3/4 宽、向右靠齐）
import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { AlertCircle, CloudSun, Eye, RefreshCw, Sprout } from "lucide-react";
import { AlertFeed } from "@/components/AlertFeed";
import { FarmGrid } from "@/components/FarmGrid";
import { FieldOverview } from "@/components/FieldOverview";
import { useFarmLive } from "@/lib/farm-live";
import { triggerWeather } from "@/lib/farm-service";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_layout/")({
  component: HomePage,
});

function HomePage() {
  const { snapshot, loading, error, countdown, refreshing, canWrite, refresh } = useFarmLive();
  const [weatherMsg, setWeatherMsg] = useState<string | null>(null);
  const [weatherBusy, setWeatherBusy] = useState(false);

  const pullWeather = async () => {
    setWeatherBusy(true);
    setWeatherMsg(null);
    try {
      const r = await triggerWeather();
      setWeatherMsg(`已采集全田气象（${r.station || "Open-Meteo"}），可继续触发设备上报`);
      await refresh();
    } catch (e: unknown) {
      setWeatherMsg(e instanceof Error ? e.message : "气象采集失败");
    } finally {
      setWeatherBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* 采集入口与页头操作区同行，避免独占一行造成视觉突兀 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
            <Sprout className="size-5 text-primary" />
            监测总览
          </h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            东岭示范田 · 逐区块温湿度与病虫害可视化检测
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canWrite && (
            <button
              onClick={() => void pullWeather()}
              disabled={weatherBusy}
              title="采集全田真实气象"
              aria-label="采集全田气象"
              className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-primary shadow-sm transition-all hover:bg-accent active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <CloudSun className={cn("size-[18px]", weatherBusy && "animate-spin")} />
            </button>
          )}
          <span className="tnum hidden text-xs text-muted-foreground sm:block">
            {loading ? "正在同步…" : canWrite ? `${countdown}s 后刷新` : "游客只读"}
          </span>
          <button
            onClick={() => void refresh()}
            disabled={refreshing}
            title={canWrite ? "触发设备采集上报并刷新数据" : "仅重新读取云端已有数据，不会触发设备上报"}
            className="flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-[13px] font-medium transition-all hover:bg-accent active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {canWrite ? (
              <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
            ) : (
              <Eye className="size-3.5" />
            )}
            {canWrite ? "立即刷新" : "只读刷新"}
          </button>
        </div>
      </div>

      {weatherMsg && (
        <p className="text-[12px] text-muted-foreground">{weatherMsg}</p>
      )}

      {!canWrite && (
        <div className="flex items-start gap-2 rounded-xl border border-block-warn/40 bg-block-warn/10 px-4 py-2.5 text-[13px] text-clay">
          <Eye className="mt-0.5 size-4 shrink-0" />
          <span>
            游客模式下页面展示云端已采集的数据快照，可正常查看区块、预警与报表；「只读刷新」仅重新读取数据，不会触发设备上报。
          </span>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/8 px-4 py-2.5 text-[13px] text-destructive">
          <AlertCircle className="size-4 shrink-0" />
          {error}
        </div>
      )}

      {!snapshot ? (
        <div className="grid min-h-[60vh] place-items-center rounded-2xl border border-border/70 bg-card">
          <div className="flex flex-col items-center gap-3 text-muted-foreground">
            <Sprout className="size-8 animate-pulse text-primary" />
            <p className="text-sm">正在加载田间监测数据…</p>
          </div>
        </div>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-4">
          <aside className="order-2 flex flex-col gap-4 lg:order-1 lg:col-span-1">
            <AlertFeed alerts={snapshot.alerts} />
            <FieldOverview stats={snapshot.overview} />
          </aside>
          <div className="order-1 lg:order-2 lg:col-span-3">
            <FarmGrid readings={snapshot.readings} />
          </div>
        </div>
      )}
    </div>
  );
}
