/**
 * 题库格式 v1 的 TypeScript 类型。与 `standards/schema/*.schema.json` 一一对应：
 * Schema 是对外契约（语言无关），这里是给 TS 代码用的同一份形状。改了一边必须改另一边，
 * `bank-kit.test.ts` 会用 Schema 校验按这些类型构造出来的样例。
 */
import type { Difficulty, ForceKey, SessionType } from '../standards/index';

export const BANK_FORMAT_VERSION = 1 as const;

export type PoolType = 'drill' | 'admission_exam';

export interface HiddenCard {
  value: string;
  unlock: string;
  unlock_patterns?: string[];
  unlock_patterns_topic?: string[];
  unlock_patterns_framing?: string[];
  requires?: string[];
  leak_signals: string[];
  [note: `_${string}`]: unknown;
}

export interface PriceTier {
  min_qty?: number | null;
  max_qty?: number | null;
  unit_price: number | string;
  currency?: string;
  incoterm?: string | null;
  port?: string | null;
  variant?: string | null;
  [extra: string]: unknown;
}

export interface Product {
  model?: string;
  name: string;
  attributes?: Record<string, unknown>;
  page_price?: unknown;
  price_tiers?: PriceTier[];
  moq?: { qty: number | string; unit?: string; note?: string };
  lead_time?: { sample_days?: number | string; bulk_days?: number | string; note?: string };
  packing?: {
    qty_per_carton?: number | string;
    carton_cm?: string | unknown[];
    gross_kg?: number | string;
    net_kg?: number | string;
    cbm?: number | string;
    note?: string;
  };
  certifications?: { name: string; market?: string }[];
  surcharges?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export interface SourceNote {
  material_id: string | null;
  quotes: { card: string; message_index?: number | null; quote?: string; invented?: boolean; why?: string }[];
}

export interface Persona {
  id: string;
  derived_from?: string;
  version?: string;
  active?: boolean;
  skeleton: {
    type_code: string;
    name: string;
    session_type: SessionType;
    difficulty: Difficulty;
    tests: string;
    active_forces: ForceKey[];
    na_forces: ForceKey[];
  };
  difficulty?: Difficulty;
  pool_type: PoolType;
  open_card: Record<string, unknown> & { name: string; country: string; company: string; inquiry_text: string };
  product: Product;
  hidden_card: Record<string, HiddenCard | unknown>;
  leak_fallback: string;
  distractors?: Record<string, unknown>[];
  customs_capability?: string;
  init_state: { patience: number; trust: number; interest: number };
  rules_override?: Record<string, unknown>;
  exit_lines: { maxTurns: string; patienceZero?: string | null; stagnant?: string | null };
  quote_reactions: Record<string, string | null>;
  followup_reactions?: Record<string, unknown>;
  language_style: string;
  preset_elements?: string[];
  verify_cases: { card: string; should: string[]; shouldNot: string[] }[];
  _source?: SourceNote;
  [note: `_${string}`]: unknown;
}

export interface BgPackage {
  persona_id: string;
  version?: string;
  ai_report: Record<string, unknown>;
  website: unknown;
  social: unknown;
  contacts: unknown;
  [note: `_${string}`]: unknown;
}

export interface Counts {
  total: number;
  drill: number;
  admission_exam: number;
  bg_packages?: number;
  by_type: Record<string, number>;
  by_slot: Record<string, number>;
}

export interface Manifest {
  format_version: typeof BANK_FORMAT_VERSION;
  syllabus_version: number;
  bank_id: string;
  bank_version: string;
  drawer_version: string;
  generator?: string;
  created_at: string;
  counts: Counts;
  source_batches?: string[];
}

export interface Coverage {
  syllabus_version: number;
  by_type: Record<string, { total: number; drill: number; admission_exam: number }>;
  slots: Record<string, { types: number; questions: number }>;
  missing_types: string[];
}

export interface Bank {
  manifest: Manifest;
  personas: Persona[];
  bgPackages: BgPackage[];
  company?: Record<string, string>;
  products?: unknown[];
  coverage: Coverage;
  reviewLog?: unknown[];
}
