// 预警推送列表：温湿度异常 + 病虫害提醒，倒序展示
import { Bug, Droplets, Thermometer, TriangleAlert } from "lucide-react";
import { relativeTime } from "@/lib/farm-service";
import { ALERT_TYPE_LABEL, type AlertItem, type Severity } from "@/lib/types";
import { cn } from "@/lib/utils";

const SEV_STYLE: Record<Severity, { chip: string; dot: string }> = {
  urgent: { chip: "bg-destructive/12 text-destructive", dot: "bg-block-danger" },
  warning: { chip: "bg-block-warn/20 text-clay", dot: "bg-block-warn" },
  info: { chip: "bg-secondary text-secondary-foreground", dot: "bg-muted-foreground/50" },
};

export function AlertFeed({ alerts }: { alerts: AlertItem[] }) {
  const pending = alerts.filter((a) => !a.resolved).length;

  return (
    <section className="flex flex-col rounded-2xl border border-border/70 bg-card shadow-sm">
      <header className="flex items-center justify-between border-b border-border/60 px-4 py-3">
        <h2 className="flex items-center gap-2 text-[14px] font-bold tracking-tight">
          <TriangleAlert className="size-4 text-clay" strokeWidth={2.2} />
          预警推送
        </h2>
        <span
          className={cn(
            "tnum rounded-full px-2 py-0.5 text-[11px] font-semibold",
            pending > 0 ? "bg-destructive/12 text-destructive" : "bg-secondary text-muted-foreground",
          )}
        >
          {pending > 0 ? `${pending} 条待处理` : "全部已处理"}
        </span>
      </header>

      <div className="max-h-[420px] overflow-y-auto px-2 py-2">
        {alerts.length === 0 ? (
          <div className="flex min-h-[180px] flex-col items-center justify-center gap-2 text-center text-xs text-muted-foreground">
            <Bug className="size-6 opacity-40" />
            暂无预警，田间状态良好
          </div>
        ) : (
          <ul className="space-y-1">
            {alerts.map((a, i) => (
              <li
                key={a.id}
                className="alert-slide-in group rounded-xl px-2.5 py-2 transition-colors hover:bg-secondary/70"
                style={{ animationDelay: `${Math.min(i, 8) * 45}ms` }}
              >
                <div className="flex items-start gap-2.5">
                  <span
                    className={cn(
                      "mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg",
                      SEV_STYLE[a.severity].chip,
                    )}
                  >
                    <AlertIcon type={a.type} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 text-[12.5px] font-semibold leading-snug">
                      <span className={cn("size-1.5 shrink-0 rounded-full", SEV_STYLE[a.severity].dot)} />
                      {ALERT_TYPE_LABEL[a.type]}
                      <span className="font-mono text-[11px] font-bold text-primary">#{a.blockId}</span>
                    </p>
                    <p className="mt-0.5 truncate text-[11.5px] text-muted-foreground" title={a.message}>
                      {a.message}
                    </p>
                    <p className="mt-0.5 text-[10.5px] text-muted-foreground/70">{relativeTime(a.createdAt)}</p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function AlertIcon({ type }: { type: AlertItem["type"] }) {
  if (type === "pest") return <Bug className="size-4" strokeWidth={2.2} />;
  if (type.startsWith("temp")) return <Thermometer className="size-4" strokeWidth={2.2} />;
  return <Droplets className="size-4" strokeWidth={2.2} />;
}
