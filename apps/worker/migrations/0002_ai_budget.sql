-- Daily Workers AI neuron ledger (SPEC 28.5.5). One row per UTC day (the Free allowance resets at 00:00 UTC).
-- Before each call the Worker reserves the call's worst case; after it, the reservation is replaced by the
-- figure from the response's token usage when it reports one. A reservation that would pass
-- AI_DAILY_NEURON_CAP is refused, and the incident gets the template summary (reason daily_neuron_cap).
CREATE TABLE ai_budget (
  day TEXT PRIMARY KEY,
  reserved INTEGER NOT NULL,
  used INTEGER NOT NULL,
  calls INTEGER NOT NULL
);
