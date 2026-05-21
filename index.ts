/**
 * Job Scout - Get notified when companies you care about post new jobs
 *
 * Self-hosted version. Runs on Node.js, scheduled via system cron.
 * See README.md for setup instructions.
 */

import "dotenv/config";
import { initDb, isJobKnown, saveJob, deactivateStaleJobs } from "./db";
import { fetchGreenhouseJobs } from "./scrapers/greenhouse";
import { fetchLeverJobs } from "./scrapers/lever";
import { fetchAshbyJobs } from "./scrapers/ashby";
import { fetchBreezyJobs } from "./scrapers/breezy";
import { fetchBambooJobs } from "./scrapers/bamboohr";
import { fetchRipplingJobs } from "./scrapers/rippling";
import { fetchWorkdayJobs } from "./scrapers/workday";

// ============================================================
// CONFIGURATION - Edit this section!
// ============================================================

export const COMPANIES: CompanyConfig[] = [
  // Greenhouse
  { name: "AKKO",          ats: "greenhouse", slug: "akko" },
  { name: "BuildOps",      ats: "greenhouse", slug: "buildops" },
  { name: "Chowbus",       ats: "greenhouse", slug: "chowbus" },
  { name: "Moment Energy", ats: "greenhouse", slug: "momentenergy" },
  { name: "Noyo",          ats: "greenhouse", slug: "noyocareers" },
  { name: "Papaya",        ats: "greenhouse", slug: "papaya" },
  { name: "Sunbound",      ats: "greenhouse", slug: "sunbound" },

  // Lever
  { name: "Field AI",      ats: "lever", slug: "field-ai" },
  { name: "Grid",          ats: "lever", slug: "Grid" },
  { name: "Ivo",           ats: "lever", slug: "ivo" },

  // Ashby
  { name: "Ajax",           ats: "ashby", slug: "ajax" },
  { name: "Allocate",       ats: "ashby", slug: "allocate" },
  { name: "Apiphany",       ats: "ashby", slug: "apiphany" },
  { name: "Artemis",        ats: "ashby", slug: "artemisanalytics" },
  { name: "Atticus",        ats: "ashby", slug: "atticus" },
  { name: "Beeble",         ats: "ashby", slug: "beeble" },
  { name: "Clarify",        ats: "ashby", slug: "clarify" },
  { name: "Coverbase",      ats: "ashby", slug: "coverbase" },
  { name: "Dispatch",       ats: "ashby", slug: "dispatch" },
  { name: "First Resonance", ats: "ashby", slug: "first-resonance" },
  { name: "Inspectiv",      ats: "ashby", slug: "inspectiv" },
  { name: "Payabli",        ats: "ashby", slug: "payabli" },
  { name: "Sift",           ats: "ashby", slug: "siftstack" },
  { name: "Siro",           ats: "ashby", slug: "siro" },

  // Breezy HR
  { name: "Accorded",      ats: "breezy", slug: "accorded" },
  { name: "PathSpot",      ats: "breezy", slug: "pathspot" },
  { name: "Upwards",       ats: "breezy", slug: "upwardsdotcom" },

  // BambooHR
  { name: "Elementary",    ats: "bamboohr", slug: "elementary" },

  // Rippling
  { name: "Bowery Valuation", ats: "rippling", slug: "bowery-valuation" },
  { name: "SubBase",          ats: "rippling", slug: "subbase" },
];

// Optional: Filter jobs by keywords (leave empty arrays to get all jobs)
export const FILTERS = {
  keywords: [] as string[],   // e.g. ["engineer", "product"]
  exclude: [] as string[],    // e.g. ["intern", "contractor"]
  locations: [] as string[],  // e.g. ["San Francisco", "Remote"]
};

// ============================================================
// TYPES
// ============================================================

export interface CompanyConfig {
  name: string;
  ats: "greenhouse" | "lever" | "ashby" | "breezy" | "bamboohr" | "rippling" | "workday";
  slug: string;
  workdaySite?: string; // required when ats === "workday"
}

export interface Job {
  id: string;
  company: string;
  title: string;
  location: string;
  url: string;
  department?: string;
  postedAt?: string;
  salary?: string;
}

// ============================================================
// NOTIFICATIONS
// ============================================================

function formatSlackMessage(job: Job): string {
  return [
    `🆕 *New Job Posted*`,
    ``,
    `*Company:* ${job.company}`,
    `*Role:* ${job.title}`,
    `*Location:* ${job.location || "Not specified"}`,
    job.department ? `*Department:* ${job.department}` : null,
    `*Link:* ${job.url}`,
  ].filter(Boolean).join("\n");
}

async function sendSlackNotification(job: Job): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log("  [no webhook] Would notify:", job.title, "@", job.company);
    return;
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: formatSlackMessage(job) },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "View Job" },
              url: job.url,
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Slack error: ${response.status} ${response.statusText}`);
  }
}

// ============================================================
// FILTERING
// ============================================================

function matchesFilters(job: Job): boolean {
  const title = job.title.toLowerCase();
  const location = (job.location || "").toLowerCase();

  if (FILTERS.exclude.length > 0) {
    if (FILTERS.exclude.some((kw) => title.includes(kw.toLowerCase()))) {
      return false;
    }
  }

  if (FILTERS.keywords.length > 0) {
    if (!FILTERS.keywords.some((kw) => title.includes(kw.toLowerCase()))) {
      return false;
    }
  }

  if (FILTERS.locations.length > 0) {
    if (!FILTERS.locations.some((loc) => location.includes(loc.toLowerCase()))) {
      return false;
    }
  }

  return true;
}

// ============================================================
// SCRAPER LOGIC
// ============================================================

const SCRAPERS = {
  greenhouse: fetchGreenhouseJobs,
  lever: fetchLeverJobs,
  ashby: fetchAshbyJobs,
  breezy: fetchBreezyJobs,
  bamboohr: fetchBambooJobs,
  rippling: fetchRipplingJobs,
  workday: fetchWorkdayJobs,
};

async function scrapeCompany(company: CompanyConfig): Promise<Job[]> {
  const scraper = SCRAPERS[company.ats];
  if (!scraper) {
    console.error(`  No scraper for ATS: ${company.ats}`);
    return [];
  }
  try {
    const jobs = await scraper(company);
    console.log(`  ${company.name}: ${jobs.length} jobs found`);
    return jobs;
  } catch (error) {
    console.error(`  Error scraping ${company.name}:`, error);
    return [];
  }
}

async function processJobs(jobs: Job[]): Promise<number> {
  let newCount = 0;
  for (const job of jobs) {
    if (!matchesFilters(job)) continue;
    const isNew = !(await isJobKnown(job.id));
    await saveJob(job); // always upsert to keep salary/last_seen current

    if (isNew) {
      await sendSlackNotification(job);
      newCount++;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return newCount;
}

// ============================================================
// MAIN
// ============================================================

async function run(): Promise<void> {
  console.log(`\n🔍 Job Scout running at ${new Date().toISOString()}`);
  console.log(`   Tracking ${COMPANIES.length} companies\n`);

  let totalNew = 0;

  for (const company of COMPANIES) {
    const jobs = await scrapeCompany(company);
    const newCount = await processJobs(jobs);
    await deactivateStaleJobs(company.name, jobs.map(j => j.id));
    totalNew += newCount;

    // Delay between companies
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log(`\n✅ Done! ${totalNew} new job(s) found.\n`);
}

// ============================================================
// ENTRY POINT
// ============================================================

initDb().then(() => run()).catch(console.error);
