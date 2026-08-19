/**
 * Turn a job description into a search plan — ONE model call, up front.
 *
 * This is the "thinker" half. Letting the agent improvise queries mid-hunt
 * produced twenty variations of the same search, no memory of who it had
 * already read, and no answer: over a hundred browser actions for nothing.
 *
 * So the model is used where judgement is actually needed — reading a JD, and
 * later ranking people — and the middle of the pipeline is deterministic code
 * that decides which queries run, which profiles open, and what has been seen.
 *
 * The queries follow what a good recruiter does, and what Claude-in-Chrome was
 * observed doing on a real role: several ANGLES, not one boolean. The exact
 * title, the alternative titles people actually use, and a title plus a
 * distinctive skill. Two or three plain keywords each — LinkedIn's basic people
 * search returns nothing for long quoted booleans.
 */
import { chatJson } from "./deepseek.js";

// Dual-context binding. The panel loads these files as one classic bundle
// (panel-lib.js) where imports are stripped and dependencies are published on
// window.RM; the module sources are still used by the unit tests. `typeof` is
// safe against the stripped-bundle case where the imported binding does not
// exist at all.
const RM = (typeof window !== "undefined" && window.RM) || {};
const chatJson$ = RM.chatJson || (typeof chatJson !== "undefined" ? chatJson : null);

const PLAN_SYSTEM = `You read a job description and produce a LinkedIn sourcing plan for a New Zealand recruiter.

Return ONLY JSON matching this shape:
{
  "title": "the role's core title",
  "seniority": "junior|mid|senior|lead|manager|head|director or empty",
  "location": "the city or region named in the JD, LinkedIn style e.g. \\"Wellington, New Zealand\\", or empty",
  "must_haves": ["the 5-10 things a candidate genuinely must have"],
  "nice_to_haves": ["up to 5"],
  "queries": ["3 to 6 LinkedIn people-search queries"]
}

Rules for "queries" — these matter more than anything else:
- TWO OR THREE PLAIN KEYWORDS each. LinkedIn's basic people search returns NOTHING for long quoted boolean strings. "Network Operations Manager" is good. "(\\"A\\" OR \\"B\\") AND \\"C\\"" returns zero.
- Each query is a DIFFERENT ANGLE, not a rewording: the exact title; the alternative titles people in this market actually put on their profile; a title plus one distinctive skill from the JD.
- NEVER put the location in a query. The location filter handles that separately.
- Order them best-first: the query most likely to find the right people goes first.

Be concrete and NZ-aware. If the JD is for an "Observability & Networks Manager", good queries are
["Network Operations Manager", "Observability Manager", "Infrastructure Manager AIOps", "Site Reliability Manager"].`;

/**
 * @param {{apiKey: string, jd: string}} args
 * @returns {Promise<{title,seniority,location,must_haves,nice_to_haves,queries}>}
 */
export async function planHunt({ apiKey, jd }) {
  const plan = await chatJson$({
    apiKey,
    system: PLAN_SYSTEM,
    user: `Job description and instruction:\n\n${jd.slice(0, 24000)}`,
  });

  const queries = (Array.isArray(plan.queries) ? plan.queries : [])
    .map((q) => String(q || "").replace(/["()]/g, " ").replace(/\s+/g, " ").trim())
    // Guard the rule the model most often breaks: long queries find nobody.
    .filter((q) => q && q.split(" ").length <= 5)
    .slice(0, 6);

  return {
    title: String(plan.title || "").trim(),
    seniority: String(plan.seniority || "").trim(),
    location: String(plan.location || "").trim(),
    must_haves: (Array.isArray(plan.must_haves) ? plan.must_haves : []).map(String).slice(0, 12),
    nice_to_haves: (Array.isArray(plan.nice_to_haves) ? plan.nice_to_haves : []).map(String).slice(0, 6),
    queries: queries.length ? queries : [String(plan.title || "").trim()].filter(Boolean),
  };
}
