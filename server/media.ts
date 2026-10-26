// Local media pipeline: upload sanitising (sharp), crops, typography overlays
// (SVG -> PNG, because this ffmpeg build has no drawtext), probing and video assembly (ffmpeg).
import sharp, { type OverlayOptions } from "sharp";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";

export async function ffmpeg(args: string[], timeoutMs = 10 * 60_000) {
  try {
    await run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  } catch (e: any) {
    throw new Error(`ffmpeg failed: ${String(e.stderr || e.message).slice(-1500)}`);
  }
}

export async function probe(file: string): Promise<{ duration: number; width: number; height: number; hasAudio: boolean; vcodec?: string }> {
  const { stdout } = await run(FFPROBE, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file], { timeout: 60_000 });
  const j = JSON.parse(stdout);
  const v = j.streams?.find((s: any) => s.codec_type === "video");
  return {
    duration: Number(j.format?.duration ?? 0),
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    hasAudio: !!j.streams?.some((s: any) => s.codec_type === "audio"),
    vcodec: v?.codec_name,
  };
}

/** Decode untrusted image bytes and re-encode them: rejects non-images, strips EXIF/GPS, applies orientation. */
export async function sanitizeImage(buf: Buffer, keepAlpha = false) {
  const meta = await sharp(buf, { limitInputPixels: 50_000_000 }).metadata();
  if (!meta.format || !["jpeg", "png", "webp"].includes(meta.format)) throw new Error(`Unsupported image format (${meta.format ?? "unknown"}). Use JPEG, PNG or WebP.`);
  const img = sharp(buf, { limitInputPixels: 50_000_000 }).rotate();
  const alpha = keepAlpha && meta.hasAlpha;
  const { data, info } = alpha
    ? await img.png().toBuffer({ resolveWithObject: true })
    : await img.flatten({ background: "#ffffff" }).jpeg({ quality: 92 }).toBuffer({ resolveWithObject: true });
  return { data, mime: alpha ? "image/png" : "image/jpeg", ext: alpha ? "png" : "jpg", width: info.width, height: info.height };
}

