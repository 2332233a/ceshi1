// 区块资料维护：仅登录用户可修改指定区块的种植作物。
// 作物变更后，适宜温湿度阈值随 CROPS 配置立即变化，下一轮上报会按新作物重新判定预警。
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CROPS } from "./crops.ts";

const functionName = "update-block";

interface Payload {
  blockId?: unknown;
  cropId?: unknown;
}

Deno.serve(async (req) => {

  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST,OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      },
    })
  }

  const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};
  const requestId = crypto.randomUUID().slice(0, 8);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "未登录，无法修改区块" }), { status: 401, headers });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    if (!supabaseUrl || !anonKey) throw new Error("缺少 SUPABASE_URL / SUPABASE_ANON_KEY 环境变量");

    // 以调用者身份写入，遵守 RLS（farm_blocks UPDATE 限定 authenticated）
    const supabase = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (authError || !authData.user) {
      return new Response(JSON.stringify({ error: "登录状态无效，请重新登录" }), { status: 401, headers });
    }

    const body = (await req.json().catch(() => ({}))) as Payload;
    const blockId = typeof body.blockId === "string" ? body.blockId.trim() : "";
    const cropId = typeof body.cropId === "string" ? body.cropId.trim() : "";

    if (!blockId || !cropId) {
      return new Response(JSON.stringify({ error: "缺少区块或作物参数" }), { status: 400, headers });
    }
    if (!CROPS[cropId]) {
      return new Response(JSON.stringify({ error: `未知作物：${cropId}` }), { status: 400, headers });
    }

    const { data: existing, error: readError } = await supabase
      .from("farm_blocks")
      .select("id,crop_id")
      .eq("id", blockId)
      .maybeSingle<{ id: string; crop_id: string }>();
    if (readError) throw new Error(`读取区块失败: ${readError.message}`);
    if (!existing) {
      return new Response(JSON.stringify({ error: `区块 ${blockId} 不存在` }), { status: 404, headers });
    }

    const { error: updateError } = await supabase
      .from("farm_blocks")
      .update({ crop_id: cropId })
      .eq("id", blockId);
    if (updateError) throw new Error(`更新作物失败: ${updateError.message}`);

    console.info(`[${functionName}] success ${requestId} block=${blockId} ${existing.crop_id}->${cropId}`);
    return new Response(
      JSON.stringify({
        ok: true,
        blockId,
        cropId,
        previousCropId: existing.crop_id,
        range: { temp: CROPS[cropId].temp, humid: CROPS[cropId].humid },
      }),
      { headers },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[${functionName}] failed ${requestId}: ${message}`);
    return new Response(JSON.stringify({ error: message }), { status: 500, headers });
  }
});
