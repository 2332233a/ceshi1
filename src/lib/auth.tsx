// 真实认证：基于 Supabase Auth（用户名 + 密码），账号档案存 profiles 表。
// 游客模式为纯前端身份：不建立 Supabase session，仅本地标记，数据只读。
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { supabase } from "@/supabase/client";

const GUEST_FLAG_KEY = "farm-guest-mode";

export interface DemoUser {
  username: string;
  displayName: string;
  role: string;
  /** 是否可触发设备上报等写操作；游客为 false */
  canWrite: boolean;
}

const GUEST_USER: DemoUser = {
  username: "guest",
  displayName: "游客",
  role: "只读浏览",
  canWrite: false,
};

interface ProfileRow {
  username: string;
  display_name: string | null;
  role_label: string | null;
}

/** 登录失败到可展示文案的映射（Supabase 返回英文错误码） */
function describeAuthError(message: string): string {
  if (/invalid login credentials/i.test(message)) return "账号或密码不正确";
  if (/email not confirmed/i.test(message)) return "账号尚未激活，请联系管理员";
  if (/rate limit|too many requests/i.test(message)) return "尝试次数过多，请稍后再试";
  return message;
}

interface AuthContextValue {
  user: DemoUser | null;
  ready: boolean;
  login: (username: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  loginAsGuest: () => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<DemoUser | null>(null);
  const [ready, setReady] = useState(false);

  const loadProfile = useCallback(async (userId: string) => {
    const { data } = await supabase
      .from("profiles")
      .select("username,display_name,role_label")
      .eq("id", userId)
      .maybeSingle<ProfileRow>();
    if (!data) return null;
    return {
      username: data.username,
      displayName: data.display_name ?? data.username,
      role: data.role_label ?? "监测员",
      canWrite: true,
    } satisfies DemoUser;
  }, []);

  useEffect(() => {
    let alive = true;

    const restore = async () => {
      try {
        const { data } = await supabase.auth.getSession();
        const uid = data.session?.user.id;
        if (uid) {
          if (alive) setUser(await loadProfile(uid));
          return;
        }
        // 无 Supabase session 时检查游客标记（会话级，关闭标签页自动失效）
        if (alive && sessionStorage.getItem(GUEST_FLAG_KEY) === "1") setUser(GUEST_USER);
      } catch {
        // 会话恢复失败按未登录处理，由路由守卫跳转登录页
      } finally {
        if (alive) setReady(true);
      }
    };
    void restore();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      const uid = session?.user.id;
      if (!uid) {
        // 真实账号登出后清掉游客标记；若仍是游客则保持游客身份
        sessionStorage.removeItem(GUEST_FLAG_KEY);
        setUser((cur) => (cur?.username === GUEST_USER.username ? cur : null));
        return;
      }
      // 必须在回调外异步调用，避免与 auth 内部锁死锁
      setTimeout(() => {
        void loadProfile(uid).then((u) => {
          if (alive) setUser(u);
        });
      }, 0);
    });

    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, [loadProfile]);

  const login = useCallback(
    async (username: string, password: string) => {
      const name = username.trim().toLowerCase();
      if (!name || !password) return { ok: false, error: "账号与密码均为必填项" };
      const { error } = await supabase.auth.signInWithPassword({
        email: `${name}@outlook.com`,
        password,
      });
      if (error) return { ok: false, error: describeAuthError(error.message) };
      sessionStorage.removeItem(GUEST_FLAG_KEY);
      return { ok: true };
    },
    [],
  );

  const loginAsGuest = useCallback(() => {
    sessionStorage.setItem(GUEST_FLAG_KEY, "1");
    setUser(GUEST_USER);
  }, []);

  const logout = useCallback(() => {
    sessionStorage.removeItem(GUEST_FLAG_KEY);
    setUser(null);
    void supabase.auth.signOut();
  }, []);

  const value = useMemo(() => ({ user, ready, login, loginAsGuest, logout }), [user, ready, login, loginAsGuest, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth 必须在 AuthProvider 内使用");
  return ctx;
}
