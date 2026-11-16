import { listFacts, getProfile } from "../memory/db";
import type { SearchProfile } from "./types";

function strings(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === "string") {
    return value
      .split(/[,;|/]|\band\b/gi)
      .map((s) => s.trim())
      .filter((s) => s.length > 1);
  }
  return [];
}

const ROLE_WORDS = [
  "engineer",
  "developer",
  "designer",
  "product manager",
  "founder",
  "data scientist",
  "marketing",
  "sales",
  "growth",
  "operations",
  "recruiter",
  "analyst",
  "architect",
  "cto",
  "intern",
  "frontend",
  "backend",
  "full stack",
  "fullstack",
  "devops",
  "ml",
  "ai",
];

export function getUserSearchProfile(chatId: number): SearchProfile {
  const profile = getProfile(chatId);
  const facts = listFacts(chatId);

  const roles = new Set<string>([
    ...strings(profile.role),
    ...strings(profile.roles),
    ...strings(profile.title),
  ]);
  const skills = new Set<string>([
    ...strings(profile.skills),
    ...strings(profile.stack),
    ...strings(profile.technologies),
    ...strings(profile.languages),
  ]);
  const locations = new Set<string>([
    ...strings(profile.locations),
    ...strings(profile.location),
    ...strings(profile.cities),
  ]);
  const industries = new Set<string>([
    ...strings(profile.industries),
    ...strings(profile.domains),
  ]);
  const exclude = new Set<string>([
    ...strings(profile.exclude),
    ...strings(profile.dealbreakers),
    ...strings(profile.avoid),
  ]);

  for (const fact of facts) {
    const bucket =
      fact.kind === "skill" || fact.kind === "skills"
        ? skills
        : fact.kind === "role" || fact.kind === "roles"
          ? roles
          : fact.kind === "location"
            ? locations
            : fact.kind === "industry"
              ? industries
              : null;
    if (bucket) for (const value of strings(fact.value)) bucket.add(value);
  }

  const summaryParts = [
    `roles: ${[...roles].join(", ")}`,
    `skills: ${[...skills].join(", ")}`,
    `locations: ${[...locations].join(", ")}`,
    `industries: ${[...industries].join(", ")}`,
  ].filter((p) => !p.endsWith(": "));

  const factText = facts
    .filter((f) => ["preference", "experience", "project", "goal", "constraint"].includes(f.kind))
    .slice(0, 12)
    .map((f) => `${f.kind}/${f.key}: ${f.value}`);

  const keywords = new Set<string>();
  for (const r of roles) keywords.add(r);
  for (const s of skills) keywords.add(s);
  for (const i of industries) keywords.add(i);
  for (const token of ROLE_WORDS) {
    if (summaryParts.join(" ").toLowerCase().includes(token)) keywords.add(token);
  }

  const remoteRaw = profile.remote;
  const remote =
    typeof remoteRaw === "boolean"
      ? remoteRaw
      : typeof remoteRaw === "string"
        ? /remote|anywhere/i.test(remoteRaw)
        : null;

  return {
    keywords: [...keywords].filter((k) => k.length > 1).slice(0, 20),
    roles: [...roles],
    skills: [...skills],
    locations: [...locations],
    remote,
    seniority: typeof profile.seniority === "string" ? profile.seniority : null,
    stage: typeof profile.stage === "string" ? profile.stage : null,
    industries: [...industries],
    exclude: [...exclude],
    summary: [...summaryParts, ...factText].join("\n"),
  };
}

export function queryForProfile(profile: SearchProfile, extra = ""): string {
  const base = profile.keywords.length ? profile.keywords.slice(0, 4).join(" ") : "software engineer";
  return [base, extra].filter(Boolean).join(" ");
}
