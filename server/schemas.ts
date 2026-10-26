// Zod schemas = single source of truth for the campaign spec, Claude's structured
// outputs, and validation of client input. LLM-facing schemas avoid numeric/length
// constraints (structured outputs rejects some); request bodies are size-capped instead.
import { z } from "zod";

export const STAGES = [
  "intake", "analysis", "directions", "models", "budget",
  "image_production", "image_review", "storyboard", "video_approval",
  "video_production", "editing", "final_qc", "export", "done",
] as const;
export type Stage = (typeof STAGES)[number];

export const SLOTS = ["hero", "lifestyle", "benefit"] as const;
export type Slot = (typeof SLOTS)[number];

export const PLATFORMS = ["instagram_feed", "instagram_stories", "tiktok", "facebook", "website", "paid_ads"] as const;

export const ProductProfile = z.object({
  name: z.string(),
  category: z.string(),
  description: z.string(),
  shape_and_proportions: z.string(),
  materials_colors_finishes: z.string(),
  branding_elements: z.string().describe("Logos, label text, packaging details exactly as visible"),
  visible_features: z.array(z.string()),
  must_preserve: z.array(z.string()).describe("Details generation must not change"),
  suitable_environments: z.array(z.string()),
  suggested_props: z.array(z.string()),
  lighting_notes: z.string(),
});

export const Brief = z.object({
  product: ProductProfile,
  benefits: z.array(z.string()),
  usps: z.array(z.string()),
  audience: z.string(),
  objective: z.string(),
  platforms: z.array(z.enum(PLATFORMS)),
  language: z.string(),
  brand: z.object({
    name: z.string(),
    colors: z.array(z.string()).describe("Hex colors, e.g. #1A1A1A"),
    typography: z.string(),
    slogan: z.string(),
    tone: z.string(),
    reference_campaign: z.string(),
  }),
  claims_to_avoid: z.array(z.string()),
});
export type Brief = z.infer<typeof Brief>;

export const Analysis = z.object({
  brief: Brief,
  observations: z.string(),
  uncertain_fields: z.array(z.string()).describe("Brief fields that were guessed or are missing"),
  questions: z.array(z.object({ field: z.string(), question: z.string() })),
  fidelity_risks: z.array(z.string()).describe("Details AI generation is likely to distort, e.g. small label text"),
});
export type Analysis = z.infer<typeof Analysis>;

export const Direction = z.object({
  id: z.string(),
  name: z.string(),
  concept: z.string(),
  setting: z.string(),
  palette: z.array(z.string()),
  lighting: z.string(),
  audience_appeal: z.string(),
  composition: z.string(),
  video_sequence: z.string(),
  rationale: z.string(),
});
export type Direction = z.infer<typeof Direction>;

export const Directions = z.object({
  directions: z.array(Direction),
  recommended_id: z.string(),
  recommendation_reason: z.string(),
});
export type Directions = z.infer<typeof Directions>;

export const ImageSpec = z.object({
  slot: z.enum(SLOTS),
  purpose: z.string(),
  benefit_focus: z.string().describe("The single verified benefit shown (benefit slot); empty otherwise"),
  prompt: z.string(),
  negative: z.string(),
  copy_space: z.string().describe("Where empty space is reserved for headline/CTA"),
});
export const ImagePlan = z.object({ images: z.array(ImageSpec) });
export type ImagePlan = z.infer<typeof ImagePlan>;

export const TRANSITIONS = ["cut", "fade", "fadeblack", "dissolve", "wipeleft", "slideup"] as const;
export const VIDEO_ASPECTS = ["9:16", "1:1", "16:9"] as const;

export const Shot = z.object({
  id: z.string(),
  title: z.string(),
  purpose: z.string(),
  duration: z.number().describe("Seconds used in the edit"),
  composition: z.string(),
  camera_movement: z.string(),
  subject_motion: z.string(),
  lighting: z.string(),
  environment: z.string(),
  transition: z.enum(TRANSITIONS).describe("Transition into the next shot"),
  reference_slot: z.enum(SLOTS).describe("Which approved image is the first frame"),
  prompt: z.string().describe("Model-ready image-to-video prompt"),
});
export type Shot = z.infer<typeof Shot>;

