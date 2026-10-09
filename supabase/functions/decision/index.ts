// 智能决策建议：不接入 AI，按固定规则把「未处理预警 + 区块读数 + 种植作物」翻译成可执行处置方案。
// 请求体约定：{ action?: "list" | "resolve", alertId?: string }
//   - list（默认）：游客可读，返回按重要性排序的建议；
//   - resolve：必须已登录，物理删除该条预警 + 清除病虫害标记（代表已处理）。
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const functionName = "decision";
type Priority = "low" | "medium" | "high";
interface DecisionOut {
  id: string;
  block_id?: string;
  type: string;
  title: string;
  detail: string;
  priority: Priority;
  score: number;
  created_at?: string;
}
const CROPS: Record<string, { name: string; temp: [number, number]; humid: [number, number] }> = {
  corn: { name: "玉米", temp: [18, 30], humid: [55, 80] },
  rice: { name: "水稻", temp: [20, 33], humid: [70, 92] },
  wheat: { name: "小麦", temp: [12, 26], humid: [45, 70] },
  cotton: { name: "棉花", temp: [20, 32], humid: [50, 75] },
  cucumber: { name: "黄瓜", temp: [16, 30], humid: [60, 85] },
};
const PEST_CONTROL: Record<string, { title: string; detail: string }> = {
  "cotton_bollworm": {
    title: "棉铃虫防治：低龄期用药 + 赤眼蜂控卵",
    detail: "卵孵化盛至低龄幼虫期用氯虫苯甲酰胺悬浮剂均匀喷雾，心叶期可按剂量点施颗粒剂封心；同时释放赤眼蜂每亩 1.5 万头、分两次投放寄生卵块。及时抹芽打顶、摘除虫害蕾铃带出田外，秋后深耕耙地灭蛹压低越冬基数。",
  },
  "cotton_aphid": {
    title: "棉蚜防控：先护天敌，超标再点治",
    detail: "百株蚜量超过防治指标时用啶虫脒低容量喷雾，重点喷叶背与生长点；优先保护瓢虫、草蛉、食蚜蝇，悬挂黄板监测、银灰膜驱避有翅蚜。早春铲除田边寄主杂草，开花期避开施药以保护蜜蜂。",
  },
  "locust": {
    title: "蝗虫应急：抓住 3 龄前跳蝻窗口",
    detail: "3 龄前跳蝻聚集期是防治关键窗口，用马拉硫磷或高效氯氟氰菊酯带路喷边、封锁扩散路径；成虫迁飞高峰对田边与未成熟地块加密施药。有条件的地块组织牧鸡牧鸭（每亩 10–15 只）生物控害，并施用绿僵菌处理孳生地。",
  },
  "wheat_red_mite": {
    title: "麦红蜘蛛挑治：灌水压虫 + 叶背茎基部施药",
    detail: "点片发生期挑治，阿维菌素或螺螨酯重点喷茎基部与叶背，间隔 7 天复评虫口密度后再决定是否二次施药。适时灌水调节田间湿度可有效抑制繁殖，清除地头杂草与残株降低虫源，注意轮换用药防止抗性。",
  },
  "wheat_aphid": {
    title: "麦蚜控害：达标穗期施药并兼顾传毒",
    detail: "百株蚜量达防治指标时用啶虫脒或吡虫啉低容量喷雾，穗期施药避开扬花盛期；麦二叉蚜兼传小麦黄矮病，控蚜即是控毒。慎用广谱杀虫剂以保护瓢虫、食蚜蝇与蚜茧蜂，可设银灰色条带驱避有翅蚜。",
  },
  "fusarium_head_blight": {
    title: "赤霉病预防：扬花期主动打药，不等见病斑",
    detail: "扬花 50%–70% 时主动预防一次（氰烯菌酯或咪鲜胺），施药后 5–7 天内遇雨必须补防——该病一旦见病斑再治已基本无效。开沟排水降低田间湿度、控制氮肥防倒伏，深耕掩埋秸秆加速腐熟减少初侵染源。",
  },
  "wheat_rust": {
    title: "小麦锈病压制：发病初期唑类药剂二次施药",
    detail: "发病初期用三唑酮或戊唑醇乳油喷雾，病叶率超过 5% 时隔 10–14 天二次施药。夏孢子随气流长距离传播并重复侵染，需适期播种控制密度、避免偏施氮肥，及时清除自生麦苗减少桥梁寄主。",
  },
  "powdery_mildew": {
    title: "白粉病治理：改善通风 + 轮换机理药剂",
    detail: "发病初期三唑酮或醚菌酯喷雾，重点打中下部叶片；该病抗药性风险高，须轮换不同作用机理药剂并间隔 7–10 天。合理密植、及时整枝打叶改善通风透光，控制氮肥增施磷钾防徒长，清除病残体深翻减少越冬闭囊壳。",
  },
};
const PEST_FALLBACK = {
  title: "病虫害处置：先核实种类再对症用药",
  detail: "该检出编码不在系统档案内，请先人工核对受害部位与病症特征，确认种类后按对应技术规程施药；期间保留现场影像并加密巡查，避免盲目扩大用药造成抗性风险。",
};
const CLIMATE_CONTROL: Record<string, { title: string; detail: string }> = {
  temp_low: {
    title: "低温冷害应对：{crop}需抬温至 {lo}℃ 以上",
    detail: "当前温度 {value}℃ 低于适宜下限 {lo}℃。设施地块加盖保温膜、夜间小水勤灌利用水体蓄热；露地可熏烟或喷防冻剂减轻霜冻。连续 3 天低于下限时推迟追肥、暂缓浇水，待回暖再恢复管理。",
  },
  temp_high: {
    title: "高温热害应对：{crop}需降到 {hi}℃ 以下",
    detail: "当前温度 {value}℃ 高于适宜上限 {hi}℃。早晚通风降温、覆盖遮阳网削弱辐射，灌溉避开正午改为清晨或傍晚；抽穗扬花期遇持续高温需警惕结实率下降，可适当叶面补水肥缓解。",
  },
  humid_low: {
    title: "田间干燥应对：{crop}补湿到 {lo}%RH 以上",
    detail: "当前湿度 {value}%RH 低于适宜下限 {lo}%RH。滴灌补湿或清晨叶面喷水调湿，暂缓喷粉类药剂以免飘失失效；干燥条件同时利于螨类与蚜虫增殖，应加密虫口调查。",
  },
  humid_high: {
    title: "高湿渍害应对：{crop}需排湿到 {hi}%RH 以下",
    detail: "当前湿度 {value}%RH 高于适宜上限 {hi}%RH。开沟排水、加大株行间通风，避免在湿度过高时段施药；长期高湿会显著推高锈病、赤霉病与白粉病的流行风险，应优先安排预防性用药。",
  },
};
const OFFLINE_CONTROL = {
  title: "设备离线排查：恢复上报前该区块数据不可信",
  detail: "该区块本轮无有效读数，请先检查传感器供电、通讯链路与安装位置；在数据恢复之前，不要依据空白状态做出灌溉或施药判断，必要时人工巡田补录观测值。",
};
const PEST_NAME: Record<string, string> = {
  "cotton_bollworm": "棉铃虫",
  "cotton_aphid": "棉蚜",
  "locust": "蝗虫",
  "wheat_red_mite": "麦红蜘蛛",
  "wheat_aphid": "麦蚜",
  "fusarium_head_blight": "赤霉病",
  "wheat_rust": "小麦锈病",
  "powdery_mildew": "白粉病",
};
const LEVEL_LABEL: Record<string, string> = { high: "重度", medium: "中度", low: "轻度" };
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    },
  });
}
function firstNumber(text: string): number | null {
  const m = /(-?\d+(?:\.\d+)?)/.exec(text);
  return m ? Number(m[1]) : null;
}
function cropOf(cropId: string | null | undefined) {
  return CROPS[cropId ?? ""] ?? CROPS.corn;
}
function toDecision(
  alert: { id: string; block_id: string; type: string; severity: string; message: string; created_at: string },
  cropId: string | null | undefined,
  pestCode: string | null | undefined,
  pestLevel: string | null | undefined,
): DecisionOut {
  const crop = cropOf(cropId);
  if (alert.type === "pest") {
    const doc = pestCode ? PEST_CONTROL[pestCode] : undefined;
    const label = LEVEL_LABEL[pestLevel ?? ""] ?? "";
    const base = doc ?? PEST_FALLBACK;
    const score = pestLevel === "high" ? 100 : pestLevel === "medium" ? 70 : 55;
    return {
      id: alert.id,
      block_id: alert.block_id,
      type: alert.type,
      title: `${label ? `${label}·` : ""}${base.title}`,
      detail: `${alert.message}${pestCode && PEST_NAME[pestCode] ? `（${PEST_NAME[pestCode]}）` : ""}，${crop.name}田块。${base.detail}`,
      priority: pestLevel === "high" ? "high" : "medium",
      score,
      created_at: alert.created_at,
    };
  }
  const tpl = CLIMATE_CONTROL[alert.type];
  if (!tpl) {
    return {
      id: alert.id,
      block_id: alert.block_id,
      type: alert.type,
      title: "异常预警复核",
      detail: alert.message,
      priority: "low",
      score: 30,
      created_at: alert.created_at,
    };
  }
  const value = firstNumber(alert.message);
  let lo = crop.temp[0];
  let hi = crop.temp[1];
  if (alert.type === "humid_low" || alert.type === "humid_high") {
    lo = crop.humid[0];
    hi = crop.humid[1];
  }
  const fill = (s: string) =>
    s.replaceAll("{crop}", crop.name).replaceAll("{lo}", String(lo)).replaceAll("{hi}", String(hi)).replaceAll("{value}", value === null ? "—" : String(value));
  let score: number;
  let priority: Priority;
  if (alert.type === "temp_high" && alert.severity === "urgent") {
    score = 95;
    priority = "high";
  } else if (alert.type === "temp_high" || alert.type === "temp_low") {
    score = 60;
    priority = "medium";
  } else {
    score = 35;
    priority = "low";
  }
  return {
    id: alert.id,
    block_id: alert.block_id,
    type: alert.type,
    title: fill(tpl.title),
    detail: `${alert.message}。${fill(tpl.detail)}`,
    priority,
    score,
    created_at: alert.created_at,
  };
}
Deno.serve(async (req) => {
  const requestId = crypto.randomUUID().slice(0, 8);
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  }
  if (req.method !== "POST") {
    return json({ ok: false, error: "仅支持 POST 请求" }, 405);
  }
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const authHeader = req.headers.get("Authorization");
  if (!supabaseUrl || !anonKey) {
    console.error(`[${functionName}] missing env ${requestId}`);
    return json({ ok: false, error: "服务未正确配置，缺少必要环境变量" }, 500);
  }
  const supabase = createClient(supabaseUrl, anonKey, {
    global: authHeader ? { headers: { Authorization: authHeader } } : undefined,
  });
  let userId: string | null = null;
  if (authHeader) {
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user) {
      console.warn(`[${functionName}] unauthorized ${requestId}`);
      return json({ ok: false, error: "登录状态已失效，请重新登录" }, 401);
    }
    userId = userData.user.id;
  } else {
    console.info(`[${functionName}] anonymous read-only ${requestId}`);
  }
  let payload: { action?: string; alertId?: string } = {};
  try {
    payload = (await req.json()) as typeof payload;
  } catch {
    payload = {};
  }
  try {
    // ---- resolve：删除预警 + 清除病虫害标记（如果是虫情预警），必须登录 ----
    if (payload.action === "resolve") {
      if (!userId) {
        return json({ ok: false, error: "请先登录后再处理预警" }, 401);
      }
      const alertId = (payload.alertId ?? "").trim();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(alertId)) {
        return json({ ok: false, error: "预警标识不合法" }, 400);
      }
      // 先查出这条预警的 block_id 和 type
      const { data: alertRow, error: findErr } = await supabase
        .from("alerts")
        .select("id, block_id, type")
        .eq("id", alertId)
        .single();
      if (findErr || !alertRow) {
        return json({ ok: false, error: "该预警已不存在或已被新一轮上报替换" });
      }
      // 删除预警行
      const { error: delErr } = await supabase.from("alerts").delete().eq("id", alertId);
      if (delErr) {
        console.error(`[${functionName}] resolve delete alert failed ${requestId}: ${delErr.message}`);
        return json({ ok: false, error: `删除预警失败：${delErr.message}` }, 500);
      }
      // 如果是病虫害预警，同时清除 sensor_readings 里的病虫害标记
      // 这样下一轮 report-tick 读取 externalPestMap 时，该区块就不会再被标记为有虫
      if (alertRow.type === "pest" && alertRow.block_id) {
        const { error: clearErr } = await supabase
          .from("sensor_readings")
          .update({
            has_pest: false,
            pest_code: null,
            pest_level: null,
            status: "normal",
          })
          .eq("block_id", alertRow.block_id);
        if (clearErr) {
          console.warn(`[${functionName}] 清除病虫害标记失败 ${requestId}: ${clearErr.message}`);
          // 不阻塞，预警已删除，只是下一轮可能重新生成
        } else {
          console.info(`[${functionName}] cleared pest mark for block ${alertRow.block_id}`);
        }
      }
      console.info(`[${functionName}] resolved ${requestId} alert=${alertId.slice(0, 8)} type=${alertRow.type}`);
      return json({ ok: true, removed: 1 });
    }
    // ---- list：拉取判据并按固定规则生成建议 ----
    const [alertsRes, blocksRes, readingsRes] = await Promise.all([
      supabase
        .from("alerts")
        .select("id,block_id,type,severity,message,created_at")
        .eq("resolved", false)
        .order("created_at", { ascending: false })
        .limit(100),
      supabase.from("farm_blocks").select("id,crop_id"),
      supabase
        .from("sensor_readings")
        .select("block_id,pest_code,pest_level,temp,humid,status,collected_at")
        .order("collected_at", { ascending: false })
        .limit(500),
    ]);
    if (alertsRes.error) throw new Error(`读取预警失败：${alertsRes.error.message}`);
    const cropByBlock = new Map((blocksRes.data ?? []).map((b) => [b.id as string, b.crop_id as string]));
    const readingByBlock = new Map<string, Record<string, unknown>>();
    for (const r of readingsRes.data ?? []) {
      const key = r.block_id as string;
      if (!readingByBlock.has(key)) readingByBlock.set(key, r as Record<string, unknown>);
    }
    const decisions: DecisionOut[] = (alertsRes.data ?? []).map((a) => {
      const rd = readingByBlock.get(a.block_id as string);
      return toDecision(
        a as { id: string; block_id: string; type: string; severity: string; message: string; created_at: string },
        cropByBlock.get(a.block_id as string),
        (rd?.pest_code as string) ?? null,
        (rd?.pest_level as string) ?? null,
      );
    });
    for (const [blockId, rd] of readingByBlock) {
      if (rd.status !== "offline") continue;
      decisions.push({
        id: `offline:${blockId}`,
        block_id: blockId,
        type: "offline",
        title: OFFLINE_CONTROL.title,
        detail: OFFLINE_CONTROL.detail,
        priority: "medium",
        score: 65,
        created_at: (rd.collected_at as string) ?? undefined,
      });
    }
    decisions.sort((a, b) => b.score - a.score || (a.block_id ?? "").localeCompare(b.block_id ?? ""));
    console.info(
      `[${functionName}] success ${requestId} alerts=${alertsRes.data?.length ?? 0} decisions=${decisions.length}`,
    );
    return json({
      ok: true,
      decisions,
      generatedAt: new Date().toISOString(),
      scope: { openAlerts: alertsRes.data?.length ?? 0, blocks: cropByBlock.size },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[${functionName}] failed ${requestId}: ${message}`);
    return json({ ok: false, error: message }, 500);
  }
});
