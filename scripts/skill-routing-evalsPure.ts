/**
 * skill-routing-evalsPure.ts
 *
 * Pure (I/O-free) core for the skill-routing eval harness: a stemmed TF-IDF
 * lexical router over skill descriptions plus the checks the CLI runs —
 * positive/negative trigger evals, owner pairwise routing, catalogue
 * collision detection, and the rank-1-rate summary metric. The I/O module
 * (`skill-routing-evals.ts`) owns file reads, report printing, and exit codes.
 *
 * This is a deterministic proxy for Claude's skill routing, not a simulation
 * of it: if a prompt cannot rank its skill highly on shared vocabulary alone,
 * the description likely needs work. Ported from the agent-skills
 * run-evals.js Tier-2 deterministic path.
 */

export const DEFAULT_TOP_K = 3;
export const COLLISION_WARN = 0.5; // cosine similarity between two descriptions
export const COLLISION_ERROR = 0.75;

// ── tiny text pipeline ────────────────────────────────────────────────────────

const STOP = new Set([
  'a', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'before', 'by', 'for',
  'from', 'in', 'into', 'is', 'it', 'its', 'my', 'need', 'needs', 'of', 'on',
  'or', 'our', 'so', 'that', 'the', 'them', 'this', 'to', 'use', 'want',
  'we', 'when', 'with', 'you', 'your', 'help', 'me', 'i',
]);

/**
 * Light suffix stripping so "conflicts"/"conflict", "branching"/"branch",
 * "architectural"/"architecture" cluster together. Not a real stemmer.
 */
export function stem(t: string): string {
  for (const suf of ['ally', 'ing', 'ed', 'es', 'al']) {
    if (t.length > suf.length + 3 && t.endsWith(suf)) {
      t = t.slice(0, -suf.length);
      break;
    }
  }
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
  if (t.length > 4 && t.endsWith('e')) t = t.slice(0, -1);
  // Collapse doubled trailing consonant left by -ing/-ed ("committ" -> "commit").
  if (t.length > 4 && t[t.length - 1] === t[t.length - 2] && !'aeiou'.includes(t[t.length - 1])) {
    t = t.slice(0, -1);
  }
  // Normalize trailing y so "simplify" and "simplifies"/"simplified" cluster.
  if (t.length > 3 && t.endsWith('y')) t = t.slice(0, -1) + 'i';
  return t;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((t) => t.length > 2 && !STOP.has(t))
    .map(stem);
}

export type TermVector = Map<string, number>;

function termFreq(tokens: string[]): TermVector {
  const tf: TermVector = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

// ── TF-IDF corpus over skill descriptions ─────────────────────────────────────

export interface SkillDoc {
  name: string;
  description: string;
}

export interface Corpus {
  /** Term-frequency document per skill: name tokens (weighted 2x) + description tokens. */
  docs: Map<string, TermVector>;
  idf: (term: string) => number;
}

export function buildCorpus(skills: SkillDoc[]): Corpus {
  const docs = new Map<string, TermVector>();
  for (const s of skills) {
    const nameTokens = tokenize(s.name.replace(/-/g, ' '));
    const tokens = [...nameTokens, ...nameTokens, ...tokenize(s.description)];
    docs.set(s.name, termFreq(tokens));
  }
  const df = new Map<string, number>();
  for (const tf of docs.values()) {
    for (const term of tf.keys()) df.set(term, (df.get(term) || 0) + 1);
  }
  const n = docs.size;
  const idf = (term: string) => Math.log(1 + n / (1 + (df.get(term) || 0)));
  return { docs, idf };
}

function vec(tf: TermVector, idf: (term: string) => number): TermVector {
  const v: TermVector = new Map();
  for (const [term, f] of tf) v.set(term, f * idf(term));
  return v;
}

export function cosine(a: TermVector, b: TermVector): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [t, w] of a) {
    na += w * w;
    const bw = b.get(t);
    if (bw) dot += w * bw;
  }
  for (const w of b.values()) nb += w * w;
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface RankedSkill {
  name: string;
  score: number;
}

export function rankSkillsForPrompt(prompt: string, corpus: Corpus): RankedSkill[] {
  const pv = vec(termFreq(tokenize(prompt)), corpus.idf);
  const scores: RankedSkill[] = [];
  for (const [name, tf] of corpus.docs) {
    scores.push({ name, score: cosine(pv, vec(tf, corpus.idf)) });
  }
  scores.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scores;
}

