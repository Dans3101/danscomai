-- Live market prices streamed by the bridge
CREATE TABLE public.market_ticks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.mt5_accounts(id) ON DELETE CASCADE,
  symbol text NOT NULL,
  bid numeric,
  ask numeric,
  spread_points numeric,
  digits integer,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, symbol)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.market_ticks TO authenticated;
GRANT ALL ON public.market_ticks TO service_role;

ALTER TABLE public.market_ticks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own market_ticks" ON public.market_ticks
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

ALTER TABLE public.market_ticks REPLICA IDENTITY FULL;

-- Capital management controls per strategy
ALTER TABLE public.strategies
  ADD COLUMN IF NOT EXISTS use_risk_sizing boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS risk_percent numeric NOT NULL DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS max_lot numeric NOT NULL DEFAULT 0.10,
  ADD COLUMN IF NOT EXISTS min_equity numeric NOT NULL DEFAULT 5.0,
  ADD COLUMN IF NOT EXISTS daily_loss_percent numeric NOT NULL DEFAULT 5.0,
  ADD COLUMN IF NOT EXISTS max_margin_percent numeric NOT NULL DEFAULT 20.0;