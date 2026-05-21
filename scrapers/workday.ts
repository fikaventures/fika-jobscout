/**
 * Workday ATS Scraper
 *
 * Workday exposes a consistent (undocumented) JSON API across all tenants.
 * Each company runs its own Workday instance with a unique subdomain and site name.
 *
 * Config fields:
 *   slug        — the full tenant subdomain, e.g. "stripe.wd5"
 *   workdaySite — the career site path segment, e.g. "External_Careers"
 *
 * API endpoint:
 *   POST https://{slug}.myworkdayjobs.com/wday/cxs/{slug-without-wd-suffix}/{workdaySite}/jobs
 *
 * Finding slug + site for a new company:
 *   1. Go to their careers page — if it's on myworkdayjobs.com, grab the subdomain
 *   2. The site name is the path segment after the subdomain in the URL
 *      e.g. https://stripe.wd5.myworkdayjobs.com/en-US/stripe-go → slug=stripe.wd5, site=stripe-go
 *   Note: the .wd{N} suffix is stripped automatically when building the API path
 */

import type { CompanyConfig, Job } from "../index";

interface WorkdayJobPosting {
  title: string;
  externalPath: string;
  locationsText?: string;
  postedOn?: string;
  jobReqId?: string;
}

interface WorkdayResponse {
  jobPostings: WorkdayJobPosting[];
  total: number;
}

const PAGE_SIZE = 20; // Workday rejects requests with limit > 20

export async function fetchWorkdayJobs(company: CompanyConfig): Promise<Job[]> {
  if (!company.workdaySite) {
    console.warn(`Workday scraper: missing workdaySite for ${company.name}`);
    return [];
  }

  const baseUrl = `https://${company.slug}.myworkdayjobs.com`;
  // API path uses the company name without the .wd{N} suffix
  const tenantName = company.slug.replace(/\.wd\d+$/, '');
  const apiUrl = `${baseUrl}/wday/cxs/${tenantName}/${company.workdaySite}/jobs`;

  const allJobs: Job[] = [];
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "JobScout/1.0",
      },
      body: JSON.stringify({
        appliedFacets: {},
        limit: PAGE_SIZE,
        offset,
        searchText: "",
      }),
    });

    if (!response.ok) {
      if (response.status === 404) {
        console.warn(`Workday board not found for ${company.slug}/${company.workdaySite}`);
        return [];
      }
      throw new Error(`Workday API error: ${response.status} for ${company.name}`);
    }

    const data = await response.json() as WorkdayResponse;
    // Workday only returns the correct total on the first page; subsequent pages return 0
    if (offset === 0) total = data.total ?? 0;

    for (const job of data.jobPostings ?? []) {
      allJobs.push({
        id: `workday-${company.slug}-${job.jobReqId || job.externalPath}`,
        company: company.name,
        title: job.title,
        location: job.locationsText || "Not specified",
        url: `${baseUrl}/${company.workdaySite}${job.externalPath}`,
        postedAt: job.postedOn,
      });
    }

    offset += PAGE_SIZE;
    if ((data.jobPostings ?? []).length < PAGE_SIZE) break;
  }

  return allJobs;
}