// ── case format (pinned — see evals/skill-routing/README.md) ─────────────────
// {"skill": "<name>", "top_k": 3, "positive": ["prompt", ...],
//  "negative": ["plain prompt", {"prompt": "...", "owner": "<other-skill>"}]}

export interface NegativePrompt {
  prompt: string;
  /** Skill that must outrank this one for the prompt (pairwise routing test). */
  owner?: string;
}

export interface RoutingCase {
  skill: string;
  topK: number;
  positive: string[];
  negative: NegativePrompt[];
}

/** Validate one parsed case object. Returns either `{ case }` or `{ error }`. */
export function validateRoutingCase(obj: unknown, ref: string): { case?: RoutingCase; error?: string } {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return { error: `${ref}: case file is not a JSON object` };
  }
  const o = obj as Record<string, unknown>;
  if (typeof o.skill !== 'string' || o.skill.trim() === '') {
    return { error: `${ref}: "skill" must be a non-empty string` };
  }
  let topK = DEFAULT_TOP_K;
  if (o.top_k !== undefined) {
    if (!Number.isInteger(o.top_k) || (o.top_k as number) < 1) {
      return { error: `${ref}: "top_k" must be a positive integer` };
    }
    topK = o.top_k as number;
  }
  if (!Array.isArray(o.positive)) {
    return { error: `${ref}: "positive" must be an array of prompt strings` };
  }
  for (const p of o.positive) {
    if (typeof p !== 'string' || p.trim() === '') {
      return { error: `${ref}: every "positive" entry must be a non-empty string` };
    }
  }
  if (!Array.isArray(o.negative)) {
    return { error: `${ref}: "negative" must be an array of strings or { prompt, owner } objects` };
  }
  const negative: NegativePrompt[] = [];
  for (const n of o.negative) {
    if (typeof n === 'string') {
      if (n.trim() === '') return { error: `${ref}: negative prompt strings must be non-empty` };
      negative.push({ prompt: n });
    } else if (n && typeof n === 'object' && !Array.isArray(n)) {
      const { prompt, owner } = n as Record<string, unknown>;
      if (typeof prompt !== 'string' || prompt.trim() === '') {
        return { error: `${ref}: negative object entries need a non-empty "prompt"` };
      }
      if (owner !== undefined && (typeof owner !== 'string' || owner.trim() === '')) {
        return { error: `${ref}: negative "owner" must be a non-empty string when present` };
      }
      negative.push({ prompt, owner: owner as string | undefined });
    } else {
      return { error: `${ref}: negative entries must be strings or { prompt, owner } objects` };
    }
  }
  return { case: { skill: o.skill.trim(), topK, positive: o.positive as string[], negative } };
}

// ── trigger evaluation ────────────────────────────────────────────────────────

export type FailureKind =
  | 'unknown-skill'
  | 'positive-no-vocabulary'
  | 'positive-rank'
  | 'negative-rank1'
  | 'owner-unknown'
  | 'owner-outranked';

export interface CheckFailure {
  kind: FailureKind;
  prompt: string;
  message: string;
  /** Top-3 nonzero-scoring skills for the prompt — the WHY behind the failure. */
  top3: RankedSkill[];
}

export interface CaseEvaluation {
  skill: string;
  passed: number;
  positives: number;
  rank1: number;
  failures: CheckFailure[];
}

