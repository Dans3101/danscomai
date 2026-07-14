
-- profiles
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own profile select" ON public.profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "own profile insert" ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "own profile update" ON public.profiles FOR UPDATE USING (auth.uid() = id);

-- auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)))
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- generic updated_at
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER profiles_set_updated_at BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- mt5_accounts
CREATE TABLE public.mt5_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label text NOT NULL,
  broker text NOT NULL,
  login text NOT NULL,
  server text NOT NULL,
  password_ciphertext text NOT NULL,
  bridge_url text,
  bridge_token text,
  is_active boolean NOT NULL DEFAULT true,
  connection_status text NOT NULL DEFAULT 'disconnected',
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mt5_accounts TO authenticated;
GRANT ALL ON public.mt5_accounts TO service_role;
ALTER TABLE public.mt5_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own mt5_accounts" ON public.mt5_accounts FOR ALL
USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER mt5_accounts_set_updated_at BEFORE UPDATE ON public.mt5_accounts
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE INDEX ON public.mt5_accounts(user_id);

-- strategies
CREATE TABLE public.strategies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.mt5_accounts(id) ON DELETE CASCADE,
  name text NOT NULL,
  symbol text NOT NULL,
  timeframe text NOT NULL DEFAULT 'M15',
  rule_type text NOT NULL,
  rule_params jsonb NOT NULL DEFAULT '{}'::jsonb,
  lot_size numeric NOT NULL DEFAULT 0.01,
  stop_loss_pips numeric,
  take_profit_pips numeric,
  trailing_stop_pips numeric,
  max_daily_loss numeric,
  max_open_trades integer NOT NULL DEFAULT 1,
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.strategies TO authenticated;
GRANT ALL ON public.strategies TO service_role;
ALTER TABLE public.strategies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own strategies" ON public.strategies FOR ALL
USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER strategies_set_updated_at BEFORE UPDATE ON public.strategies
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE INDEX ON public.strategies(account_id);

-- account_snapshots
CREATE TABLE public.account_snapshots (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.mt5_accounts(id) ON DELETE CASCADE,
  balance numeric,
  equity numeric,
  margin numeric,
  free_margin numeric,
  margin_level numeric,
  profit numeric,
  currency text,
  captured_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.account_snapshots TO authenticated;
GRANT ALL ON public.account_snapshots TO service_role;
ALTER TABLE public.account_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own snapshots" ON public.account_snapshots FOR ALL
USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX ON public.account_snapshots(account_id, captured_at DESC);

-- positions (open)
CREATE TABLE public.positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.mt5_accounts(id) ON DELETE CASCADE,
  ticket bigint NOT NULL,
  symbol text NOT NULL,
  side text NOT NULL,
  volume numeric NOT NULL,
  open_price numeric,
  current_price numeric,
  stop_loss numeric,
  take_profit numeric,
  swap numeric,
  profit numeric,
  opened_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, ticket)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.positions TO authenticated;
GRANT ALL ON public.positions TO service_role;
ALTER TABLE public.positions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own positions" ON public.positions FOR ALL
USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX ON public.positions(account_id);

-- pending orders
CREATE TABLE public.pending_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.mt5_accounts(id) ON DELETE CASCADE,
  ticket bigint NOT NULL,
  symbol text NOT NULL,
  type text NOT NULL,
  volume numeric NOT NULL,
  price numeric,
  stop_loss numeric,
  take_profit numeric,
  placed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, ticket)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pending_orders TO authenticated;
GRANT ALL ON public.pending_orders TO service_role;
ALTER TABLE public.pending_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own pending_orders" ON public.pending_orders FOR ALL
USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX ON public.pending_orders(account_id);

-- trade history
CREATE TABLE public.trade_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.mt5_accounts(id) ON DELETE CASCADE,
  ticket bigint NOT NULL,
  symbol text NOT NULL,
  side text NOT NULL,
  volume numeric NOT NULL,
  open_price numeric,
  close_price numeric,
  profit numeric,
  swap numeric,
  commission numeric,
  opened_at timestamptz,
  closed_at timestamptz,
  strategy_id uuid REFERENCES public.strategies(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, ticket)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.trade_history TO authenticated;
GRANT ALL ON public.trade_history TO service_role;
ALTER TABLE public.trade_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own trade_history" ON public.trade_history FOR ALL
USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX ON public.trade_history(account_id, closed_at DESC);

-- activity logs
CREATE TABLE public.activity_logs (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id uuid REFERENCES public.mt5_accounts(id) ON DELETE CASCADE,
  level text NOT NULL DEFAULT 'info',
  source text NOT NULL DEFAULT 'system',
  message text NOT NULL,
  data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.activity_logs TO authenticated;
GRANT ALL ON public.activity_logs TO service_role;
ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own activity_logs" ON public.activity_logs FOR ALL
USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX ON public.activity_logs(user_id, created_at DESC);

-- bridge commands (queue)
CREATE TABLE public.bridge_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.mt5_accounts(id) ON DELETE CASCADE,
  command text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bridge_commands TO authenticated;
GRANT ALL ON public.bridge_commands TO service_role;
ALTER TABLE public.bridge_commands ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own bridge_commands" ON public.bridge_commands FOR ALL
USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX ON public.bridge_commands(account_id, status, created_at);

-- realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.mt5_accounts;
ALTER PUBLICATION supabase_realtime ADD TABLE public.account_snapshots;
ALTER PUBLICATION supabase_realtime ADD TABLE public.positions;
ALTER PUBLICATION supabase_realtime ADD TABLE public.pending_orders;
ALTER PUBLICATION supabase_realtime ADD TABLE public.trade_history;
ALTER PUBLICATION supabase_realtime ADD TABLE public.activity_logs;
ALTER PUBLICATION supabase_realtime ADD TABLE public.bridge_commands;
