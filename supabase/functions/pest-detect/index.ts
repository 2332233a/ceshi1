import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const functionName = "pest-detect";

interface DetectPayload {
  imageUrl?: string;
}

interface Detection {
  code: string | null;
  label: string;
  name: string | null;
  confidence: number;
  xyxy?: [number, number, number, number];
  xyxyn?: [number, number, number, number];
}

type LabelMapItem = [rawLabel: string, code: string, nameZh: string];

const LABEL_TO_CODE: LabelMapItem[] = [
  ["corn borer", "caterpillar", "玉米螟"],
  ["asiatic corn borer", "caterpillar", "玉米螟"],
  ["stem borer", "caterpillar", "玉米螟"],
  ["borer", "caterpillar", "玉米螟"],
  ["玉米螟", "caterpillar", "玉米螟"],
  ["钻心虫", "caterpillar", "玉米螟"],
  ["cdm", "caterpillar", "玉米螟"],
  ["cotton_bollworm", "caterpillar", "棉铃虫"],
  ["cotton bollworm", "caterpillar", "棉铃虫"],
  ["棉铃虫", "caterpillar", "棉铃虫"],
  ["leaf rust", "rust", "小麦叶锈病"],
  ["wheat rust", "rust", "小麦叶锈病"],
  ["rust", "rust", "小麦叶锈病"],
  ["stripe rust", "rust", "小麦条锈病"],
  ["条锈", "rust", "小麦条锈病"],
  ["叶锈", "rust", "小麦叶锈病"],
  ["锈病", "rust", "小麦叶锈病"],
  ["leaf roll", "virus", "棉花卷叶病毒病"],
  ["curl virus", "virus", "棉花卷叶病毒病"],
  ["virus", "virus", "病毒病"],
  ["mosaic", "virus", "花叶病毒"],
  ["卷叶", "virus", "卷叶病毒病"],
  ["花叶", "virus", "花叶病毒"],
  ["病毒", "virus", "病毒病"],
  ["two-spotted spider mite", "mite", "二斑叶螨"],
  ["spider mite", "mite", "二斑叶螨"],
  ["tetranychus", "mite", "二斑叶螨"],
  ["mite", "mite", "叶螨"],
  ["叶螨", "mite", "叶螨"],
  ["红蜘蛛", "mite", "红蜘蛛"],
  ["rice blast", "blast", "稻瘟病"],
  ["magnaporthe", "blast", "稻瘟病"],
  ["blast", "blast", "稻瘟病"],
  ["稻瘟", "blast", "稻瘟病"],
  ["cotton aphid", "aphid", "棉蚜"],
  ["aphis", "aphid", "棉蚜"],
  ["aphid", "aphid", "蚜虫"],
  ["棉蚜", "aphid", "棉蚜"],
  ["蚜虫", "aphid", "蚜虫"],
];

function matchCode(raw: string): { code: string | null; label: string; name: string | null } {
  const norm = raw.trim().toLowerCase();
  for (const [key, code, name] of LABEL_TO_CODE) {
    if (norm.includes(key)) return { code, label: raw.trim(), name };
  }
  return { code: null, label: raw.trim(), name: null };
}

function extractDetections(json: unknown): Detection[] {
  const root = json as Record<string, unknown>;
  const list = (root.detections ?? root.detection ?? root.results ?? root.data ?? root.boxes ?? []) as unknown;
  if (!Array.isArray(list)) return [];
  const out: Detection[] = [];
  for (const item of list) {
    if (typeof item === "string") {
      const m = matchCode(item);
      out.push({ ...m, confidence: 0 });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const rawLabel = String(o.label ?? o.class_name ?? o.name ?? o.category ?? "").trim();
    if (!rawLabel) continue;
    const confRaw = o.confidence ?? o.score ?? o.prob ?? 0;
    let conf = Number(confRaw);
    if (Number.isFinite(conf) && conf > 1) conf = conf / 100;
    conf = Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0;
    const m = matchCode(rawLabel);
    out.push({
      ...m,
      confidence: conf,
      xyxy: Array.isArray(o.xyxy) ? (o.xyxy as number[]) as [number, number, number, number] : undefined,
      xyxyn: Array.isArray(o.xyxyn) ? (o.xyxyn as number[]) as [number, number, number, number] : undefined,
    });
  }
  return out.sort((a, b) => b.confidence - a.confidence).slice(0, 8);
}

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req) => {
  // ========== CORS 预检处理 ==========
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,apikey,Authorization",
      },
    });
  }

  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  try {
    // 1. 解析入参
    const body = await req.json().catch(() => ({}));
    const imageUrl = (body.imageUrl ?? "").trim();
    if (!/^https?:\/\//i.test(imageUrl)) {
      return new Response(JSON.stringify({ error: "缺少有效的图片地址 imageUrl" }), {
        status: 400,
        headers,
      });
    }

    // 2. 推理服务地址（从 Secrets 读取）
    const inferBase = (Deno.env.get("PEST_INFER_BASE_URL") ?? "").replace(/\/+$/, "");
    if (!inferBase) {
      return new Response(
        JSON.stringify({ error: "推理服务未配置：请在 Secrets 设置 PEST_INFER_BASE_URL" }),
        { status: 503, headers },
      );
    }

    // 3. 下载图片（60秒超时）
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);

    let imgBlob: Blob;
    try {
      const imgResp = await fetch(imageUrl, {
        headers: { "ngrok-skip-browser-warning": "1" },
        signal: controller.signal,
      });
      if (!imgResp.ok) {
        throw new Error(`下载图片失败: HTTP ${imgResp.status}`);
      }
      imgBlob = await imgResp.blob();
    } finally {
      clearTimeout(timer);
    }

    // 4. 转 FormData 上传给 FastAPI 推理服务
    const formData = new FormData();
    formData.append("file", imgBlob, "upload.jpg");

    let inferResp: Response;
    try {
      inferResp = await fetch(`${inferBase}/v1/detect?return_image=false`, {
        method: "POST",
        headers: {
          "ngrok-skip-browser-warning": "1",
        },
        body: formData,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return new Response(
        JSON.stringify({ error: `推理服务连接失败: ${msg}` }),
        { status: 502, headers },
      );
    }

    if (!inferResp.ok) {
      const text = await inferResp.text().catch(() => "");
      return new Response(
        JSON.stringify({ error: `推理服务返回错误: HTTP ${inferResp.status} ${text.slice(0, 200)}` }),
        { status: 502, headers },
      );
    }

    // 5. 解析推理结果，提取关键字段
    const raw = await inferResp.json();
    const rawDetections = Array.isArray(raw.detections) ? raw.detections : [];

    const detections = rawDetections.map((d: any) => ({
      class_name: d.class_name ?? d.label ?? "",
      class_name_zh: d.class_name_zh ?? d.name ?? d.label ?? "",
      confidence: typeof d.confidence === "number" ? d.confidence : Number(d.confidence ?? 0),
      xyxy: Array.isArray(d.xyxy) ? d.xyxy : undefined,
      xyxyn: Array.isArray(d.xyxyn) ? d.xyxyn : undefined,
    }));

    console.log(`[pest-detect] success, detections=${detections.length}`);

    return new Response(
      JSON.stringify({
        success: true,
        count: detections.length,
        detections,
        timings: raw.timings ?? null,
      }),
      { headers },
    );
  } catch (err) {
    console.error("[pest-detect] error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers },
    );
  }
});