export function evaluateCase(c: RoutingCase, corpus: Corpus): CaseEvaluation {
  const result: CaseEvaluation = { skill: c.skill, passed: 0, positives: 0, rank1: 0, failures: [] };
  if (!corpus.docs.has(c.skill)) {
    result.failures.push({
      kind: 'unknown-skill',
      prompt: '',
      message: `no skill named "${c.skill}" in the catalogue`,
      top3: [],
    });
    return result;
  }

  // Positive prompts must rank the skill within top_k with a nonzero score.
  for (const prompt of c.positive) {
    result.positives++;
    const ranking = rankSkillsForPrompt(prompt, corpus);
    const idx = ranking.findIndex((r) => r.name === c.skill);
    const hit = ranking[idx];
    const top3 = ranking.filter((r) => r.score > 0).slice(0, 3);
    if (idx === 0 && hit.score > 0) result.rank1++;
    if (idx >= 0 && idx < c.topK && hit.score > 0) {
      result.passed++;
    } else if (!hit || hit.score === 0) {
      result.failures.push({
        kind: 'positive-no-vocabulary',
        prompt,
        message: 'description shares no vocabulary with the prompt',
        top3,
      });
    } else {
      result.failures.push({
        kind: 'positive-rank',
        prompt,
        message: `ranked #${idx + 1} (need top ${c.topK})`,
        top3,
      });
    }
  }

  // Negative prompts fail only on a real (nonzero) #1 match. With an "owner",
  // the negative becomes a pairwise routing test: the declared owner skill
  // must outrank this one for the prompt, which prevents vacuous passes where
  // the prompt matches nothing at all.
  for (const neg of c.negative) {
    const ranking = rankSkillsForPrompt(neg.prompt, corpus);
    const top3 = ranking.filter((r) => r.score > 0).slice(0, 3);
    let ok = true;
    if (ranking.length > 0 && ranking[0].name === c.skill && ranking[0].score > 0) {
      result.failures.push({
        kind: 'negative-rank1',
        prompt: neg.prompt,
        message: 'ranked #1 for a negative prompt (over-broad description)',
        top3,
      });
      ok = false;
    }
    if (neg.owner) {
      if (!corpus.docs.has(neg.owner)) {
        result.failures.push({
          kind: 'owner-unknown',
          prompt: neg.prompt,
          message: `negative declares unknown owner "${neg.owner}"`,
          top3,
        });
        ok = false;
      } else {
        const ownerIdx = ranking.findIndex((r) => r.name === neg.owner);
        const selfIdx = ranking.findIndex((r) => r.name === c.skill);
        if (ranking[ownerIdx].score === 0 || ownerIdx > selfIdx) {
          result.failures.push({
            kind: 'owner-outranked',
            prompt: neg.prompt,
            message:
              `declared owner "${neg.owner}" does not outrank it ` +
              `(owner #${ownerIdx + 1} @ ${ranking[ownerIdx].score.toFixed(2)}, self #${selfIdx + 1})`,
            top3,
          });
          ok = false;
        }
      }
    }
    if (ok) result.passed++;
  }
  return result;
}

// ── catalogue collision detection ─────────────────────────────────────────────

export interface Collision {
  a: string;
  b: string;
  similarity: number;
  level: 'warn' | 'error';
  /** True when the pair is on the caller's exemption allowlist. */
  exempt: boolean;
}

function pairKey(a: string, b: string): string {
  return [a, b].sort().join('|');
}

/**
 * All skill-description pairs whose cosine similarity reaches the warn
 * threshold, ordered by descending similarity. Exempted pairs are still
 * returned (flagged `exempt: true`) so the caller can report them and detect
 * stale exemptions; they must not be treated as failures.
 */
export function pairwiseCollisions(
  corpus: Corpus,
  exempt: Array<[string, string]> = [],
  thresholds: { warn: number; error: number } = { warn: COLLISION_WARN, error: COLLISION_ERROR },
): Collision[] {
  const exemptKeys = new Set(exempt.map(([a, b]) => pairKey(a, b)));
  const names = [...corpus.docs.keys()];
  const vectors = new Map(names.map((n) => [n, vec(corpus.docs.get(n)!, corpus.idf)]));
  const out: Collision[] = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const sim = cosine(vectors.get(names[i])!, vectors.get(names[j])!);
      if (sim < thresholds.warn) continue;
      out.push({
        a: names[i],
        b: names[j],
        similarity: sim,
        level: sim >= thresholds.error ? 'error' : 'warn',
        exempt: exemptKeys.has(pairKey(names[i], names[j])),
      });
    }
  }
  out.sort((a, b) => b.similarity - a.similarity);
  return out;
}

// ── summary metrics ───────────────────────────────────────────────────────────

export interface RoutingSummary {
  checksPassed: number;
  failures: number;
  positives: number;
  rank1: number;
  /** Share of positive prompts that rank their skill #1; null with no positives. */
  rank1Rate: number | null;
}

export function summarize(evals: CaseEvaluation[]): RoutingSummary {
  let checksPassed = 0;
  let failures = 0;
  let positives = 0;
  let rank1 = 0;
  for (const e of evals) {
    checksPassed += e.passed;
    failures += e.failures.length;
    positives += e.positives;
    rank1 += e.rank1;
  }
  return { checksPassed, failures, positives, rank1, rank1Rate: positives ? rank1 / positives : null };
}
