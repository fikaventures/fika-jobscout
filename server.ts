import "dotenv/config";
import express from "express";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import { initDb, queryRows, queryOne } from "./db";
import { COMPANIES } from "./index";
import rateLimit from "express-rate-limit";

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function weeksAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n * 7);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function startOfWeek(offsetWeeks: number): string {
  const d = new Date();
  const day = d.getDay(); // 0 = Sunday
  d.setDate(d.getDate() - day - offsetWeeks * 7);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Dashboard HTML
app.get("/", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "dashboard.html"));
});

// Company name → domain mapping (single source of truth for logos)
app.get("/api/companies/config", (_req, res) => {
  res.json(COMPANIES.map(c => ({ name: c.name, domain: c.domain ?? null })));
});

// Summary stats
app.get("/api/stats", async (_req, res) => {
  try {
    const weekStart = weeksAgo(0);
    const sunday = startOfWeek(0);

    const [total, active, newThisWeek] = await Promise.all([
      queryOne<{ count: number }>(
        "SELECT COUNT(DISTINCT company) as count FROM jobs",
        "SELECT COUNT(DISTINCT company) as count FROM jobs"
      ),
      queryOne<{ count: number }>(
        "SELECT COUNT(*) as count FROM jobs WHERE is_active = 1",
        "SELECT COUNT(*) as count FROM jobs WHERE is_active = 1"
      ),
      queryOne<{ count: number }>(
        "SELECT COUNT(*) as count FROM jobs WHERE first_seen >= ?",
        "SELECT COUNT(*) as count FROM jobs WHERE first_seen >= $1",
        [sunday]
      ),
    ]);

    res.json({
      companies: total?.count ?? 0,
      activeJobs: active?.count ?? 0,
      newThisWeek: newThisWeek?.count ?? 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// All jobs (with optional filters)
// ?all=1 skips date filter and returns all active jobs (used by dashboard client-side filtering)
app.get("/api/jobs", async (req, res) => {
  try {
    const company = req.query.company as string | undefined;
    const fetchAll = req.query.all === "1";
    const days = parseInt(req.query.days as string) || 30;
    const params: unknown[] = [];

    let where = "WHERE is_active = 1";
    if (!fetchAll) {
      where += " AND first_seen >= ?";
      params.push(weeksAgo(days / 7));
    }
    if (company) {
      where += ` AND company = ?`;
      params.push(company);
    }

    let n = 0;
    const pgWhere = where.replace(/\?/g, () => `$${++n}`);
    const sqliteSql = `SELECT * FROM jobs ${where} ORDER BY first_seen DESC LIMIT 2000`;
    const pgSql    = `SELECT * FROM jobs ${pgWhere} ORDER BY first_seen DESC LIMIT 2000`;
    return res.json(await queryRows(sqliteSql, pgSql, params));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Companies with job counts
app.get("/api/companies", async (_req, res) => {
  try {
    const rows = await queryRows<{ company: string; job_count: number; last_posted: string }>(
      "SELECT company, COUNT(*) as job_count, MAX(first_seen) as last_posted FROM jobs GROUP BY company ORDER BY job_count DESC",
      "SELECT company, COUNT(*) as job_count, MAX(first_seen) as last_posted FROM jobs GROUP BY company ORDER BY job_count DESC"
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Jobs for a specific company
app.get("/api/companies/:name/jobs", async (req, res) => {
  try {
    const jobs = await queryRows(
      "SELECT * FROM jobs WHERE company = ? ORDER BY first_seen DESC",
      "SELECT * FROM jobs WHERE company = $1 ORDER BY first_seen DESC",
      [req.params.name]
    );
    res.json(jobs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Weekly trends for the last 8 weeks
app.get("/api/trends", async (_req, res) => {
  try {
    const weeks: { label: string; start: string; end: string }[] = [];
    for (let i = 7; i >= 0; i--) {
      const start = startOfWeek(i);
      const end = startOfWeek(i - 1);
      const date = new Date(start);
      const label = `${date.toLocaleString("default", { month: "short" })} ${date.getDate()}`;
      weeks.push({ label, start, end });
    }

    const results = await Promise.all(
      weeks.map(({ start, end }) =>
        queryOne<{ count: number }>(
          "SELECT COUNT(*) as count FROM jobs WHERE first_seen >= ? AND first_seen < ?",
          "SELECT COUNT(*) as count FROM jobs WHERE first_seen >= $1 AND first_seen < $2",
          [start, end]
        )
      )
    );

    res.json(
      weeks.map((w, i) => ({
        week: w.label,
        count: results[i]?.count ?? 0,
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

const matchRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again in a minute." },
});

// Candidate-to-role matching (POST so LinkedIn paste text can be large)
app.post("/api/match", matchRateLimit, async (req, res) => {
  const { linkedin, context } = req.body as { linkedin?: string; context?: string };
  const profileText = (linkedin || "").trim();
  if (!profileText) {
    return res.status(400).json({ error: "linkedin field is required" });
  }
  if (profileText.length > 12000) {
    return res.status(400).json({ error: "Profile text too long" });
  }
  if ((context?.length ?? 0) > 1000) {
    return res.status(400).json({ error: "Context too long" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: "AI matching is not available" });
  }

  try {
    const jobs = await queryRows<{
      id: string; company: string; title: string;
      location: string; department: string; first_seen: string; url: string;
    }>(
      "SELECT id, company, title, location, department, first_seen, url FROM jobs WHERE is_active = 1 ORDER BY first_seen DESC LIMIT 200",
      "SELECT id, company, title, location, department, first_seen, url FROM jobs WHERE is_active = 1 ORDER BY first_seen DESC LIMIT 200"
    );

    // Use short numeric IDs to minimise token count (full ATS IDs are very long)
    const idMap: Record<number, string> = {};
    const jobsForLlm = jobs.map((j, i) => {
      idMap[i] = j.id;
      const entry: Record<string, unknown> = { id: i, co: j.company, t: j.title };
      if (j.location) entry.loc = j.location;
      if (j.department) entry.dept = j.department;
      return entry;
    });

    const contextSection = context?.trim()
      ? `\n\nAdditional context:\n${context.trim()}`
      : "";

    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      system: `You are a critical, experienced recruiter at a VC firm evaluating candidate-to-role fit. You will receive a LinkedIn profile (ignore nav junk, ads, and page chrome — extract only the professional content) and a list of open roles at portfolio companies.

First, extract from the profile:
- name (if present)
- current role and company
- years of experience (estimate if not explicit)
- primary function (Engineering / Product / Sales / Marketing / Operations / Other)
- seniority level (IC / Manager / Director / VP+)
- location
- key skills or domain expertise (max 5)

Then rank the top 10 roles by MUTUAL fit — meaning this is a good move for the candidate AND a strong hire for the company. Be honest and critical. Most matches should score in the 40–65 range. Reserve 80+ for genuinely compelling fits where the candidate's background maps closely to the role's likely needs. Do not inflate scores to be encouraging.

Scoring guide:
- 85–100: Near-perfect. Function, seniority, domain, and location all align. Obvious intro.
- 70–84: Strong. 3 of 4 dimensions align well, minor gaps.
- 55–69: Decent. Plausible but real gaps — wrong industry, slight seniority mismatch, or partial function overlap.
- 40–54: Stretch. One major misalignment (e.g. function shift, big seniority jump, irrelevant domain).
- Below 40: Weak. Only include if nothing better exists.

Penalize for: function mismatch, overqualification, no relevant domain overlap, location mismatch (if role is not remote), stage mismatch (e.g. Fortune 500 exec at a seed-stage startup).
Reward for: directly relevant domain, right seniority band, demonstrated trajectory toward this type of role, company-stage fit.

For each match return:
- job_id
- match_score (0-100, be critical)
- match_reason (1 tight sentence — name the specific signal that makes this work or not, not just "strong background in X")
- seniority_fit: "strong" | "stretch" | "overqualified"
- function_match: true/false

Respond ONLY with valid JSON in this exact shape:
{"candidate":{"name":"","current_role":"","experience_years":0,"function":"","seniority":"","location":"","skills":[]},"matches":[{"job_id":"","match_score":0,"match_reason":"","seniority_fit":"strong","function_match":true}]}`,
      messages: [{
        role: "user",
        content: `Profile:\n${profileText}${contextSection}\n\nOpen roles:\n${JSON.stringify(jobsForLlm)}`,
      }],
    });

    const raw = message.content[0].type === "text" ? message.content[0].text : "{}";
    // Extract the JSON object robustly — ignore markdown fences and any prose before/after
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const rawText = jsonMatch ? jsonMatch[0] : "{}";

    let parsed: {
      candidate: {
        name: string; current_role: string; experience_years: number;
        function: string; seniority: string; location: string; skills: string[];
      };
      matches: Array<{
        job_id: string; match_score: number; match_reason: string;
        seniority_fit: string; function_match: boolean;
      }>;
    };

    try {
      parsed = JSON.parse(rawText);
    } catch {
      console.error("Failed to parse AI response:", rawText);
      return res.status(500).json({ error: "Failed to parse AI response" });
    }

    // Map short numeric IDs back to real job IDs, then look up job details
    const jobMap = new Map(jobs.map(j => [j.id, j]));
    const now = Date.now();
    const enrichedMatches = (parsed.matches || [])
      .map(m => {
        const realId = idMap[Number(m.job_id)] ?? m.job_id;
        const job = jobMap.get(realId);
        if (!job) return null;
        const daysAgo = Math.floor((now - new Date(job.first_seen).getTime()) / (1000 * 60 * 60 * 24));
        return { ...job, ...m, days_ago: daysAgo };
      })
      .filter(Boolean)
      .sort((a, b) => b!.match_score - a!.match_score);

    res.json({ candidate: parsed.candidate || {}, matches: enrichedMatches });
  } catch (err) {
    console.error("Match error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Job Scout dashboard running at http://localhost:${PORT}`);
  });
}).catch(console.error);
