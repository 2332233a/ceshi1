// 登录页：左侧品牌视觉区 + 右侧表单卡片
import { useState, type FormEvent } from "react";
import { Navigate, createFileRoute, useNavigate } from "@tanstack/react-router";
import { AlertCircle, ArrowRight, Eye, Leaf, Loader2, Lock, ShieldCheck, UserRound } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

const HERO_IMAGE =
  "/image/login.png";

function LoginPage() {
  const { user, ready, login, loginAsGuest } = useAuth();
  const navigate = useNavigate();

  if (ready && user) return <Navigate to="/" replace />;

  const goHome = () => void navigate({ to: "/", replace: true });

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <BrandPanel />
      <FormPanel onDone={goHome} login={login} loginAsGuest={loginAsGuest} />
    </div>
  );
}

function BrandPanel() {
  return (
    <aside className="furrow-texture relative hidden overflow-hidden bg-field-deep lg:block">
      <img
        src={HERO_IMAGE}
        alt="农田区块俯瞰示意图"
        className="absolute inset-0 size-full object-cover opacity-25 mix-blend-luminosity"
      />
      <div className="relative flex h-full flex-col justify-between p-12 text-primary-foreground">
        <div className="flex items-center gap-2.5">
          <span className="grid size-10 place-items-center rounded-xl bg-primary-foreground/15 backdrop-blur">
            <Leaf className="size-5" strokeWidth={2.2} />
          </span>
          <div className="leading-tight">
            <p className="text-[15px] font-bold tracking-wide">田眼监测 Farmland Watch</p>
            <p className="text-xs text-primary-foreground/65">农作物病虫害可视化检测平台</p>
          </div>
        </div>

        <div className="max-w-md">
          <h1 className="text-4xl font-bold leading-[1.2] tracking-tight">
            一块田，
            <br />
            分成 24 个会说话的区块。
          </h1>
          <p className="mt-5 text-[15px] leading-relaxed text-primary-foreground/75">
            逐区块采集温湿度与病虫害数据，异常即时推送预警。鼠标悬浮任意区块，即可看到它最近一次上报的全部细节。
          </p>
          <ul className="mt-8 space-y-3 text-sm">
            {[
              "区块级温湿度与病虫害实时状态",
              "温湿度异常 / 病虫害双通道预警推送",
              "全田平均、最高、最低温度一屏概览",
            ].map((t) => (
              <li key={t} className="flex items-center gap-2.5 text-primary-foreground/85">
                <ShieldCheck className="size-4 shrink-0 text-primary-foreground/60" />
                {t}
              </li>
            ))}
          </ul>
        </div>

        <p className="text-xs text-primary-foreground/45">© 2026 田眼监测 · 数据来自云端采集服务</p>
      </div>
    </aside>
  );
}

function FormPanel({
  login,
  loginAsGuest,
  onDone,
}: {
  login: ReturnType<typeof useAuth>["login"];
  loginAsGuest: ReturnType<typeof useAuth>["loginAsGuest"];
  onDone: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [guesting, setGuesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const invalid = !username.trim() || !password;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (invalid || submitting) return;
    setError(null);
    setSubmitting(true);
    const res = await login(username, password);
    setSubmitting(false);
    if (res.ok) onDone();
    else setError(res.error ?? "登录失败");
  }

  function onGuest() {
    if (submitting || guesting) return;
    setError(null);
    setGuesting(true);
    loginAsGuest();
    onDone();
  }

  return (
    <section className="flex items-center justify-center bg-background px-6 py-12">
      <div className="fade-up w-full max-w-sm">
        {/* 移动端顶部品牌 */}
        <div className="mb-8 flex items-center gap-2.5 lg:hidden">
          <span className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Leaf className="size-5" strokeWidth={2.2} />
          </span>
          <div className="leading-tight">
            <p className="text-[15px] font-bold">田眼监测</p>
            <p className="text-[11px] text-muted-foreground">Farmland Watch</p>
          </div>
        </div>

        <h2 className="text-2xl font-bold tracking-tight">欢迎回来</h2>
        <p className="mt-1.5 text-sm text-muted-foreground">登录后进入农田病虫害监测控制台</p>

        <form onSubmit={onSubmit} className="mt-8 space-y-4" noValidate>
          <Field label="账号" Icon={UserRound}>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="请输入管理员账号"
              autoComplete="username"
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
            />
          </Field>
          <Field label="密码" Icon={Lock}>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="请输入密码"
              autoComplete="current-password"
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
            />
          </Field>

          {touched && invalid && (
            <p className="flex items-center gap-1.5 text-xs text-destructive">
              <AlertCircle className="size-3.5" /> 账号与密码均为必填项
            </p>
          )}
          {error && (
            <p className="flex items-center gap-1.5 text-xs text-destructive">
              <AlertCircle className="size-3.5" /> {error}
            </p>
          )}

          <label className="flex cursor-pointer select-none items-center gap-2 pt-1 text-[13px] text-muted-foreground">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="size-4 accent-[oklch(0.48_0.115_152)]"
            />
            记住我，下次免登录进入
          </label>

          <button
            type="submit"
            disabled={submitting}
            className={cn(
              "group mt-2 flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-primary text-sm font-semibold text-primary-foreground transition-all duration-200",
              "hover:brightness-110 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-70",
            )}
          >
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" /> 正在验证身份…
              </>
            ) : (
              <>
                进入控制台
                <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
              </>
            )}
          </button>

          <div className="flex items-center gap-3 pt-1">
            <span className="h-px flex-1 bg-border" />
            <span className="text-[11px] text-muted-foreground">或</span>
            <span className="h-px flex-1 bg-border" />
          </div>

          <button
            type="button"
            onClick={onGuest}
            disabled={submitting || guesting}
            className={cn(
              "flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-border bg-card text-sm font-semibold text-foreground transition-all duration-200",
              "hover:border-primary/40 hover:bg-accent active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-70",
            )}
          >
            {guesting ? (
              <>
                <Loader2 className="size-4 animate-spin" /> 正在进入…
              </>
            ) : (
              <>
                <Eye className="size-4 text-muted-foreground" strokeWidth={2} />
                以游客身份浏览
              </>
            )}
          </button>
          <p className="text-center text-[11px] leading-relaxed text-muted-foreground/80">
            游客可查看全部监测数据，但不能触发设备上报等修改操作
          </p>
        </form>
      </div>
    </section>
  );
}

function Field({
  label,
  Icon,
  children,
}: {
  label: string;
  Icon: typeof UserRound;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-medium">{label}</span>
      <span className="flex h-11 items-center gap-2.5 rounded-lg border border-input bg-card px-3 transition-all focus-within:border-primary focus-within:ring-2 focus-within:ring-ring/25">
        <Icon className="size-4 shrink-0 text-muted-foreground" strokeWidth={2} />
        {children}
      </span>
    </label>
  );
}
