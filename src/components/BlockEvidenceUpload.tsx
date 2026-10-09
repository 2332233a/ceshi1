// 区块现场补拍素材：上传/预览/删除 + AI病虫害识别（回写 sensor_readings）
import { useCallback, useEffect, useRef, useState } from "react";
import { ImagePlus, Loader2, Trash2, Video, TriangleAlert } from "lucide-react";
import {
  deleteBlockMedia,
  fetchBlockMedia,
  formatTime,
  uploadBlockMedia,
  markBlockPest,
  type BlockMediaItem,
} from "@/lib/farm-service";
import { cn } from "@/lib/utils";

interface Msg {
  kind: "ok" | "err";
  text: string;
}

interface DetectionItem {
  class_name: string;
  class_name_zh: string;
  confidence: number;
}

const fmtSize = (n: number): string => {
  if (!n) return "";
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

export function BlockEvidenceUpload({ blockId, canWrite }: { blockId: string; canWrite: boolean }) {
  const [list, setList] = useState<BlockMediaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg | null>(null);
  const [caption, setCaption] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  // AI识别状态
  const [aiLoadingId, setAiLoadingId] = useState<string | null>(null);
  const [aiResultMap, setAiResultMap] = useState<Record<string, DetectionItem[]>>({});
  const inputRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => {
    setLoading(true);
    fetchBlockMedia(blockId)
      .then((rows) => setList(rows))
      .catch((e: unknown) =>
        setMsg({ kind: "err", text: e instanceof Error ? e.message : "加载现场素材失败" }),
      )
      .finally(() => setLoading(false));
  }, [blockId]);

  useEffect(() => {
    setMsg(null);
    setCaption("");
    setConfirmId(null);
    reload();
  }, [reload]);

  const onPick = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setMsg(null);
    setProgress(`正在上传 0/${files.length}…`);
    try {
      const r = await uploadBlockMedia(blockId, Array.from(files), caption);
      if (r.ok > 0 && r.failed.length === 0) {
        setMsg({ kind: "ok", text: `已上传 ${r.ok} 个素材，可作为病虫害研判依据` });
        setCaption("");
      } else if (r.ok > 0) {
        setMsg({ kind: "ok", text: `成功 ${r.ok} 个；${r.failed.join("；")}` });
      } else {
        setMsg({ kind: "err", text: r.failed.join("；") || "上传失败" });
      }
      reload();
    } catch (e: unknown) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "上传失败" });
    } finally {
      setProgress(null);
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const remove = async (m: BlockMediaItem) => {
    setBusy(true);
    setMsg(null);
    setConfirmId(null);
    try {
      await deleteBlockMedia(m.id, m.filePath);
      reload();
      setAiResultMap((prev) => {
        const next = { ...prev };
        delete next[m.id];
        return next;
      });
      setMsg({ kind: "ok", text: "素材已删除" });
    } catch (e: unknown) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "删除失败" });
    } finally {
      setBusy(false);
    }
  };

  // ========== AI识别：前端直连ngrok推理 + 回写sensor_readings ==========
  const runAIDetect = async (mediaUrl: string, mediaId: string) => {
    setAiLoadingId(mediaId);
    setMsg(null);
    try {
      console.log("开始AI识别，图片地址：", mediaUrl);
      const INFER_URL = "https://facsimile-unhelpful-kilowatt.ngrok-free.dev";

      // 1. 下载图片二进制
      const imgRes = await fetch(mediaUrl);
      if (!imgRes.ok) throw new Error("读取存储图片失败");
      const imgBlob = await imgRes.blob();

      // 2. FormData 上传到推理服务
      const formData = new FormData();
      formData.append("file", imgBlob, "image.png");

      const res = await fetch(`${INFER_URL}/v1/detect?return_image=false`, {
        method: "POST",
        headers: { "ngrok-skip-browser-warning": "1" },
        body: formData,
      });

      if (!res.ok) throw new Error(`推理接口HTTP ${res.status}`);
      const data = await res.json();
      console.log("✅AI识别结果：", data);

      // 3. 解析 detections
      const detections: DetectionItem[] = Array.isArray(data.detections)
        ? data.detections.map((d: any) => ({
            class_name: d.class_name ?? "",
            class_name_zh: d.class_name_zh ?? d.class_name ?? "未知",
            confidence: Number(d.confidence ?? 0),
          }))
        : [];

      setAiResultMap((prev) => ({ ...prev, [mediaId]: detections }));

      // 4. 回写 sensor_readings，让区块网格变红
      try {
        await markBlockPest(blockId, detections);
        setMsg({
          kind: "ok",
          text: `识别完成，已标记区块病虫害：${detections[0]?.class_name_zh ?? "未知"}（${((detections[0]?.confidence ?? 0) * 100).toFixed(1)}%）`,
        });
      } catch (e) {
        console.error("回写失败：", e);
        setMsg({
          kind: "err",
          text: `识别成功，但回写数据库失败：${e instanceof Error ? e.message : String(e)}`,
        });
      }
    } catch (e: unknown) {
      console.error("AI识别异常", e);
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "AI识别失败" });
    } finally {
      setAiLoadingId(null);
    }
  };

  return (
    <div className="mt-4 rounded-xl border border-border/60 bg-secondary/20 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-[13px] font-bold tracking-tight">
          <ImagePlus className="size-4 text-primary" strokeWidth={2.2} />
          现场补拍素材
          <span className="tnum font-normal text-muted-foreground">（{list.length}）</span>
        </h3>
        {canWrite && (
          <div className="flex items-center gap-2">
            {/* <input
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="备注（可选）"
              maxLength={60}
              className="h-8 w-44 rounded-lg border border-input bg-card px-2 text-[12px] outline-none transition-all focus:border-primary focus:ring-2 focus:ring-ring/25 sm:w-56"
            /> */}
            <button
              onClick={() => inputRef.current?.click()}
              disabled={busy}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-2.5 text-[12px] font-semibold text-primary-foreground transition-all hover:brightness-110 active:scale-95 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ImagePlus className="size-3.5" />}
              上传图片
            </button>
          </div>
        )}
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
        {canWrite
          ? "用于补充自动巡检没发现的异常，支持图片与短视频，单个文件不超过 20MB。"
          : "游客可查看全部现场素材；上传与删除需登录后操作。"}
      </p>
      <input
        ref={inputRef}
        type="file"
        accept="image/*,video/*"
        multiple
        className="hidden"
        onChange={(e) => void onPick(e.target.files)}
      />
      {progress && (
        <p className="mt-2 flex items-center gap-1.5 text-[12px] text-primary">
          <Loader2 className="size-3.5 animate-spin" /> {progress}
        </p>
      )}
      {msg && (
        <p
          className={cn(
            "mt-2 flex items-start gap-1.5 text-[11.5px] leading-relaxed",
            msg.kind === "ok" ? "text-primary" : "text-destructive",
          )}
        >
          {msg.kind === "err" && <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />}
          <span>{msg.text}</span>
        </p>
      )}
      {loading ? (
        <div className="mt-3 grid h-28 place-items-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" /> 正在加载素材…
        </div>
      ) : list.length === 0 ? (
        <div className="mt-3 flex min-h-28 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-card/60 px-4 py-6 text-center">
          <Video className="size-6 text-muted-foreground/40" />
          <p className="text-[12.5px] text-muted-foreground">该区块暂无补拍素材，可上传自动巡检未发现的异常</p>
        </div>
      ) : (
        <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
          {list.map((m) => (
            <li
              key={m.id}
              className="fade-up group relative overflow-hidden rounded-xl border border-border/60 bg-field shadow-sm"
            >
              <div className="relative aspect-[16/10] overflow-hidden bg-field">
                {m.kind === "image" ? (
                  <img src={m.url} alt={m.caption ?? `区块 ${m.blockId} 现场照片`} loading="lazy" className="size-full object-cover" />
                ) : (
                  <video src={m.url} controls preload="metadata" className="size-full bg-black object-contain" />
                )}
                <span className="absolute left-2 top-2 rounded-full bg-card/85 px-2 py-0.5 text-[10px] font-bold backdrop-blur">
                  {m.kind === "video" ? "视频" : "图片"}
                </span>
                {canWrite && (
                  <button
                    onClick={() => setConfirmId(confirmId === m.id ? null : m.id)}
                    title="删除素材"
                    className="absolute right-2 top-2 grid size-7 place-items-center rounded-full bg-card/85 text-destructive opacity-0 backdrop-blur transition-opacity hover:bg-card group-hover:opacity-100"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </div>
              <div className="px-2.5 py-2">
                <p className="truncate text-[11.5px] font-medium">{m.caption ?? `区块 ${m.blockId} 现场记录`}</p>
                <p className="tnum mt-0.5 text-[10px] text-muted-foreground">
                  {formatTime(m.createdAt)}
                  {m.sizeBytes > 0 && ` · ${fmtSize(m.sizeBytes)}`}
                </p>

                {/* AI识别按钮（仅图片显示） */}
                {m.kind === "image" && (
                  <button
                    onClick={() => void runAIDetect(m.url, m.id)}
                    disabled={aiLoadingId === m.id}
                    className="mt-1.5 flex h-7 w-full items-center justify-center gap-1 rounded-lg bg-secondary px-2 text-[11px] font-medium transition-all hover:bg-accent disabled:opacity-45"
                  >
                    {aiLoadingId === m.id ? <Loader2 className="size-3 animate-spin" /> : null}
                    AI病虫害识别
                  </button>
                )}

                {/* 识别结果展示 */}
                {aiResultMap[m.id] && aiResultMap[m.id].length > 0 && (
                  <div className="mt-1.5 rounded-lg bg-amber-50 px-2 py-1.5 text-[10.5px]">
                    <div className="font-semibold text-amber-800">识别结果：</div>
                    {aiResultMap[m.id].map((det, idx) => (
                      <div key={idx} className="text-amber-700">
                        {det.class_name_zh}｜置信度：{(det.confidence * 100).toFixed(1)}%
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {canWrite && confirmId === m.id && (
                <div className="tip-in absolute inset-x-2 bottom-2 flex items-center gap-2 rounded-lg bg-card/95 px-2.5 py-2 text-[11px] shadow-md backdrop-blur">
                  <span className="flex-1 text-muted-foreground">确认删除该素材？</span>
                  <button
                    onClick={() => void remove(m)}
                    className="rounded-md bg-destructive px-2 py-0.5 font-semibold text-destructive-foreground transition-all hover:brightness-110"
                  >
                    删除
                  </button>
                  <button
                    onClick={() => setConfirmId(null)}
                    className="rounded-md bg-secondary px-2 py-0.5 font-semibold transition-colors hover:bg-accent"
                  >
                    取消
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