export const Storyboard = z.object({
  concept: z.string(),
  aspect_ratio: z.enum(VIDEO_ASPECTS),
  shots: z.array(Shot),
  headline: z.string(),
  cta: z.string(),
  voiceover_script: z.string().describe("Proposed script; empty if none is appropriate"),
  music_direction: z.string(),
});
export type Storyboard = z.infer<typeof Storyboard>;

export const Review = z.object({
  scores: z.object({
    product_fidelity: z.number(),
    realism: z.number(),
    lighting_composition: z.number(),
    brand_consistency: z.number(),
    ad_clarity: z.number(),
    platform_fit: z.number(),
    brief_compliance: z.number(),
  }).describe("Each 1-5"),
  artifact_severity: z.enum(["none", "minor", "major"]),
  logo_or_text_problems: z.boolean(),
  issues: z.array(z.string()),
  recommendation: z.enum(["approve", "composite_fix", "regenerate"]),
  suggested_change: z.string(),
});
export type Review = z.infer<typeof Review>;

// ---------- user-configured pieces ----------

export const Models = z.object({
  image: z.string().describe("product-scene generation"),
  edit: z.string().describe("reference-based edits, keyframes, fixes"),
  video: z.string().describe("image-to-video"),
});
export type Models = z.infer<typeof Models>;

export const Budget = z.object({
  max_usd: z.number().positive().max(5000),
  images_per_slot: z.number().int().min(1).max(4),
  image_aspect: z.enum(["3:4", "9:16", "1:1", "16:9"]),
  image_resolution: z.enum(["1k", "2k", "4k"]),
  image_quality: z.enum(["low", "medium", "high"]),
  max_video_shots: z.number().int().min(1).max(10),
  video_seconds: z.number().int().min(5).max(60),
  video_resolution: z.enum(["720p", "1080p"]),
  native_audio: z.boolean(),
  max_retries: z.number().int().min(0).max(20),
  allow_keyframes: z.boolean().describe("authorise extra paid reference frames for video"),
  auto_qc: z.boolean().describe("AI review of every output (costs Claude tokens)"),
});
export type Budget = z.infer<typeof Budget>;

export const EditSettings = z.object({
  formats: z.array(z.enum(["9:16", "4:5", "1:1", "16:9"])).min(1).max(4),
  headline: z.string().max(120),
  cta: z.string().max(60),
  show_logo: z.boolean(),
  logo_position: z.enum(["top-left", "top-right", "bottom-left", "bottom-right", "center"]),
  end_card_seconds: z.number().min(1).max(5),
  audio: z.enum(["none", "native", "track"]),
  music_asset_id: z.string().optional(),
  music_rights_confirmed: z.boolean(),
});
export type EditSettings = z.infer<typeof EditSettings>;

export type PlanItem = { kind: string; slot: string; model: string; label: string; est_usd: number | null };
export type Plan = { items: PlanItem[]; reserve_usd: number; llm_usd: number; total_usd: number; hash: string; created_at: string; approved_at?: string };

export type Spec = {
  notes?: string;
  analysis?: Analysis & { source: "claude" | "template" };
  brief?: Brief;
  brief_confirmed_at?: string;
  directions?: Directions & { source: "claude" | "template" };
  direction?: Direction & { notes: string };
  direction_approved_at?: string;
  models?: Models;
  budget?: Budget;
  plan?: Plan;
  image_plan?: ImagePlan & { source: "claude" | "template" };
  retries_used?: number;
  storyboard?: Storyboard & { source: "claude" | "template"; keyframes?: Record<string, string>; trims?: Record<string, number> };
  video_plan?: Plan;
  edit?: EditSettings;
  final_approved_at?: string;
  export?: { dir: string; files: string[]; zip?: string; at: string };
};
