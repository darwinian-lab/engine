// Shape of a species' protected species.json. The engine reads it; mutants may not edit it.

export interface EventRule {
  name: string; // fitness event name, e.g. "qr_download"
  method?: string; // GET | POST ... (default any)
  path: string; // regex tested against URL pathname
  query?: string; // optional substring the search string must contain
  status?: number; // required response status class, default 2xx/3xx
  credit?: "visitor" | "header"; // header: credited via x-dw-credit (multi-party products)
}

export interface Stage {
  name: string; // activation | intent | revenue ...
  event: string; // event that counts as a success in this stage
  advanceAt?: number; // weekly successes (species-wide) needed to move to the next stage
}

export interface SpeciesConfig {
  species: string;
  brand: { name: string; domain: string; tagline?: string };
  stages: Stage[];
  events: EventRule[];
  passthrough?: string[]; // path regexes served by the best arm, untracked
  population?: number; // live evolving arms to maintain (default 3)
  controlShare?: number; // share of new visitors pinned to the frozen control (default 0.1)
  protected?: string[]; // files mutants may not touch
}

export function matchEvents(
  cfg: SpeciesConfig,
  method: string,
  url: URL,
  status: number,
): EventRule[] {
  const out: EventRule[] = [];
  for (const r of cfg.events) {
    if (r.credit === "header") continue;
    if (r.method && r.method.toUpperCase() !== method.toUpperCase()) continue;
    if (!new RegExp(r.path).test(url.pathname)) continue;
    if (r.query && !url.search.includes(r.query)) continue;
    const ok = r.status ? status === r.status : status >= 200 && status < 400;
    if (!ok) continue;
    out.push(r);
  }
  return out;
}
