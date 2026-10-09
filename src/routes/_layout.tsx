// 登录后共享壳层：顶部导航栏（首页 / 数据统计报表 / 智能决策建议）+ 路由守卫
import { useEffect, useState } from "react";
import { Link, Outlet, createFileRoute, useLocation, useNavigate } from "@tanstack/react-router";
import { BarChart3, BrainCircuit, Eye, Home, Leaf, LogOut, Sprout, UserRound } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_layout")({
  component: LayoutShell,
});

const NAV_ITEMS = [
  { to: "/", label: "首页", Icon: Home },
  { to: "/stats", label: "数据统计报表", Icon: BarChart3 },
  { to: "/decision", label: "智能决策建议", Icon: BrainCircuit },
] as const;

// 导航高亮：按路径前缀匹配，保证 /stats、/decision 进入后仍能看到当前所在栏目
function isNavActive(pathname: string, to: string) {
  if (to === "/") return pathname === "/";
  return pathname === to || pathname.startsWith(`${to}/`);
}

function LayoutShell() {
  const { user, ready, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  // 路由守卫：未登录一律回登录页（replace 避免历史堆叠）
  useEffect(() => {
    if (ready && !user) {
      void navigate({ to: "/login", replace: true });
    }
  }, [ready, user, navigate]);

  useEffect(() => setMenuOpen(false), [location.pathname]);

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Sprout className="size-8 animate-pulse text-primary" />
      </div>
    );
  }
  if (!user) return null; // 正在跳转登录页

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b border-border/70 bg-card/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-[1600px] items-center gap-4 px-4 sm:px-6">
          {/* 品牌 */}
          <Link to="/" className="flex shrink-0 items-center gap-2.5">
            <span className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground shadow-sm">
              <Leaf className="size-5" strokeWidth={2.2} />
            </span>
            <span className="hidden leading-tight sm:block">
              <span className="block text-[15px] font-bold tracking-tight">田眼监测</span>
              <span className="block text-[11px] text-muted-foreground">Farmland Watch</span>
            </span>
          </Link>

          {/* 导航 */}
          <nav className="mx-auto flex items-center gap-1 rounded-full border border-border/70 bg-secondary/60 p-1">
            {NAV_ITEMS.map(({ to, label, Icon }) => {
              const active = isNavActive(location.pathname, to);
              return (
                <Link
                  key={to}
                  to={to}
                  className={cn(
                    "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-medium transition-all duration-200 sm:px-4",
                    active
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  )}
                >
                  <Icon className="size-4" strokeWidth={2} />
                  <span className="hidden xs:inline sm:inline">{label}</span>
                </Link>
              );
            })}
          </nav>

          {/* 用户菜单 */}
          <div className="relative shrink-0">
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className="flex items-center gap-2 rounded-full border border-border/70 bg-card py-1 pl-1 pr-3 transition-colors hover:bg-accent"
            >
              <span className="grid size-7 place-items-center rounded-full bg-field-deep text-card">
                {user.canWrite ? <UserRound className="size-4" /> : <Eye className="size-4" />}
              </span>
              <span className="hidden text-[13px] font-medium md:block">{user.displayName}</span>
            </button>
            {menuOpen && (
              <div className="tip-in absolute right-0 top-full mt-2 w-52 overflow-hidden rounded-xl border border-border bg-popover shadow-lg">
                <div className="border-b border-border/60 px-4 py-3">
                  <p className="text-[13px] font-semibold">{user.displayName}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {user.role} · @{user.username}
                  </p>
                </div>
                {!user.canWrite && (
                  <p className="border-b border-border/60 bg-secondary/40 px-4 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
                    游客身份仅可浏览数据，无法触发设备上报等修改操作。
                  </p>
                )}
                <button
                  onClick={() => {
                    logout();
                    void navigate({ to: "/login", replace: true });
                  }}
                  className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[13px] text-destructive transition-colors hover:bg-destructive/10"
                >
                  <LogOut className="size-4" />
                  退出登录
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {!user.canWrite && (
        <div className="border-b border-block-warn/40 bg-block-warn/12">
          <div className="mx-auto flex max-w-[1600px] items-center gap-2 px-4 py-2 text-[12px] text-clay sm:px-6">
            <Eye className="size-3.5 shrink-0" />
            <span>游客浏览模式：全部监测数据可查看，采集上报等修改操作已禁用。</span>
            <Link
              to="/login"
              className="ml-auto shrink-0 font-semibold underline-offset-4 hover:underline"
            >
              切换账号
            </Link>
          </div>
        </div>
      )}

      <main className="mx-auto max-w-[1600px] px-4 pb-10 pt-6 sm:px-6">
        <Outlet />
      </main>
    </div>
  );
}