/** Validate + re-encode an untrusted audio upload to AAC (drops any non-audio streams/metadata). */
export async function sanitizeAudio(srcPath: string, destPath: string) {
  const p = await probe(srcPath).catch(() => null);
  if (!p || !p.hasAudio) throw new Error("Not a readable audio file.");
  if (p.duration > 600) throw new Error("Audio longer than 10 minutes.");
  await ffmpeg(["-i", srcPath, "-vn", "-map_metadata", "-1", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", destPath]);
  return { duration: p.duration };
}

export const ASPECT_SIZES: Record<string, [number, number]> = {
  "9:16": [1080, 1920], "4:5": [1080, 1350], "1:1": [1080, 1080], "16:9": [1920, 1080], "3:4": [1080, 1440],
};

export const ratio = (aspect: string) => { const [w, h] = aspect.split(":").map(Number); return w / h; };

/** Crop/scale an image to an exact frame, keeping the most salient region (the product). */
export async function coverImage(src: string, dest: string, w: number, h: number) {
  await mkdir(path.dirname(dest), { recursive: true });
  return sharp(src).resize(w, h, { fit: "cover", position: sharp.strategy.attention }).jpeg({ quality: 92 }).toFile(dest);
}

/** Downscaled JPEG for vision-model input (keeps Claude token cost predictable). */
export async function visionJpeg(src: string, maxSide = 1280) {
  return sharp(src).resize(maxSide, maxSide, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

// ponytail: width-estimate wrapping (0.55em per char); swap for real text metrics if brand fonts need precision.
function wrap(text: string, fontSize: number, maxWidth: number): string[] {
  const maxChars = Math.max(8, Math.floor(maxWidth / (fontSize * 0.55)));
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if ((line + " " + word).trim().length > maxChars && line) { lines.push(line); line = word; } else line = (line + " " + word).trim();
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

export type OverlaySpec = {
  width: number; height: number; headline: string; cta: string;
  font?: string; accent?: string; logo?: string; logoPosition?: string; scrim?: boolean;
};

/** Transparent full-frame PNG: bottom scrim, headline, CTA pill and optional logo. Exact typography, never model-rendered. */
export async function renderOverlay(o: OverlaySpec, dest: string) {
  const { width: W, height: H } = o;
  const unit = Math.min(W, H);
  const font = esc(o.font?.trim() ? `${o.font}, Helvetica Neue, Helvetica, Arial, sans-serif` : "Helvetica Neue, Helvetica, Arial, sans-serif");
  const accent = /^#[0-9a-f]{3,8}$/i.test(o.accent ?? "") ? o.accent! : "#ffffff";
  const hSize = Math.round(unit * 0.075);
  const hLines = o.headline ? wrap(o.headline, hSize, W * 0.84) : [];
  const ctaSize = Math.round(unit * 0.04);
  const baseY = H * 0.9 - (o.cta ? ctaSize * 2.6 : 0);
  const firstY = baseY - (hLines.length - 1) * hSize * 1.15;
  const headline = hLines.map((l, i) =>
    `<text x="${W / 2}" y="${firstY + i * hSize * 1.15}" text-anchor="middle" font-family="${font}" font-size="${hSize}" font-weight="700" fill="#ffffff">${esc(l)}</text>`).join("");
  const ctaW = o.cta ? Math.min(W * 0.8, o.cta.length * ctaSize * 0.62 + ctaSize * 2.4) : 0;
  const ctaY = H * 0.9 - ctaSize * 1.6;
  const ctaInk = luminance(accent) > 0.55 ? "#111111" : "#ffffff";
  const cta = o.cta
    ? `<rect x="${(W - ctaW) / 2}" y="${ctaY}" width="${ctaW}" height="${ctaSize * 2.1}" rx="${ctaSize * 1.05}" fill="${accent}"/>` +
      `<text x="${W / 2}" y="${ctaY + ctaSize * 1.4}" text-anchor="middle" font-family="${font}" font-size="${ctaSize}" font-weight="600" fill="${ctaInk}">${esc(o.cta)}</text>`
    : "";
  const scrim = o.scrim === false ? "" :
    `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.62"/></linearGradient></defs>` +
    `<rect x="0" y="${H * 0.45}" width="${W}" height="${H * 0.55}" fill="url(#g)"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${scrim}${headline}${cta}</svg>`;
  const layers: OverlayOptions[] = [];
  if (o.logo) {
    const lw = Math.round(unit * 0.22);
    const logo = await sharp(o.logo).resize(lw, lw, { fit: "inside" }).png().toBuffer({ resolveWithObject: true });
    const m = Math.round(unit * 0.05);
    const pos = o.logoPosition ?? "top-left";
    const left = pos.endsWith("left") ? m : pos.endsWith("right") ? W - logo.info.width - m : Math.round((W - logo.info.width) / 2);
    const top = pos.startsWith("top") ? m : pos.startsWith("bottom") ? H - logo.info.height - m : Math.round(H * 0.38 - logo.info.height / 2);
    layers.push({ input: logo.data, left, top });
  }
  await mkdir(path.dirname(dest), { recursive: true });
  await sharp(Buffer.from(svg)).composite(layers).png().toFile(dest);
  return dest;
}

function luminance(hex: string) {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Composite an overlay PNG onto a still (used for "with copy" image exports). */
export async function compositeStill(src: string, overlayPng: string, dest: string) {
  await sharp(src).composite([{ input: overlayPng }]).jpeg({ quality: 92 }).toFile(dest);
}

export async function extractFrames(video: string, times: number[], destDir: string) {
  await mkdir(destDir, { recursive: true });
  const out: string[] = [];
  for (const [i, t] of times.entries()) {
    const f = path.join(destDir, `frame_${i}.jpg`);
    await ffmpeg(["-ss", t.toFixed(2), "-i", video, "-frames:v", "1", "-q:v", "3", f], 60_000);
    out.push(f);
  }
  return out;
}

export type Clip = { path: string; start: number; duration: number; transition: string; hasAudio: boolean };

/**
 * Assemble clips into one H.264/AAC MP4 at an exact frame size.
 * Transitions: "cut" = concat, anything else = ffmpeg xfade of up to 0.5s.
 */
export async function assemble(opts: {
  clips: Clip[]; width: number; height: number; out: string; fps?: number;
  overlay?: { png: string; seconds: number }; // shown for the last `seconds` of the edit
  audio: { mode: "none" | "native" | "track"; track?: string };
}) {
  const { clips, width: W, height: H, fps = 30 } = opts;
  if (!clips.length) throw new Error("no clips to assemble");
  const args: string[] = [];
  for (const c of clips) args.push("-i", c.path);
  const f: string[] = [];
  clips.forEach((c, i) =>
    f.push(`[${i}:v]trim=start=${c.start}:duration=${c.duration},setpts=PTS-STARTPTS,scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${fps},format=yuv420p,setsar=1[v${i}]`));
  // Overlap per boundary (shared by video and audio chains so they stay in sync).
  const overlaps = clips.slice(1).map((c, i) => clips[i].transition === "cut" ? 0 : Math.min(0.5, clips[i].duration / 2, c.duration / 2));
  let cur = "v0";
  let total = clips[0].duration;
  for (let i = 1; i < clips.length; i++) {
    const d = overlaps[i - 1];
    f.push(d === 0
      ? `[${cur}][v${i}]concat=n=2:v=1:a=0[x${i}]`
      : `[${cur}][v${i}]xfade=transition=${clips[i - 1].transition}:duration=${d.toFixed(3)}:offset=${(total - d).toFixed(3)}[x${i}]`);
    total += clips[i].duration - d;
    cur = `x${i}`;
  }
  let input = clips.length;
  if (opts.overlay) {
    args.push("-loop", "1", "-t", total.toFixed(3), "-i", opts.overlay.png);
    const from = Math.max(0, total - opts.overlay.seconds).toFixed(2);
    f.push(`[${input}:v]format=rgba,scale=${W}:${H}[ovl]`, `[${cur}][ovl]overlay=0:0:enable='gte(t,${from})'[vo]`);
    cur = "vo";
    input++;
  }
  let audioLabel: string | null = null;
  if (opts.audio.mode === "native") {
    clips.forEach((c, i) => f.push(c.hasAudio
      ? `[${i}:a]atrim=start=${c.start}:duration=${c.duration},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo[a${i}]`
      : `anullsrc=r=48000:cl=stereo,atrim=duration=${c.duration}[a${i}]`));
    let acur = "a0";
    for (let i = 1; i < clips.length; i++) {
      const d = overlaps[i - 1];
      f.push(d === 0 ? `[${acur}][a${i}]concat=n=2:v=0:a=1[ax${i}]` : `[${acur}][a${i}]acrossfade=d=${d.toFixed(3)}[ax${i}]`);
      acur = `ax${i}`;
    }
    f.push(`[${acur}]loudnorm=I=-16:TP=-1.5:LRA=11[aout]`);
    audioLabel = "aout";
  } else if (opts.audio.mode === "track" && opts.audio.track) {
    args.push("-i", opts.audio.track);
    const fadeOut = Math.max(0, total - 1.5).toFixed(2);
    f.push(`[${input}:a]atrim=duration=${total.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:d=0.4,afade=t=out:st=${fadeOut}:d=1.5,loudnorm=I=-16:TP=-1.5:LRA=11[aout]`);
    audioLabel = "aout";
  }
  await mkdir(path.dirname(opts.out), { recursive: true });
  await ffmpeg([
    ...args, "-filter_complex", f.join(";"), "-map", `[${cur}]`,
    ...(audioLabel ? ["-map", `[${audioLabel}]`, "-c:a", "aac", "-b:a", "192k", "-ar", "48000"] : ["-an"]),
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(fps),
    "-t", total.toFixed(3), "-movflags", "+faststart", opts.out,
  ]);
  return { duration: total };
}

/** Slow push-in clip from a still: used by the mock provider so the pipeline is testable offline. */
export async function stillToClip(img: string, out: string, seconds: number, w: number, h: number, tone: boolean) {
  const frames = Math.round(seconds * 24);
  await ffmpeg([
    "-loop", "1", "-i", img,
    ...(tone ? ["-f", "lavfi", "-i", `sine=frequency=220:sample_rate=48000:duration=${seconds}`] : []),
    "-vf", `scale=${w * 2}:${h * 2}:force_original_aspect_ratio=increase,crop=${w * 2}:${h * 2},zoompan=z='min(zoom+0.0012,1.15)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${w}x${h}:fps=24,format=yuv420p`,
    "-frames:v", String(frames), "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    ...(tone ? ["-c:a", "aac", "-shortest"] : ["-an"]), out,
  ]);
}

export async function writeJson(file: string, data: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2));
}

export const readJson = async (file: string) => JSON.parse(await readFile(file, "utf8"));
