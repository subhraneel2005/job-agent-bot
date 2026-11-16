export type RawOpportunity = {
  company: string;
  role?: string;
  url: string;
  source: string;
  stage?: string;
  fundingEvent?: string;
  fundingDate?: string;
  launchDate?: string;
  hiring?: boolean;
  why?: string;
  raw?: unknown;
  signalDate?: string;
  location?: string;
  tags?: string[];
};

export type SearchProfile = {
  keywords: string[];
  roles: string[];
  skills: string[];
  locations: string[];
  remote: boolean | null;
  seniority: string | null;
  stage: string | null;
  industries: string[];
  exclude: string[];
  summary: string;
};

export type AdapterContext = {
  chatId: number;
  profile: SearchProfile;
  limit: number;
  freshnessDays: number;
};

export type SourceAdapter = {
  name: string;
  label: string;
  discover(ctx: AdapterContext): Promise<RawOpportunity[]>;
};

export type DiscoverySourceResult = {
  name: string;
  label: string;
  count: number;
  error?: string;
  skipped?: boolean;
};
