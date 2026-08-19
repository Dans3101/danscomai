// Server-only Capital.com REST client.
// Docs: https://open-api.capital.com/
// Demo and Live are strictly separated by base URL — a session created for one
// environment can never be used against the other.

export type CapitalEnv = "demo" | "live";

export const CAPITAL_BASE: Record<CapitalEnv, string> = {
  demo: "https://demo-api-capital.backend-capital.com",
  live: "https://api-capital.backend-capital.com",
};

export type CapitalSession = {
  env: CapitalEnv;
  base: string;
  cst: string;
  securityToken: string;
  accountId: string | null;
  currency: string | null;
};

export class CapitalError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}

function baseFor(env: CapitalEnv): string {
  const base = CAPITAL_BASE[env];
  if (!base) throw new CapitalError(`Unknown Capital.com environment: ${env}`);
  return base;
}

/** Authenticate and obtain CST + X-SECURITY-TOKEN automatically. */
export async function createSession(
  env: CapitalEnv,
  identifier: string,
  apiKey: string,
  apiPassword: string,
): Promise<CapitalSession> {
  const base = baseFor(env);
  const res = await fetch(`${base}/api/v1/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CAP-API-KEY": apiKey },
    body: JSON.stringify({ identifier, password: apiPassword, encryptedPassword: false }),
  });

  const text = await res.text();
  if (!res.ok) {
    let reason = `HTTP ${res.status}`;
    try {
      const j = JSON.parse(text) as { errorCode?: string };
      if (j.errorCode) reason = j.errorCode;
    } catch {
      /* keep HTTP status */
    }
    throw new CapitalError(`Capital.com authentication failed (${reason})`, res.status);
  }

  const cst = res.headers.get("CST") ?? "";
  const securityToken = res.headers.get("X-SECURITY-TOKEN") ?? "";
  if (!cst || !securityToken) {
    throw new CapitalError("Capital.com did not return session tokens");
  }

  const body = (text ? JSON.parse(text) : {}) as {
    currentAccountId?: string;
    accountId?: string;
    currencyIsoCode?: string;
  };

  return {
    env,
    base,
    cst,
    securityToken,
    accountId: body.currentAccountId ?? body.accountId ?? null,
    currency: body.currencyIsoCode ?? null,
  };
}

async function call<T>(
  s: CapitalSession,
  path: string,
  init?: { method?: string; body?: unknown; query?: Record<string, string | number | undefined> },
): Promise<T> {
  const url = new URL(`${s.base}${path}`);
  for (const [k, v] of Object.entries(init?.query ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      CST: s.cst,
      "X-SECURITY-TOKEN": s.securityToken,
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  if (!res.ok) {
    let reason = `HTTP ${res.status}`;
    try {
      const j = JSON.parse(text) as { errorCode?: string };
      if (j.errorCode) reason = j.errorCode;
    } catch {
      /* keep HTTP status */
    }
    throw new CapitalError(`Capital.com ${path} failed (${reason})`, res.status);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export type CapitalAccount = {
  accountId: string;
  accountName: string;
  currency: string;
  balance: number | null;
  available: number | null;
  deposit: number | null;
  profitLoss: number | null;
  preferred: boolean;
};

export async function listAccounts(s: CapitalSession): Promise<CapitalAccount[]> {
  const data = await call<{
    accounts?: Array<{
      accountId: string;
      accountName: string;
      currency: string;
      preferred?: boolean;
      balance?: { balance?: number; available?: number; deposit?: number; profitLoss?: number };
    }>;
  }>(s, "/api/v1/accounts");
  return (data.accounts ?? []).map((a) => ({
    accountId: a.accountId,
    accountName: a.accountName,
    currency: a.currency,
    balance: a.balance?.balance ?? null,
    available: a.balance?.available ?? null,
    deposit: a.balance?.deposit ?? null,
    profitLoss: a.balance?.profitLoss ?? null,
    preferred: Boolean(a.preferred),
  }));
}

export type CapitalMarket = {
  epic: string;
  instrumentName: string;
  instrumentType: string;
  marketStatus: string;
  bid: number | null;
  offer: number | null;
};

export async function searchMarkets(s: CapitalSession, term: string): Promise<CapitalMarket[]> {
  const data = await call<{
    markets?: Array<{
      epic: string;
      instrumentName: string;
      instrumentType: string;
      marketStatus: string;
      bid?: number;
      offer?: number;
    }>;
  }>(s, "/api/v1/markets", { query: { searchTerm: term } });
  return (data.markets ?? []).map((m) => ({
    epic: m.epic,
    instrumentName: m.instrumentName,
    instrumentType: m.instrumentType,
    marketStatus: m.marketStatus,
    bid: m.bid ?? null,
    offer: m.offer ?? null,
  }));
}

/**
 * Discover the tradable GOLD instrument for this account. The epic is never
 * hard-coded — we search Capital.com and rank the candidates.
 */
export async function discoverGold(s: CapitalSession): Promise<CapitalMarket | null> {
  const seen = new Map<string, CapitalMarket>();
  for (const term of ["GOLD", "XAUUSD", "XAU/USD", "Gold Spot"]) {
    let found: CapitalMarket[] = [];
    try {
      found = await searchMarkets(s, term);
    } catch {
      continue;
    }
    for (const m of found) if (!seen.has(m.epic)) seen.set(m.epic, m);
  }

  const score = (m: CapitalMarket) => {
    const name = `${m.instrumentName} ${m.epic}`.toUpperCase();
    let pts = 0;
    if (m.epic.toUpperCase() === "GOLD") pts += 100;
    if (/^XAUUSD/.test(m.epic.toUpperCase())) pts += 90;
    if (name.includes("GOLD") || name.includes("XAU")) pts += 40;
    if (name.includes("USD")) pts += 10;
    if (m.instrumentType?.toUpperCase() === "COMMODITIES") pts += 15;
    if (/MINI|MICRO|OPTION|FUTURE|BASKET|MINER|SILVER|ETF/.test(name)) pts -= 60;
    if (m.marketStatus === "TRADEABLE") pts += 25;
    return pts;
  };

  const ranked = [...seen.values()].sort((a, b) => score(b) - score(a));
  return ranked[0] ?? null;
}

export type MarketDetails = {
  epic: string;
  instrumentName: string;
  marketStatus: string;
  bid: number | null;
  offer: number | null;
  minDealSize: number | null;
  currency: string | null;
};

export async function marketDetails(s: CapitalSession, epic: string): Promise<MarketDetails> {
  const d = await call<{
    instrument?: { epic?: string; name?: string; currency?: string };
    dealingRules?: { minDealSize?: { value?: number } };
    snapshot?: { bid?: number; offer?: number; marketStatus?: string };
  }>(s, `/api/v1/markets/${encodeURIComponent(epic)}`);
  return {
    epic: d.instrument?.epic ?? epic,
    instrumentName: d.instrument?.name ?? epic,
    marketStatus: d.snapshot?.marketStatus ?? "UNKNOWN",
    bid: d.snapshot?.bid ?? null,
    offer: d.snapshot?.offer ?? null,
    minDealSize: d.dealingRules?.minDealSize?.value ?? null,
    currency: d.instrument?.currency ?? null,
  };
}

export type Candle = {
  time: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
};

/** resolution: MINUTE, MINUTE_5, MINUTE_15, MINUTE_30, HOUR, HOUR_4, DAY, WEEK */
export async function candles(
  s: CapitalSession,
  epic: string,
  resolution = "MINUTE_15",
  max = 100,
): Promise<Candle[]> {
  type P = { bid?: number; ask?: number };
  const d = await call<{
    prices?: Array<{
      snapshotTimeUTC?: string;
      snapshotTime?: string;
      openPrice?: P;
      highPrice?: P;
      lowPrice?: P;
      closePrice?: P;
    }>;
  }>(s, `/api/v1/prices/${encodeURIComponent(epic)}`, { query: { resolution, max } });
  const mid = (p?: P) =>
    p?.bid != null && p?.ask != null ? (p.bid + p.ask) / 2 : (p?.bid ?? p?.ask ?? null);
  return (d.prices ?? []).map((p) => ({
    time: p.snapshotTimeUTC ?? p.snapshotTime ?? "",
    open: mid(p.openPrice),
    high: mid(p.highPrice),
    low: mid(p.lowPrice),
    close: mid(p.closePrice),
  }));
}

export type CapitalPosition = {
  dealId: string;
  epic: string;
  instrumentName: string;
  direction: "BUY" | "SELL";
  size: number;
  level: number | null;
  stopLevel: number | null;
  profitLevel: number | null;
  upl: number | null;
  currency: string | null;
  createdAt: string | null;
};

export async function listPositions(s: CapitalSession): Promise<CapitalPosition[]> {
  const d = await call<{
    positions?: Array<{
      position?: {
        dealId?: string;
        direction?: string;
        size?: number;
        level?: number;
        stopLevel?: number;
        profitLevel?: number;
        upl?: number;
        currency?: string;
        createdDateUTC?: string;
      };
      market?: { epic?: string; instrumentName?: string };
    }>;
  }>(s, "/api/v1/positions");
  return (d.positions ?? []).map((p) => ({
    dealId: p.position?.dealId ?? "",
    epic: p.market?.epic ?? "",
    instrumentName: p.market?.instrumentName ?? p.market?.epic ?? "",
    direction: (p.position?.direction === "SELL" ? "SELL" : "BUY") as "BUY" | "SELL",
    size: p.position?.size ?? 0,
    level: p.position?.level ?? null,
    stopLevel: p.position?.stopLevel ?? null,
    profitLevel: p.position?.profitLevel ?? null,
    upl: p.position?.upl ?? null,
    currency: p.position?.currency ?? null,
    createdAt: p.position?.createdDateUTC ?? null,
  }));
}

export type DealResult = { dealReference: string; status: string | null; reason: string | null };

export async function openPosition(
  s: CapitalSession,
  input: {
    epic: string;
    direction: "BUY" | "SELL";
    size: number;
    stopLevel?: number | null;
    profitLevel?: number | null;
  },
): Promise<DealResult> {
  const body: Record<string, unknown> = {
    epic: input.epic,
    direction: input.direction,
    size: input.size,
    guaranteedStop: false,
  };
  if (input.stopLevel != null) body["stopLevel"] = input.stopLevel;
  if (input.profitLevel != null) body["profitLevel"] = input.profitLevel;

  const d = await call<{ dealReference?: string }>(s, "/api/v1/positions", {
    method: "POST",
    body,
  });
  const ref = d.dealReference ?? "";
  const confirm = ref ? await confirmDeal(s, ref) : null;
  return { dealReference: ref, status: confirm?.dealStatus ?? null, reason: confirm?.reason ?? null };
}

export async function confirmDeal(
  s: CapitalSession,
  dealReference: string,
): Promise<{ dealStatus?: string; reason?: string } | null> {
  try {
    return await call<{ dealStatus?: string; reason?: string }>(
      s,
      `/api/v1/confirms/${encodeURIComponent(dealReference)}`,
    );
  } catch {
    return null;
  }
}

export async function closePosition(s: CapitalSession, dealId: string): Promise<DealResult> {
  const d = await call<{ dealReference?: string }>(
    s,
    `/api/v1/positions/${encodeURIComponent(dealId)}`,
    { method: "DELETE" },
  );
  const ref = d.dealReference ?? "";
  const confirm = ref ? await confirmDeal(s, ref) : null;
  return { dealReference: ref, status: confirm?.dealStatus ?? null, reason: confirm?.reason ?? null };
}

export async function updatePosition(
  s: CapitalSession,
  dealId: string,
  patch: { stopLevel?: number | null; profitLevel?: number | null },
): Promise<DealResult> {
  const d = await call<{ dealReference?: string }>(
    s,
    `/api/v1/positions/${encodeURIComponent(dealId)}`,
    { method: "PUT", body: patch },
  );
  return { dealReference: d.dealReference ?? "", status: null, reason: null };
}

export type CapitalActivity = {
  date: string | null;
  epic: string | null;
  type: string | null;
  status: string | null;
  dealId: string | null;
  size: number | null;
  level: number | null;
};

export async function tradeHistory(s: CapitalSession, days = 14): Promise<CapitalActivity[]> {
  const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19);
  const d = await call<{
    activities?: Array<{
      date?: string;
      epic?: string;
      type?: string;
      status?: string;
      dealId?: string;
      details?: { size?: number; level?: number };
    }>;
  }>(s, "/api/v1/history/activity", { query: { from, detailed: "true" } });
  return (d.activities ?? []).map((a) => ({
    date: a.date ?? null,
    epic: a.epic ?? null,
    type: a.type ?? null,
    status: a.status ?? null,
    dealId: a.dealId ?? null,
    size: a.details?.size ?? null,
    level: a.details?.level ?? null,
  }));
}