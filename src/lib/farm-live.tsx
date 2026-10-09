// 监测数据实时上下文：首屏拉取 + Realtime 订阅 + 定时触发设备上报。
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { supabase } from "@/supabase/client";
import { useAuth } from "./auth";
import { fetchSnapshot, triggerReport, type Snapshot } from "./farm-service";

const REFRESH_SECONDS = 30;

interface FarmLiveValue {
  snapshot: Snapshot | null;
  loading: boolean;
  error: string | null;
  countdown: number;
  refreshing: boolean;
  /** 游客为 false：只读刷新，不触发设备上报 */
  canWrite: boolean;
  refresh: () => Promise<void>;
}

const FarmLiveContext = createContext<FarmLiveValue | null>(null);

export function FarmLiveProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(REFRESH_SECONDS);
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const snap = await fetchSnapshot();
      if (!mounted.current) return;
      setSnapshot(snap);
      setError(null);
    } catch (e) {
      if (!mounted.current) return;
      setError(e instanceof Error ? e.message : "加载监测数据失败");
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  // 每次上报后重新聚合快照（realtime 高频变更时合并请求）
  const reloadTimer = useRef<number | null>(null);
  const lastLoadAt = useRef(0);
  const tickRef = useRef(REFRESH_SECONDS);

  // 两次快照拉取之间至少间隔 1.5 秒，防止实时推送把请求量放大
  const throttledLoad = useCallback(() => {
    const wait = 1500 - (Date.now() - lastLoadAt.current);
    if (wait <= 0) {
      lastLoadAt.current = Date.now();
      void load();
      return;
    }
    if (reloadTimer.current !== null) return;
    reloadTimer.current = window.setTimeout(() => {
      reloadTimer.current = null;
      lastLoadAt.current = Date.now();
      void load();
    }, wait);
  }, [load]);

  // 实时推送到达后合并刷新；依赖固定为 load，避免订阅反复重建
  useEffect(() => {
    void load();
    const channel = supabase
      .channel("farm-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "sensor_readings" }, throttledLoad)
      .on("postgres_changes", { event: "*", schema: "public", table: "alerts" }, throttledLoad)
      .subscribe();

    return () => {
      channel.unsubscribe();
      if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current);
    };
  }, [load, throttledLoad]);

  // 登录态变化后重置倒计时并重新拉一次，确保快照与当前身份一致
  useEffect(() => {
    tickRef.current = REFRESH_SECONDS;
    setCountdown(REFRESH_SECONDS);
    void load();
  }, [load, user]);

  const canWrite = Boolean(user?.canWrite);

  const refresh = useCallback(async () => {
    if (!user) {
      setError("登录后可触发设备上报");
      return;
    }
    setRefreshing(true);
    tickRef.current = REFRESH_SECONDS;
    setCountdown(REFRESH_SECONDS);
    try {
      // 游客只读：仅重新拉取快照，不触发设备上报
      if (user.canWrite) await triggerReport();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "触发上报失败");
    } finally {
      window.setTimeout(() => setRefreshing(false), 400);
    }
  }, [load, user]);

  // 自动轮询：每 30 秒触发一次设备上报。上报接口要求登录身份，未登录时不发请求；
  // 游客为只读身份，同样不参与上报，避免每分钟产生一次 401。
  // 副作用只放在 interval 回调里，避免在 setState updater 内被 React 重复执行。
  useEffect(() => {
    if (!user?.canWrite) return;
    const timer = window.setInterval(() => {
      tickRef.current -= 1;
      if (tickRef.current > 0) {
        setCountdown(tickRef.current);
        return;
      }
      tickRef.current = REFRESH_SECONDS;
      setCountdown(REFRESH_SECONDS);
      void triggerReport().catch(() => undefined);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [user]);

  const value = useMemo(
    () => ({ snapshot, loading, error, countdown, refreshing, canWrite, refresh }),
    [snapshot, loading, error, countdown, refreshing, canWrite, refresh],
  );

  return <FarmLiveContext.Provider value={value}>{children}</FarmLiveContext.Provider>;
}

export function useFarmLive(): FarmLiveValue {
  const ctx = useContext(FarmLiveContext);
  if (!ctx) throw new Error("useFarmLive 必须在 FarmLiveProvider 内使用");
  return ctx;
}
